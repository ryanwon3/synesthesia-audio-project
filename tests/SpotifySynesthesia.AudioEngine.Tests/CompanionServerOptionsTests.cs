using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class CompanionServerOptionsTests
{
    private const int Port = 9876;
    private const string BundledOrigin = "http://127.0.0.1:9876";
    private static readonly string[] ExplicitOrigins = ["https://app.example", "http://localhost:5173"];

    [Fact]
    public void DefaultOriginIsOnlyBundledAtConfiguredPort()
    {
        AudioFrameWebSocketServerOptions options = new(Port);
        BrowserOriginPolicy policy = options.OriginPolicy;

        Assert.True(policy.IsAllowed(BundledOrigin));
        Assert.False(policy.IsAllowed("http://127.0.0.1:8765"));
        Assert.False(policy.IsAllowed("https://app.example"));
        Assert.False(policy.IsAllowed(null));
        Assert.False(policy.IsAllowed(string.Empty));
        Assert.Equal(NativeDiagnosticPolicy.RequireAuthentication, options.NativeDiagnostics);
    }

    [Fact]
    public void AddsExplicitOriginsWithoutWildcardTrust()
    {
        List<string> origins = [.. ExplicitOrigins];
        AudioFrameWebSocketServerOptions options = new(Port, allowedBrowserOrigins: origins);
        BrowserOriginPolicy policy = options.OriginPolicy;

        Assert.True(policy.IsAllowed("https://app.example"));
        Assert.True(policy.IsAllowed("https://APP.Example:443"));
        Assert.True(policy.IsAllowed("http://localhost:5173"));
        Assert.True(policy.IsAllowed(BundledOrigin));
        Assert.False(policy.IsAllowed("https://sub.app.example"));
        Assert.False(policy.IsAllowed("https://app.example.evil.test"));
        Assert.False(policy.IsAllowed("http://app.example"));
        Assert.False(policy.IsAllowed("http://localhost:5174"));

        origins.Remove("https://app.example");
        origins.Add("https://late.example");

        Assert.True(options.OriginPolicy.IsAllowed("https://app.example"));
        Assert.False(options.OriginPolicy.IsAllowed("https://late.example"));
    }

    [Theory]
    [InlineData("https://app.example/path")]
    [InlineData("https://app.example/")]
    [InlineData("http://lan.example")]
    [InlineData("https://*.example")]
    public void InvalidConfiguredOriginFailsConstruction(string origin)
    {
        Assert.ThrowsAny<ArgumentException>(
            () => new AudioFrameWebSocketServerOptions(Port, allowedBrowserOrigins: [origin]));
    }

    [Fact]
    public void UnknownNativeDiagnosticPolicyFailsConstruction()
    {
        ArgumentOutOfRangeException thrown = Assert.Throws<ArgumentOutOfRangeException>(
            () => new AudioFrameWebSocketServerOptions(Port, nativeDiagnosticPolicy: (NativeDiagnosticPolicy)99));

        Assert.Equal("nativeDiagnosticPolicy", thrown.ParamName);
    }

    [Fact]
    public void DiagnosticBypassRequiresExplicitSelection()
    {
        AudioFrameWebSocketServerOptions withOrigins = new(Port, allowedBrowserOrigins: ExplicitOrigins);
        AudioFrameWebSocketServerOptions explicitBypass = new(
            Port,
            nativeDiagnosticPolicy: NativeDiagnosticPolicy.AllowUnauthenticatedLoopbackDiagnostics);

        Assert.Equal(NativeDiagnosticPolicy.RequireAuthentication, withOrigins.NativeDiagnostics);
        Assert.Equal(
            NativeDiagnosticPolicy.AllowUnauthenticatedLoopbackDiagnostics,
            explicitBypass.NativeDiagnostics);
    }
}
