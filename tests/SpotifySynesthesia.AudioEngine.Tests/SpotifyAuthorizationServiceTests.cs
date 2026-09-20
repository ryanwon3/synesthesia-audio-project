using System.Globalization;
using System.Net;
using System.Text;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class SpotifyAuthorizationServiceTests
{
    [Fact]
    public async Task CompletesPkceAuthorizationAndStoresAuthorizationAge()
    {
        TestAuthorizationStore authorizationStore = new();
        TestBrowserLauncher browser = new();
        using HttpClient httpClient = new(new StubHttpHandler(_ => TokenResponse()));
        using SpotifyAuthorizationService service = CreateService(httpClient, authorizationStore, browser);
        await service.InitializeAsync(TestContext.Current.CancellationToken);
        await service.ConfigureAndAuthorizeAsync("client-id", TestContext.Current.CancellationToken);
        string state = GetQueryValue(Assert.IsType<Uri>(browser.LastUri), "state");

        SpotifyAuthorizationCallbackResult result = await service.HandleCallbackAsync(
            new SpotifyAuthorizationCallback("code", state, Error: null, ErrorDescription: null),
            TestContext.Current.CancellationToken);

        Assert.True(result.Success);
        Assert.Equal(SpotifyAuthenticationStatus.Valid, service.Status);
        Assert.NotNull(authorizationStore.Value);
        Assert.Equal("refresh-secret", authorizationStore.Value.RefreshToken);
        Assert.Equal(Utc("2026-08-12T12:00:00Z"), authorizationStore.Value.AuthorizationGrantedAtUtc);
        Assert.Equal(Utc("2027-02-08T12:00:00Z"), authorizationStore.Value.RefreshCredentialExpiresAtUtc);
    }

    [Fact]
    public async Task RejectsStateMismatchExpiredAndReusedAttempts()
    {
        MutableTimeProvider time = new(Utc("2026-08-12T12:00:00Z"));
        TestBrowserLauncher browser = new();
        using HttpClient httpClient = new(new StubHttpHandler(_ => TokenResponse()));
        using SpotifyAuthorizationService service = CreateService(
            httpClient,
            new TestAuthorizationStore(),
            browser,
            timeProvider: time);
        await service.InitializeAsync(TestContext.Current.CancellationToken);

        await service.ConfigureAndAuthorizeAsync("client-id", TestContext.Current.CancellationToken);
        SpotifyAuthorizationCallbackResult mismatch = await service.HandleCallbackAsync(
            new SpotifyAuthorizationCallback("code", "wrong-state", null, null),
            TestContext.Current.CancellationToken);
        Assert.False(mismatch.Success);

        await service.ConfigureAndAuthorizeAsync(clientId: null, TestContext.Current.CancellationToken);
        string expiredState = GetQueryValue(Assert.IsType<Uri>(browser.LastUri), "state");
        time.Advance(TimeSpan.FromMinutes(6));
        SpotifyAuthorizationCallbackResult expired = await service.HandleCallbackAsync(
            new SpotifyAuthorizationCallback("code", expiredState, null, null),
            TestContext.Current.CancellationToken);
        Assert.False(expired.Success);

        time.Advance(TimeSpan.FromMinutes(-6));
        await service.ConfigureAndAuthorizeAsync(clientId: null, TestContext.Current.CancellationToken);
        string validState = GetQueryValue(Assert.IsType<Uri>(browser.LastUri), "state");
        SpotifyAuthorizationCallback callback = new("code", validState, null, null);
        Assert.True((await service.HandleCallbackAsync(callback, TestContext.Current.CancellationToken)).Success);
        Assert.False((await service.HandleCallbackAsync(callback, TestContext.Current.CancellationToken)).Success);
    }

    [Theory]
    [InlineData(null, null, null)]
    [InlineData(null, "access_denied", "denied")]
    public async Task RejectsMissingCodeAndProviderErrors(string? code, string? error, string? description)
    {
        TestBrowserLauncher browser = new();
        using HttpClient httpClient = new(new StubHttpHandler(_ => TokenResponse()));
        using SpotifyAuthorizationService service = CreateService(httpClient, new TestAuthorizationStore(), browser);
        await service.InitializeAsync(TestContext.Current.CancellationToken);
        await service.ConfigureAndAuthorizeAsync("client-id", TestContext.Current.CancellationToken);
        string state = GetQueryValue(Assert.IsType<Uri>(browser.LastUri), "state");

        SpotifyAuthorizationCallbackResult result = await service.HandleCallbackAsync(
            new SpotifyAuthorizationCallback(code, state, error, description),
            TestContext.Current.CancellationToken);

        Assert.False(result.Success);
        Assert.Equal(SpotifyAuthenticationStatus.Failed, service.Status);
    }

    [Fact]
    public async Task DoesNotLaunchBrowserWhenCallbackPortIsUnavailable()
    {
        TestBrowserLauncher browser = new();
        using HttpClient httpClient = new(new StubHttpHandler(_ => TokenResponse()));
        using SpotifyAuthorizationService service = CreateService(
            httpClient,
            new TestAuthorizationStore(),
            browser,
            callbackAvailable: false);
        await service.InitializeAsync(TestContext.Current.CancellationToken);

        await service.ConfigureAndAuthorizeAsync("client-id", TestContext.Current.CancellationToken);

        Assert.Null(browser.LastUri);
        Assert.Equal(SpotifyAuthenticationStatus.Failed, service.Status);
    }

    [Fact]
    public async Task InvalidGrantClearsAuthorizationAndRequiresReauthorization()
    {
        TestAuthorizationStore store = new()
        {
            Value = new SpotifyStoredAuthorization(
                "expired-refresh",
                Utc("2026-01-01T00:00:00Z"),
                Utc("2026-12-01T00:00:00Z"),
                "user-read-currently-playing"),
        };
        TestSettingsStore settings = new() { Value = new SpotifyClientSettings("client-id") };
        using HttpClient httpClient = new(new StubHttpHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("{\"error\":\"invalid_grant\"}", Encoding.UTF8, "application/json"),
        }));
        using SpotifyAuthorizationService service = new(
            httpClient,
            settings,
            store,
            new TestBrowserLauncher(),
            callbackAvailable: () => true,
            new MutableTimeProvider(Utc("2026-08-12T12:00:00Z")));
        await service.InitializeAsync(TestContext.Current.CancellationToken);

        string? token = await service.GetAccessTokenAsync(
            forceRefresh: true,
            TestContext.Current.CancellationToken);

        Assert.Null(token);
        Assert.Null(store.Value);
        Assert.Equal(SpotifyAuthenticationStatus.ReauthorizationRequired, service.Status);
    }

    private static SpotifyAuthorizationService CreateService(
        HttpClient httpClient,
        TestAuthorizationStore authorizationStore,
        TestBrowserLauncher browser,
        bool callbackAvailable = true,
        TimeProvider? timeProvider = null) => new(
            httpClient,
            new TestSettingsStore(),
            authorizationStore,
            browser,
            () => callbackAvailable,
            timeProvider ?? new MutableTimeProvider(Utc("2026-08-12T12:00:00Z")));

    private static DateTimeOffset Utc(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture);

    private static HttpResponseMessage TokenResponse() => new(HttpStatusCode.OK)
    {
        Content = new StringContent(
            """
            {"access_token":"access-secret","token_type":"Bearer","scope":"user-read-currently-playing","expires_in":3600,"refresh_token":"refresh-secret","refresh_token_expires_in":15552000}
            """,
            Encoding.UTF8,
            "application/json"),
    };

    private static string GetQueryValue(Uri uri, string key)
    {
        foreach (string pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            string[] parts = pair.Split('=', count: 2);
            if (Uri.UnescapeDataString(parts[0]).Equals(key, StringComparison.Ordinal))
            {
                return Uri.UnescapeDataString(parts[1].Replace('+', ' '));
            }
        }

        throw new InvalidOperationException($"Query key '{key}' was not found.");
    }
}

