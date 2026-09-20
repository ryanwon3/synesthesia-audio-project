using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SpotifySynesthesia.AudioEngine.Spotify;

public interface ISpotifyBrowserLauncher
{
    void Open(Uri uri);
}

public sealed class SystemSpotifyBrowserLauncher : ISpotifyBrowserLauncher
{
    public void Open(Uri uri)
    {
        ArgumentNullException.ThrowIfNull(uri);
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}

public interface ISpotifyAuthorizationService
{
    event Action? StateChanged;

    SpotifyAuthenticationStatus Status { get; }

    string? StatusDetail { get; }

    bool IsConfigured { get; }

    string? ClientId { get; }

    DateTimeOffset? AuthorizationGrantedAtUtc { get; }

    DateTimeOffset? RefreshCredentialExpiresAtUtc { get; }

    Task InitializeAsync(CancellationToken cancellationToken = default);

    Task ConfigureAndAuthorizeAsync(string? clientId, CancellationToken cancellationToken = default);

    Task<string?> GetAccessTokenAsync(bool forceRefresh = false, CancellationToken cancellationToken = default);

    Task<SpotifyAuthorizationCallbackResult> HandleCallbackAsync(
        SpotifyAuthorizationCallback callback,
        CancellationToken cancellationToken = default);
}

public sealed class SpotifyAuthorizationService : ISpotifyAuthorizationService, IDisposable
{
    public static readonly Uri RedirectUri = new("http://127.0.0.1:8765/spotify/callback");
    private const string Scope = "user-read-currently-playing";
    private static readonly Uri AuthorizationEndpoint = new("https://accounts.spotify.com/authorize");
    private static readonly Uri TokenEndpoint = new("https://accounts.spotify.com/api/token");

    private readonly HttpClient _httpClient;
    private readonly ISpotifySettingsStore _settingsStore;
    private readonly ISpotifyAuthorizationStore _authorizationStore;
    private readonly ISpotifyBrowserLauncher _browserLauncher;
    private readonly Func<bool> _callbackAvailable;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private SpotifyClientSettings? _settings;
    private SpotifyStoredAuthorization? _storedAuthorization;
    private SpotifyAccessToken? _accessToken;
    private AuthorizationAttempt? _attempt;
    private bool _disposed;

