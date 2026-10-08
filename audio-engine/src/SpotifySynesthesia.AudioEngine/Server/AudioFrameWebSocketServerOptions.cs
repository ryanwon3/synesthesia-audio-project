namespace SpotifySynesthesia.AudioEngine.Server;

public sealed record AudioFrameWebSocketServerOptions
{
    public AudioFrameWebSocketServerOptions(
        int port = 8765,
        string path = AudioFrameProtocol.DefaultPath,
        string? staticContentPath = null,
        IEnumerable<string>? allowedBrowserOrigins = null,
        NativeDiagnosticPolicy nativeDiagnosticPolicy = NativeDiagnosticPolicy.RequireAuthentication)
    {
        if (port is < 1024 or > 65535)
        {
            throw new ArgumentOutOfRangeException(nameof(port), "Port must be between 1024 and 65535.");
        }

        if (string.IsNullOrWhiteSpace(path) || path[0] != '/' || path.Length > 128)
        {
            throw new ArgumentException("WebSocket path must be an absolute path up to 128 characters.", nameof(path));
        }

        if (!Enum.IsDefined(nativeDiagnosticPolicy))
        {
            throw new ArgumentOutOfRangeException(
                nameof(nativeDiagnosticPolicy),
                nativeDiagnosticPolicy,
                "Native diagnostic policy must be a defined value.");
        }

        Port = port;
        Path = path.TrimEnd('/');
        StaticContentPath = staticContentPath is null ? null : System.IO.Path.GetFullPath(staticContentPath);

        // Trust only the exact bundled origin plus explicitly supplied origins; the policy validates and snapshots them.
        OriginPolicy = new BrowserOriginPolicy([$"http://127.0.0.1:{port}", .. (allowedBrowserOrigins ?? [])]);
        NativeDiagnostics = nativeDiagnosticPolicy;
    }

    public int Port { get; }

    public string Path { get; }

    public string? StaticContentPath { get; }

    public BrowserOriginPolicy OriginPolicy { get; }

    public NativeDiagnosticPolicy NativeDiagnostics { get; }

    public string HttpPrefix => $"http://127.0.0.1:{Port}/";

    public Uri WebSocketUri => new($"ws://127.0.0.1:{Port}{Path}");

    public Uri PairingUri => new($"ws://127.0.0.1:{Port}{CompanionConnectionProtocol.PairingPath}");

    public Uri HealthUri => new($"http://127.0.0.1:{Port}/health");
}

public enum NativeDiagnosticPolicy
{
    RequireAuthentication,
    AllowUnauthenticatedLoopbackDiagnostics,
}