internal sealed class TestSettingsStore : ISpotifySettingsStore
{
    public SpotifyClientSettings? Value { get; set; }

    public Task<SpotifyClientSettings?> LoadAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(Value);

    public Task SaveAsync(SpotifyClientSettings settings, CancellationToken cancellationToken = default)
    {
        Value = settings;
        return Task.CompletedTask;
    }
}

internal sealed class TestAuthorizationStore : ISpotifyAuthorizationStore
{
    public SpotifyStoredAuthorization? Value { get; set; }

    public Task<SpotifyStoredAuthorization?> LoadAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult(Value);

    public Task SaveAsync(
        SpotifyStoredAuthorization authorization,
        CancellationToken cancellationToken = default)
    {
        Value = authorization;
        return Task.CompletedTask;
    }

    public Task ClearAsync(CancellationToken cancellationToken = default)
    {
        Value = null;
        return Task.CompletedTask;
    }
}

internal sealed class TestBrowserLauncher : ISpotifyBrowserLauncher
{
    public Uri? LastUri { get; private set; }

    public void Open(Uri uri) => LastUri = uri;
}

internal sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
{
    private DateTimeOffset _utcNow = utcNow;

    public override DateTimeOffset GetUtcNow() => _utcNow;

    public void Advance(TimeSpan duration) => _utcNow = _utcNow.Add(duration);
}
