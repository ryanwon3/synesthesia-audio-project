using SpotifySynesthesia.Desktop;

namespace SpotifySynesthesia.AudioEngine.Tests;

// Pure startup-composition settings only: no environment, protected stores, WPF, audio, or providers.
public sealed class CompanionStartupTests
{
    private const string Hosted = "https://app.example";
    private const string LegacyOptIn = "true";

    [Theory]
    [InlineData(null, null)]
    [InlineData(Hosted, Hosted)]
    [InlineData("  https://APP.example:443/  ", Hosted)]
    public void AbsentLegacyFlagStartsSafeCompanion(string? configuredOrigin, string? expectedOrigin)
    {
        CompanionSettings settings = CompanionSettings.FromStartupConfiguration(configuredOrigin, null);

        Assert.True(settings.CompanionMode);
        Assert.Equal(expectedOrigin, settings.HostedOrigin);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData(Hosted, Hosted)]
    public void ExactLiteralTrueOptsIntoLegacyEnrichment(string? configuredOrigin, string? expectedOrigin)
    {
        CompanionSettings settings = CompanionSettings.FromStartupConfiguration(configuredOrigin, LegacyOptIn);

        Assert.False(settings.CompanionMode);
        Assert.Equal(expectedOrigin, settings.HostedOrigin);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("\t")]
    [InlineData("false")]
    [InlineData("False")]
    [InlineData("TRUE")]
    [InlineData("True")]
    [InlineData("tRUE")]
    [InlineData("1")]
    [InlineData("0")]
    [InlineData("yes")]
    [InlineData("on")]
    [InlineData(" true")]
    [InlineData("true ")]
    [InlineData(" true ")]
    [InlineData("true\n")]
    [InlineData("true\0")]
    [InlineData("\"true\"")]
    [InlineData("true;")]
    [InlineData("true,true")]
    [InlineData("truee")]
    [InlineData("tru")]
    [InlineData("t\u0072ue\u200B")]
    [InlineData("\uFF54\uFF52\uFF55\uFF45")]
    public void NonExactLegacyFlagsFailClosedToCompanion(string legacyEnrichment)
    {
        Assert.True(CompanionSettings.FromStartupConfiguration(null, legacyEnrichment).CompanionMode);
        Assert.True(CompanionSettings.FromStartupConfiguration(Hosted, legacyEnrichment).CompanionMode);
    }

    [Theory]
    [InlineData("http://app.example")]
    [InlineData("https://app.example/path")]
    [InlineData("https://user:secret@app.example")]
    [InlineData("https://*.example")]
    [InlineData("*")]
    [InlineData("http://127.0.0.1:8765")]
    public void UnsafeHostedOriginIsRejectedRegardlessOfFlag(string configuredOrigin)
    {
        Assert.Throws<ArgumentException>(() => CompanionSettings.FromStartupConfiguration(configuredOrigin, null));
        Assert.Throws<ArgumentException>(() => CompanionSettings.FromStartupConfiguration(configuredOrigin, LegacyOptIn));
        Assert.Throws<ArgumentException>(() => CompanionSettings.FromStartupConfiguration(configuredOrigin, "false"));
    }

    [Fact]
    public void ConstructorDefaultsRemainCompatible()
    {
        Assert.False(new CompanionSettings().CompanionMode);
        Assert.Null(new CompanionSettings().HostedOrigin);
        Assert.False(new CompanionSettings(Hosted).CompanionMode);
        Assert.Equal(Hosted, new CompanionSettings(Hosted).HostedOrigin);
        Assert.True(new CompanionSettings(companionMode: true).CompanionMode);
    }
}
