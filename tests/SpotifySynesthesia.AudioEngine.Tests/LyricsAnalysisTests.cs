using System.Net;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.Lyrics;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LyricsAnalysisTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static MoodTraits Traits => new("sad", 0.3, 0.2, 0.8, "water", "ripples", "clouds", "ribbons");
    public static SongProfileIdentity Identity => new("fixture", null, null, "Test song",
        [new(null, "Test artist")], new(null, "Test album", null, null, null), 60000, false);

    [Fact]
    public void LrcParsingPreservesRepeatedLinesAndRealTimestamps()
    {
        var lines = LrcLibLyricsProvider.ParseLines("[offset:100]\n[00:02.50][00:12.50]Original fixture line\n[00:22.0]\n[99:00]outside", null, 60000);
        Assert.Equal(3, lines.Count); Assert.Equal(2600, lines[0].StartMs); Assert.Equal(12600, lines[1].StartMs);
        Assert.Empty(lines[2].Text);
    }
    [Fact]
    public void PlainLyricsNeverInventTimestamps()
    {
        var lines = LrcLibLyricsProvider.ParseLines("not LRC", "Original fixture line\nAnother fixture line", 60000);
        Assert.Equal(2, lines.Count); Assert.All(lines, line => Assert.Null(line.StartMs));
    }
    [Theory]
    [InlineData("Test song", "Test artist", 60, true)]
    [InlineData("Other song", "Test artist", 60, false)]
    [InlineData("Test song", "Other artist", 60, false)]
    [InlineData("Test song", "Test artist", 64, false)]
    public async Task ProviderRejectsMismatchedIdentity(string title, string artist, int duration, bool matches)
    {
        using var handler = new FixtureHandler(_ => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new {
            id = 1, trackName = title, artistName = artist, albumName = "Test album", duration,
            instrumental = false, plainLyrics = "Original fixture line", syncedLyrics = (string?)null })) });
        using var http = new HttpClient(handler);
        var result = await new LrcLibLyricsProvider(http).GetAsync(Identity, TestContext.Current.CancellationToken);
        Assert.Equal(matches, result is not null);
    }
    [Fact]
    public void ModelSectionsMapIndicesToProviderTimestampsAndBoundGaps()
    {
        var lyrics = new LyricsDocument("fixture", "1", false, [new("a", 1000), new("b", 5000), new("c", 40000)]);
        string json = Response(new { wholeSong = Traits, sections = new[] { new { startLine = 0, endLine = 1, traits = Traits } } });
        var result = OpenAiLyricsAnalyzer.ParseResponse(json, lyrics, 60000);
        Assert.Equal(1000, result.Sections[0].StartMs); Assert.Equal(17000, result.Sections[0].EndMs);
        Assert.Empty(OpenAiLyricsAnalyzer.ParseResponse(json, lyrics with { Lines = [new("a", null), new("b", null), new("c", null)] }, 60000).Sections);
    }
    [Theory]
    [InlineData(-1, 1)]
    [InlineData(1, 0)]
    [InlineData(0, 99)]
    public void RejectsInventedLineIndices(int start, int end)
    {
        var lyrics = new LyricsDocument("fixture", "1", false, [new("a", 1000), new("b", 5000)]);
        Assert.Throws<JsonException>(() => OpenAiLyricsAnalyzer.ParseResponse(Response(new { wholeSong = Traits,
            sections = new[] { new { startLine = start, endLine = end, traits = Traits } } }), lyrics, 60000));
    }
    [Theory]
    [InlineData("{\"status\":\"incomplete\"}")]
    [InlineData("{\"status\":\"completed\",\"output\":[{\"content\":[{\"type\":\"refusal\"}]}]}")]
    public void HandlesIncompleteAndRefusedResponses(string json) => Assert.Throws<EnrichmentException>(() =>
        OpenAiLyricsAnalyzer.ParseResponse(json, new("fixture", "1", false, []), 60000));

    [Theory]
    [InlineData(401, "", "API key rejected", false)]
    [InlineData(429, "insufficient_quota", "API quota exhausted", false)]
    [InlineData(429, "", "AI rate limited", true)]
    [InlineData(503, "", "AI service unavailable", true)]
    public async Task ErrorsAreSanitizedAndClassified(int status, string body, string category, bool retryable)
    {
        using var handler = new FixtureHandler(_ => new((HttpStatusCode)status) { Content = new StringContent(body + " secret-marker") });
        using var http = new HttpClient(handler);
        var error = await Assert.ThrowsAsync<EnrichmentException>(() => new OpenAiLyricsAnalyzer(http).AnalyzeAsync(
            "fixture-secret", "gpt-5-mini", Identity, new("fixture", "1", false, [new("Original fixture", null)]), [], TestContext.Current.CancellationToken));
        Assert.Equal(category, error.Category); Assert.Equal(retryable, error.Retryable); Assert.DoesNotContain("secret", error.Message);
    }
    public static string Response(object analysis) => JsonSerializer.Serialize(new { status = "completed",
        output = new[] { new { content = new[] { new { type = "output_text", text = JsonSerializer.Serialize(analysis, Json) } } } } });
    private sealed class FixtureHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(respond(request));
    }
}
