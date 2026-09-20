using System.Net;
using System.Text;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class SpotifyCurrentPlaybackClientTests
{
    [Fact]
    public async Task ParsesStableSpotifyIdentity()
    {
        const string json = """
            {
              "is_playing": true,
              "progress_ms": 12345,
              "currently_playing_type": "track",
              "item": {
                "id": "track-1",
                "uri": "spotify:track:track-1",
                "type": "track",
                "name": "Track title",
                "duration_ms": 200000,
                "explicit": true,
                "is_local": false,
                "external_ids": { "isrc": "USABC1234567" },
                "artists": [{ "id": "artist-1", "name": "Artist" }],
                "album": {
                  "id": "album-1",
                  "name": "Album",
                  "release_date": "2026-01-02",
                  "release_date_precision": "day",
                  "images": [{ "url": "https://example.test/art.jpg" }]
                }
              }
            }
            """;
        using HttpClient httpClient = new(new StubHttpHandler(_ => Json(HttpStatusCode.OK, json)));
        SpotifyCurrentPlaybackClient client = new(httpClient);

        SpotifyPlaybackResult result = await client.GetCurrentPlaybackAsync(
            "access-token",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        CurrentTrack track = Assert.IsType<CurrentTrack>(result.Track);
        Assert.Equal("track-1", track.SpotifyTrackId);
        Assert.Equal("spotify:track:track-1", track.SpotifyUri);
        Assert.Equal("USABC1234567", track.Isrc);
        Assert.Equal("artist-1", Assert.Single(track.Artists).SpotifyArtistId);
        Assert.Equal("album-1", track.Album?.SpotifyAlbumId);
        Assert.Equal("day", track.Album?.ReleaseDatePrecision);
        Assert.True(track.Explicit);
    }

    [Theory]
    [InlineData(HttpStatusCode.NoContent, SpotifyPlaybackResultKind.NoPlayback)]
    [InlineData(HttpStatusCode.Unauthorized, SpotifyPlaybackResultKind.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden, SpotifyPlaybackResultKind.Forbidden)]
    public async Task MapsStatusCodes(HttpStatusCode status, SpotifyPlaybackResultKind expected)
    {
        using HttpClient httpClient = new(new StubHttpHandler(_ => new HttpResponseMessage(status)));
        SpotifyCurrentPlaybackClient client = new(httpClient);

        SpotifyPlaybackResult result = await client.GetCurrentPlaybackAsync(
            "token",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(expected, result.Kind);
    }

    [Fact]
    public async Task MapsEpisodesAndLocalTracksToUnsupportedContent()
    {
        const string episode = """
            { "is_playing": true, "currently_playing_type": "episode", "item": { "type": "episode", "id": "episode" } }
            """;
        using HttpClient httpClient = new(new StubHttpHandler(_ => Json(HttpStatusCode.OK, episode)));
        SpotifyCurrentPlaybackClient client = new(httpClient);

        SpotifyPlaybackResult result = await client.GetCurrentPlaybackAsync(
            "token",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(SpotifyPlaybackResultKind.UnsupportedContent, result.Kind);
        Assert.Null(result.Track);
    }

    [Fact]
    public async Task HonorsRetryAfter()
    {
        using HttpClient httpClient = new(new StubHttpHandler(_ =>
        {
            HttpResponseMessage response = new(HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(17));
            return response;
        }));
        SpotifyCurrentPlaybackClient client = new(httpClient);

        SpotifyPlaybackResult result = await client.GetCurrentPlaybackAsync(
            "token",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(SpotifyPlaybackResultKind.RateLimited, result.Kind);
        Assert.Equal(TimeSpan.FromSeconds(17), result.RetryAfter);
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string json) => new(status)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json"),
    };
}

internal sealed class StubHttpHandler(Func<HttpRequestMessage, HttpResponseMessage> responseFactory) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(responseFactory(request));
    }
}
