using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.Infrastructure;

namespace SpotifySynesthesia.AudioEngine.Spotify;

public interface ISpotifySettingsStore
{
    Task<SpotifyClientSettings?> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(SpotifyClientSettings settings, CancellationToken cancellationToken = default);
}

public interface ISpotifyAuthorizationStore
{
    Task<SpotifyStoredAuthorization?> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(SpotifyStoredAuthorization authorization, CancellationToken cancellationToken = default);

    Task ClearAsync(CancellationToken cancellationToken = default);
}

public sealed class SpotifySettingsStore : ISpotifySettingsStore
{
    private readonly string _path;

    public SpotifySettingsStore(string? path = null)
    {
        _path = Path.GetFullPath(path ?? SpotifyLocalPaths.SettingsPath);
    }

    public async Task<SpotifyClientSettings?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        await using FileStream stream = File.OpenRead(_path);
        return await JsonSerializer.DeserializeAsync<SpotifyClientSettings>(
            stream,
            cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public Task SaveAsync(SpotifyClientSettings settings, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(settings);
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(settings);
        return AtomicFile.WriteAllBytesAsync(_path, payload, cancellationToken);
    }
}

public sealed class DpapiSpotifyAuthorizationStore : ISpotifyAuthorizationStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("SpotifySynesthesia.SpotifyAuthorization.v1");
    private readonly string _path;

    public DpapiSpotifyAuthorizationStore(string? path = null)
    {
        _path = Path.GetFullPath(path ?? SpotifyLocalPaths.AuthorizationPath);
    }

    public async Task<SpotifyStoredAuthorization?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        try
        {
            byte[] protectedPayload = await File.ReadAllBytesAsync(_path, cancellationToken).ConfigureAwait(false);
            byte[] payload = ProtectedData.Unprotect(protectedPayload, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<SpotifyStoredAuthorization>(payload);
        }
        catch (CryptographicException)
        {
            await ClearAsync(cancellationToken).ConfigureAwait(false);
            return null;
        }
        catch (JsonException)
        {
            await ClearAsync(cancellationToken).ConfigureAwait(false);
            return null;
        }
    }

    public Task SaveAsync(
        SpotifyStoredAuthorization authorization,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(authorization);
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(authorization);
        byte[] protectedPayload = ProtectedData.Protect(payload, Entropy, DataProtectionScope.CurrentUser);
        CryptographicOperations.ZeroMemory(payload);
        return AtomicFile.WriteAllBytesAsync(_path, protectedPayload, cancellationToken);
    }

    public Task ClearAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (File.Exists(_path))
        {
            File.Delete(_path);
        }

        return Task.CompletedTask;
    }
}
