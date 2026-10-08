using System.Globalization;
using System.Text;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.Desktop;

// Neutral companion configuration for desktop composition; holds no credentials.
public sealed record CompanionSettings
{
    private const int MaxConfiguredOriginLength = 400;
    private const int DefaultBundledPort = 8765;
    private const int MinBundledPort = 1024;
    private const int MaxBundledPort = 65535;
    private const string HttpsPrefix = "https://";
    private const string DefaultHttpsPortSuffix = ":443";
    private const string BundledPrefix = "http://127.0.0.1:";
    // Exact ordinal opt-in literal; never trimmed or case-folded.
    private const string LegacyEnrichmentOptIn = "true";
    private const string InvalidOriginMessage =
        "The hosted origin must be an exact HTTPS origin without paths, credentials, queries, fragments, or wildcards.";

    public CompanionSettings(string? hostedOrigin = null, bool companionMode = false)
    {
        HostedOrigin = NormalizeHostedOrigin(hostedOrigin);
        CompanionMode = companionMode;
    }

    public string? HostedOrigin { get; }

    public bool CompanionMode { get; }

    // Pure startup factory: only the exact literal "true" opts into legacy enrichment; anything else stays companion.
    public static CompanionSettings FromStartupConfiguration(string? hostedOrigin, string? legacyEnrichment) =>
        new(hostedOrigin, companionMode: !string.Equals(legacyEnrichment, LegacyEnrichmentOptIn, StringComparison.Ordinal));

    // Exact serialized text only; System.Uri is never used so normalization cannot widen trust.
    public static bool IsTrustedBundledSource(string? source, int port = DefaultBundledPort)
    {
        if (source is null ||
            port is < MinBundledPort or > MaxBundledPort ||
            !source.StartsWith(BundledPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        Span<char> digits = stackalloc char[5];
        if (!port.TryFormat(digits, out int written, provider: CultureInfo.InvariantCulture))
        {
            return false;
        }

        ReadOnlySpan<char> rest = source.AsSpan(BundledPrefix.Length);
        if (!rest.StartsWith(digits[..written], StringComparison.Ordinal))
        {
            return false;
        }

        return rest[written..] is "/" or "/index.html";
    }

    private static string? NormalizeHostedOrigin(string? configured)
    {
        if (configured is null)
        {
            return null;
        }

        if (configured.Length > MaxConfiguredOriginLength)
        {
            throw new ArgumentException(InvalidOriginMessage, nameof(configured));
        }

        ReadOnlySpan<char> trimmed = configured.AsSpan().Trim();
        if (trimmed.IsEmpty)
        {
            return null;
        }

        if (trimmed[^1] == '/')
        {
            trimmed = trimmed[..^1];
        }

        if (!trimmed.StartsWith(HttpsPrefix, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(InvalidOriginMessage, nameof(configured));
        }

        string candidate = new(trimmed);
        try
        {
            _ = new BrowserOriginPolicy([candidate]);
        }
        catch (ArgumentException exception)
        {
            throw new ArgumentException(InvalidOriginMessage, nameof(configured), exception);
        }

        // Validated text is ASCII only, so lowering cannot fold non-ASCII lookalikes into a valid host.
        Span<char> lower = stackalloc char[candidate.Length];
        Ascii.ToLower(candidate, lower, out int length);
        ReadOnlySpan<char> canonicalText = lower[..length];
        if (canonicalText.EndsWith(DefaultHttpsPortSuffix, StringComparison.Ordinal))
        {
            canonicalText = canonicalText[..^DefaultHttpsPortSuffix.Length];
        }

        string canonical = new(canonicalText);
        if (!new BrowserOriginPolicy([canonical]).IsAllowed(candidate))
        {
            throw new ArgumentException(InvalidOriginMessage, nameof(configured));
        }

        return canonical;
    }
}
