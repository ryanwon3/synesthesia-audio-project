using System.Security.Cryptography;
using System.Text;
using SpotifySynesthesia.AudioEngine.Infrastructure;

namespace SpotifySynesthesia.AudioEngine.OpenAi;

public interface IOpenAiApiKeyStore
{
    Task<string?> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(string apiKey, CancellationToken cancellationToken = default);

    Task ClearAsync(CancellationToken cancellationToken = default);
}

internal sealed class NullOpenAiApiKeyStore : IOpenAiApiKeyStore
{
    public static NullOpenAiApiKeyStore Instance { get; } = new();

    public Task<string?> LoadAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<string?>(null);

    public Task SaveAsync(string apiKey, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;

    public Task ClearAsync(CancellationToken cancellationToken = default) =>
        Task.CompletedTask;
}

public sealed class DpapiOpenAiApiKeyStore : IOpenAiApiKeyStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("SpotifySynesthesia.OpenAiApiKey.v1");
    private readonly string _path;

    public DpapiOpenAiApiKeyStore(string? path = null)
    {
        _path = Path.GetFullPath(path ?? LocalAppPaths.OpenAiApiKeyPath);
    }

    public async Task<string?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_path))
        {
            return null;
        }

        try
        {
            byte[] protectedPayload = await File.ReadAllBytesAsync(_path, cancellationToken).ConfigureAwait(false);
            byte[] payload = ProtectedData.Unprotect(protectedPayload, Entropy, DataProtectionScope.CurrentUser);
            try
            {
                string apiKey = Encoding.UTF8.GetString(payload);
                return OpenAiApiKeyValidator.IsValid(apiKey) ? apiKey : null;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(payload);
            }
        }
        catch (CryptographicException)
        {
            await ClearAsync(cancellationToken).ConfigureAwait(false);
            return null;
        }
    }

    public Task SaveAsync(string apiKey, CancellationToken cancellationToken = default)
    {
        string normalized = OpenAiApiKeyValidator.Normalize(apiKey);
        byte[] payload = Encoding.UTF8.GetBytes(normalized);
        try
        {
            byte[] protectedPayload = ProtectedData.Protect(payload, Entropy, DataProtectionScope.CurrentUser);
            return AtomicFile.WriteAllBytesAsync(_path, protectedPayload, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
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

public static class OpenAiApiKeyValidator
{
    public static bool IsValid(string? apiKey) =>
        apiKey is not null &&
        apiKey.Length is > 0 and <= 512 &&
        !apiKey.Any(char.IsControl) &&
        !apiKey.Any(char.IsWhiteSpace);

    public static string Normalize(string? apiKey)
    {
        string normalized = apiKey?.Trim() ?? string.Empty;
        return IsValid(normalized)
            ? normalized
            : throw new ArgumentException("Enter a valid OpenAI API key.", nameof(apiKey));
    }
}