    public SpotifyAuthorizationService(
        HttpClient httpClient,
        ISpotifySettingsStore settingsStore,
        ISpotifyAuthorizationStore authorizationStore,
        ISpotifyBrowserLauncher browserLauncher,
        Func<bool> callbackAvailable,
        TimeProvider? timeProvider = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _settingsStore = settingsStore ?? throw new ArgumentNullException(nameof(settingsStore));
        _authorizationStore = authorizationStore ?? throw new ArgumentNullException(nameof(authorizationStore));
        _browserLauncher = browserLauncher ?? throw new ArgumentNullException(nameof(browserLauncher));
        _callbackAvailable = callbackAvailable ?? throw new ArgumentNullException(nameof(callbackAvailable));
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public event Action? StateChanged;

    public SpotifyAuthenticationStatus Status { get; private set; } = SpotifyAuthenticationStatus.NotConfigured;

    public string? StatusDetail { get; private set; }

    public bool IsConfigured => _settings is not null;

    public string? ClientId => _settings?.ClientId;

    public DateTimeOffset? AuthorizationGrantedAtUtc => _storedAuthorization?.AuthorizationGrantedAtUtc;

    public DateTimeOffset? RefreshCredentialExpiresAtUtc => _storedAuthorization?.RefreshCredentialExpiresAtUtc;

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _gate.Dispose();
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _settings = await _settingsStore.LoadAsync(cancellationToken).ConfigureAwait(false);
            _storedAuthorization = await _authorizationStore.LoadAsync(cancellationToken).ConfigureAwait(false);
            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (_settings is null)
            {
                SetStatus(SpotifyAuthenticationStatus.NotConfigured, "Enter a Spotify client ID to connect.");
            }
            else if (_storedAuthorization is null)
            {
                SetStatus(SpotifyAuthenticationStatus.AuthorizationRequired, "Spotify authorization is required.");
            }
            else if (_storedAuthorization.RefreshCredentialExpiresAtUtc <= now)
            {
                await ClearAuthorizationCoreAsync(cancellationToken).ConfigureAwait(false);
                SetStatus(SpotifyAuthenticationStatus.ReauthorizationRequired, "Spotify authorization has expired.");
            }
            else
            {
                SetStatus(SpotifyAuthenticationStatus.Valid, "Stored Spotify authorization is available.");
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ConfigureAndAuthorizeAsync(
        string? clientId,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            string? normalizedClientId = string.IsNullOrWhiteSpace(clientId) ? null : clientId.Trim();
            if (normalizedClientId is not null)
            {
                if (normalizedClientId.Length > 256 || normalizedClientId.Any(char.IsWhiteSpace))
                {
                    SetStatus(SpotifyAuthenticationStatus.Failed, "The Spotify client ID is not valid.");
                    return;
                }

                bool changed = !string.Equals(_settings?.ClientId, normalizedClientId, StringComparison.Ordinal);
                _settings = new SpotifyClientSettings(normalizedClientId);
                await _settingsStore.SaveAsync(_settings, cancellationToken).ConfigureAwait(false);
                if (changed)
                {
                    await ClearAuthorizationCoreAsync(cancellationToken).ConfigureAwait(false);
                }
            }

            if (_settings is null)
            {
                SetStatus(SpotifyAuthenticationStatus.NotConfigured, "Enter a Spotify client ID to connect.");
                return;
            }

            if (!_callbackAvailable())
            {
                SetStatus(
                    SpotifyAuthenticationStatus.Failed,
                    "The local Spotify callback is unavailable on 127.0.0.1:8765.");
                return;
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            string verifier = CreateRandomBase64Url(byteCount: 64);
            string state = CreateRandomBase64Url(byteCount: 32);
            _attempt = new AuthorizationAttempt(verifier, state, now.AddMinutes(5));
            SetStatus(SpotifyAuthenticationStatus.Authorizing, "Complete Spotify authorization in your browser.");

            Uri authorizationUri = BuildAuthorizationUri(_settings.ClientId, verifier, state);
            try
            {
                _browserLauncher.Open(authorizationUri);
            }
            catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                _attempt = null;
                SetStatus(SpotifyAuthenticationStatus.Failed, "The Spotify authorization page could not be opened.");
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<string?> GetAccessTokenAsync(
        bool forceRefresh = false,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (!forceRefresh && _accessToken is not null && _accessToken.ExpiresAtUtc > now.AddMinutes(1))
            {
                return _accessToken.Value;
            }

            if (_settings is null || _storedAuthorization is null)
            {
                SetStatus(
                    _settings is null
                        ? SpotifyAuthenticationStatus.NotConfigured
                        : SpotifyAuthenticationStatus.AuthorizationRequired,
                    _settings is null ? "Enter a Spotify client ID to connect." : "Spotify authorization is required.");
                return null;
            }

            if (_storedAuthorization.RefreshCredentialExpiresAtUtc <= now)
            {
                await ClearAuthorizationCoreAsync(cancellationToken).ConfigureAwait(false);
                SetStatus(SpotifyAuthenticationStatus.ReauthorizationRequired, "Spotify authorization has expired.");
                return null;
            }

            TokenExchangeResult refresh = await RefreshAsync(
                _settings.ClientId,
                _storedAuthorization,
                cancellationToken).ConfigureAwait(false);
            if (refresh.InvalidGrant)
            {
                await ClearAuthorizationCoreAsync(cancellationToken).ConfigureAwait(false);
                SetStatus(SpotifyAuthenticationStatus.ReauthorizationRequired, "Spotify reauthorization is required.");
                return null;
            }

            if (refresh.Token is null)
            {
                SetStatus(SpotifyAuthenticationStatus.Valid, "Spotify authorization refresh is temporarily unavailable.");
                return null;
            }

            DateTimeOffset refreshExpiresAtUtc = refresh.Token.RefreshTokenExpiresInSeconds is > 0
                ? DateTimeOffsetExtensions.Min(
                    _storedAuthorization.RefreshCredentialExpiresAtUtc,
                    now.AddSeconds(refresh.Token.RefreshTokenExpiresInSeconds.Value))
                : _storedAuthorization.RefreshCredentialExpiresAtUtc;
            ApplyToken(refresh.Token, _storedAuthorization.AuthorizationGrantedAtUtc, refreshExpiresAtUtc);
            await SaveStoredAuthorizationAsync(refresh.Token, cancellationToken).ConfigureAwait(false);
            SetStatus(SpotifyAuthenticationStatus.Valid, "Spotify authorization is valid.");
            return _accessToken?.Value;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<SpotifyAuthorizationCallbackResult> HandleCallbackAsync(
        SpotifyAuthorizationCallback callback,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(callback);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            AuthorizationAttempt? attempt = _attempt;
            _attempt = null;
            if (attempt is null)
            {
                return RejectCallback("This Spotify authorization attempt is missing or has already been used.");
            }

            if (attempt.ExpiresAtUtc <= _timeProvider.GetUtcNow())
            {
                return RejectCallback("This Spotify authorization attempt has expired.");
            }

            if (string.IsNullOrWhiteSpace(callback.State) ||
                !CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(attempt.State),
                    Encoding.UTF8.GetBytes(callback.State)))
            {
                return RejectCallback("Spotify authorization state validation failed.");
            }

            if (!string.IsNullOrWhiteSpace(callback.Error))
            {
                return RejectCallback("Spotify authorization was not completed.");
            }

            if (string.IsNullOrWhiteSpace(callback.Code) || _settings is null)
            {
                return RejectCallback("Spotify did not return a valid authorization code.");
            }

            TokenExchangeResult exchange;
            try
            {
                exchange = await ExchangeCodeAsync(
                    _settings.ClientId,
                    callback.Code,
                    attempt.Verifier,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is HttpRequestException or JsonException)
            {
                return RejectCallback("Spotify authorization could not be completed.");
            }
            if (exchange.Token is null || string.IsNullOrWhiteSpace(exchange.Token.RefreshToken))
            {
                return RejectCallback("Spotify authorization could not be completed.");
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            DateTimeOffset refreshExpires = exchange.Token.RefreshTokenExpiresInSeconds is > 0
                ? now.AddSeconds(exchange.Token.RefreshTokenExpiresInSeconds.Value)
                : now.AddMonths(6);
            ApplyToken(exchange.Token, now, refreshExpires);
            await SaveStoredAuthorizationAsync(exchange.Token, cancellationToken).ConfigureAwait(false);
            SetStatus(SpotifyAuthenticationStatus.Valid, "Spotify authorization is valid.");
            return new SpotifyAuthorizationCallbackResult(
                Success: true,
                "Spotify is connected. You can close this browser tab.");
        }
        finally
        {
            _gate.Release();
        }
    }

    private SpotifyAuthorizationCallbackResult RejectCallback(string message)
    {
        SetStatus(SpotifyAuthenticationStatus.Failed, message);
        return new SpotifyAuthorizationCallbackResult(Success: false, message);
    }

    private async Task SaveStoredAuthorizationAsync(
        TokenResponse token,
        CancellationToken cancellationToken)
    {
        SpotifyStoredAuthorization prior = _storedAuthorization
            ?? throw new InvalidOperationException("Authorization metadata must be initialized before saving.");
        string refreshToken = string.IsNullOrWhiteSpace(token.RefreshToken)
            ? prior.RefreshToken
            : token.RefreshToken;
        _storedAuthorization = prior with { RefreshToken = refreshToken };
        await _authorizationStore.SaveAsync(_storedAuthorization, cancellationToken).ConfigureAwait(false);
    }

    private void ApplyToken(TokenResponse token, DateTimeOffset grantedAtUtc, DateTimeOffset refreshExpiresAtUtc)
    {
        DateTimeOffset now = _timeProvider.GetUtcNow();
        _accessToken = new SpotifyAccessToken(token.AccessToken, now.AddSeconds(token.ExpiresInSeconds));
        string refreshToken = string.IsNullOrWhiteSpace(token.RefreshToken)
            ? _storedAuthorization?.RefreshToken ?? string.Empty
            : token.RefreshToken;
        _storedAuthorization = new SpotifyStoredAuthorization(
            refreshToken,
            grantedAtUtc,
            refreshExpiresAtUtc,
            string.IsNullOrWhiteSpace(token.Scope) ? Scope : token.Scope);
    }

    private async Task<TokenExchangeResult> ExchangeCodeAsync(
        string clientId,
        string code,
        string verifier,
        CancellationToken cancellationToken)
    {
        Dictionary<string, string> values = new(StringComparer.Ordinal)
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = RedirectUri.AbsoluteUri,
            ["client_id"] = clientId,
            ["code_verifier"] = verifier,
        };
        return await SendTokenRequestAsync(values, cancellationToken).ConfigureAwait(false);
    }

    private async Task<TokenExchangeResult> RefreshAsync(
        string clientId,
        SpotifyStoredAuthorization authorization,
        CancellationToken cancellationToken)
    {
        Dictionary<string, string> values = new(StringComparer.Ordinal)
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = authorization.RefreshToken,
            ["client_id"] = clientId,
        };
        return await SendTokenRequestAsync(values, cancellationToken).ConfigureAwait(false);
    }

    private async Task<TokenExchangeResult> SendTokenRequestAsync(
        IReadOnlyDictionary<string, string> values,
        CancellationToken cancellationToken)
    {
        using FormUrlEncodedContent content = new(values);
        using HttpResponseMessage response = await _httpClient
            .PostAsync(TokenEndpoint, content, cancellationToken)
            .ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.BadRequest)
        {
            TokenError? error = await DeserializeAsync<TokenError>(response, cancellationToken).ConfigureAwait(false);
            return new TokenExchangeResult(Token: null, InvalidGrant: error?.Error == "invalid_grant");
        }

        if (!response.IsSuccessStatusCode)
        {
            return new TokenExchangeResult(Token: null, InvalidGrant: false);
        }

        TokenResponse? token = await DeserializeAsync<TokenResponse>(response, cancellationToken).ConfigureAwait(false);
        return new TokenExchangeResult(token, InvalidGrant: false);
    }

    private static async Task<T?> DeserializeAsync<T>(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        return await JsonSerializer.DeserializeAsync<T>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private async Task ClearAuthorizationCoreAsync(CancellationToken cancellationToken)
    {
        _storedAuthorization = null;
        _accessToken = null;
        _attempt = null;
        await _authorizationStore.ClearAsync(cancellationToken).ConfigureAwait(false);
    }

    private void SetStatus(SpotifyAuthenticationStatus status, string? detail)
    {
        Status = status;
        StatusDetail = detail;
        StateChanged?.Invoke();
    }

    private static Uri BuildAuthorizationUri(string clientId, string verifier, string state)
    {
        byte[] challengeBytes = SHA256.HashData(Encoding.ASCII.GetBytes(verifier));
        string challenge = Base64UrlEncode(challengeBytes);
        string query = string.Join(
            "&",
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["client_id"] = clientId,
                ["response_type"] = "code",
                ["redirect_uri"] = RedirectUri.AbsoluteUri,
                ["code_challenge_method"] = "S256",
                ["code_challenge"] = challenge,
                ["state"] = state,
                ["scope"] = Scope,
            }.Select(pair => $"{WebUtility.UrlEncode(pair.Key)}={WebUtility.UrlEncode(pair.Value)}"));
        return new UriBuilder(AuthorizationEndpoint) { Query = query }.Uri;
    }

    private static string CreateRandomBase64Url(int byteCount) =>
        Base64UrlEncode(RandomNumberGenerator.GetBytes(byteCount));

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record AuthorizationAttempt(string Verifier, string State, DateTimeOffset ExpiresAtUtc);

    private sealed record TokenExchangeResult(TokenResponse? Token, bool InvalidGrant);

    private sealed record TokenResponse(
        [property: JsonPropertyName("access_token")] string AccessToken,
        [property: JsonPropertyName("token_type")] string TokenType,
        [property: JsonPropertyName("scope")] string Scope,
        [property: JsonPropertyName("expires_in")] int ExpiresInSeconds,
        [property: JsonPropertyName("refresh_token")] string? RefreshToken,
        [property: JsonPropertyName("refresh_token_expires_in")] int? RefreshTokenExpiresInSeconds);

    private sealed record TokenError([property: JsonPropertyName("error")] string? Error);
}

internal static class DateTimeOffsetExtensions
{
    public static DateTimeOffset Min(DateTimeOffset left, DateTimeOffset right) => left <= right ? left : right;
}
