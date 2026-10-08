using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.Desktop;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class CompanionSettingsTests
{
    private const string Hosted = "https://app.example";

    [Fact]
    public void DefaultsToOfflineBundledMode()
    {
        CompanionSettings settings = new();
        Assert.Null(settings.HostedOrigin);
        Assert.False(settings.CompanionMode);
        Assert.True(new CompanionSettings(companionMode: true).CompanionMode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void TreatsMissingHostedOriginAsUnset(string? configured)
    {
        Assert.Null(new CompanionSettings(configured, companionMode: true).HostedOrigin);
    }

    [Theory]
    [InlineData("https://app.example")]
    [InlineData("https://app.example/")]
    [InlineData("  https://app.example/  ")]
    public void NormalizesExplicitHttpsOrigin(string configured)
    {
        Assert.Equal(Hosted, new CompanionSettings(configured).HostedOrigin);
    }

    [Theory]
    [InlineData("https://app.example:443")]
    [InlineData("https://APP.Example")]
    [InlineData("https://APP.example:443/")]
    public void CanonicalVariantsRemainExactHttpsOrigin(string configured)
    {
        string? origin = new CompanionSettings(configured).HostedOrigin;
        Assert.NotNull(origin);
        Assert.StartsWith("https://", origin, StringComparison.OrdinalIgnoreCase);
        BrowserOriginPolicy policy = new([origin]);
        Assert.True(policy.IsAllowed(Hosted));
        Assert.False(policy.IsAllowed("https://app.example.evil.test"));
        Assert.False(policy.IsAllowed("http://app.example"));
    }

    [Fact]
    public void KeepsExplicitNonDefaultHttpsPort()
    {
        string? origin = new CompanionSettings("https://app.example:8443/").HostedOrigin;
        Assert.NotNull(origin);
        BrowserOriginPolicy policy = new([origin]);
        Assert.True(policy.IsAllowed("https://app.example:8443"));
        Assert.False(policy.IsAllowed(Hosted));
    }

    [Theory]
    [InlineData("https://app.example/path")]
    [InlineData("https://app.example/index.html")]
    [InlineData("https://app.example//")]
    [InlineData("https://user@app.example")]
    [InlineData("https://user:secret@app.example")]
    [InlineData("https://app.example?x=1")]
    [InlineData("https://app.example/?x=1")]
    [InlineData("https://app.example#top")]
    [InlineData("https://app.example/#top")]
    [InlineData("https://*.example")]
    [InlineData("*")]
    [InlineData("http://app.example")]
    [InlineData("http://127.0.0.1:8765")]
    [InlineData("http://localhost:5173")]
    [InlineData("wss://app.example")]
    [InlineData("file:///C:/site")]
    [InlineData("app.example")]
    [InlineData("null")]
    [InlineData("https://")]
    [InlineData("https://app .example")]
    [InlineData("https://app\t.example")]
    [InlineData("https:\\\\app.example")]
    [InlineData("https://app.example\\")]
    [InlineData("https://app%2Eexample")]
    [InlineData("https://app.example/%2F")]
    [InlineData("https://app.example:0")]
    [InlineData("https://app.example:99999")]
    [InlineData("https://app.example.")]
    public void RejectsUnsafeHostedOrigin(string configured)
    {
        Assert.Throws<ArgumentException>(() => new CompanionSettings(configured, companionMode: true));
    }

    [Fact]
    public void TrustsDefaultBundledDocument()
    {
        Assert.True(CompanionSettings.IsTrustedBundledSource("http://127.0.0.1:8765/"));
        Assert.True(CompanionSettings.IsTrustedBundledSource("http://127.0.0.1:8765/index.html"));
    }

    [Theory]
    [InlineData("http://127.0.0.1:8765/", 8765)]
    [InlineData("http://127.0.0.1:8765/index.html", 8765)]
    [InlineData("http://127.0.0.1:1024/", 1024)]
    [InlineData("http://127.0.0.1:65535/index.html", 65535)]
    [InlineData("http://127.0.0.1:9000/", 9000)]
    public void TrustsOnlySerializedBundledSource(string source, int port)
    {
        Assert.True(CompanionSettings.IsTrustedBundledSource(source, port));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("about:blank")]
    [InlineData("http://127.0.0.1:8765")]
    [InlineData(" http://127.0.0.1:8765/")]
    [InlineData("http://127.0.0.1:8765/ ")]
    [InlineData("HTTP://127.0.0.1:8765/")]
    [InlineData("https://127.0.0.1:8765/")]
    [InlineData("http://localhost:8765/")]
    [InlineData("http://[::1]:8765/")]
    [InlineData("http://127.0.0.2:8765/")]
    [InlineData("http://127.0.0.1:8766/")]
    [InlineData("http://127.0.0.1:08765/")]
    [InlineData("http://127.0.0.1/")]
    [InlineData("http://127.0.0.1:8765.evil.test/")]
    [InlineData("http://127.0.0.1.evil.test:8765/")]
    [InlineData("http://user@127.0.0.1:8765/")]
    [InlineData("http://user:secret@127.0.0.1:8765/")]
    [InlineData("http://127.0.0.1:8765/?x=1")]
    [InlineData("http://127.0.0.1:8765/index.html?x=1")]
    [InlineData("http://127.0.0.1:8765/#top")]
    [InlineData("http://127.0.0.1:8765/index.html#top")]
    [InlineData("http://127.0.0.1:8765/INDEX.HTML")]
    [InlineData("http://127.0.0.1:8765/index.html/")]
    [InlineData("http://127.0.0.1:8765/other.html")]
    [InlineData("http://127.0.0.1:8765//")]
    [InlineData("http://127.0.0.1:8765/./index.html")]
    [InlineData("http://127.0.0.1:8765/%69ndex.html")]
    [InlineData("http://127.0.0.1:8765\\")]
    [InlineData("http://127.0.0.1:8765\\index.html")]
    [InlineData("https://app.example/")]
    public void RejectsUntrustedBundledSource(string? source)
    {
        Assert.False(CompanionSettings.IsTrustedBundledSource(source));
    }

    [Theory]
    [InlineData("http://127.0.0.1:80/", 80)]
    [InlineData("http://127.0.0.1:1023/", 1023)]
    [InlineData("http://127.0.0.1:0/", 0)]
    [InlineData("http://127.0.0.1:-1/", -1)]
    [InlineData("http://127.0.0.1:65536/", 65536)]
    public void RejectsPortsOutsideBundledRange(string source, int port)
    {
        Assert.False(CompanionSettings.IsTrustedBundledSource(source, port));
    }
}
