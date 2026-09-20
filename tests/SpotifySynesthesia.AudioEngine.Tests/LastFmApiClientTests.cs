using System.Net;
using SpotifySynesthesia.AudioEngine.LastFm;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LastFmApiClientTests
{
    [Fact]
    public async Task ParsesTrackIdentityMbidsAndFlexibleTagCounts()
    {
        const string trackMbid = "61bf0388-b8a9-48f4-81d1-7eb02706dfb0";
        const string artistMbid = "bfcc6d75-a6a5-4bc6-8282-47aec8531818";
        QueueHttpMessageHandler handler = new(
            Json("""
                {"track":{"name":"Song","mbid":"61bf0388-b8a9-48f4-81d1-7eb02706dfb0","duration":"180000","@attr":{"corrected":"1"},"artist":{"name":"Artist","mbid":"bfcc6d75-a6a5-4bc6-8282-47aec8531818"}}}
                """),
            Json("""{"toptags":{"tag":[{"name":"dreamy","count":"97"},{"name":"pop","count":88}]}}"""),
            Json("""{"toptags":{"tag":{"name":"electronic"}}}"""));
        LastFmApiClient client = new(new HttpClient(handler));

        LastFmApiResult<LastFmTrackInfo> info = await client.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);
        LastFmTrackInfo track = Assert.IsType<LastFmTrackInfo>(info.Value);
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>> trackTags = await client.GetTrackTopTagsAsync(
            "dummy-key",
            track,
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>> artistTags = await client.GetArtistTopTagsAsync(
            "dummy-key",
            track,
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(trackMbid, track.TrackMusicBrainzId);
        Assert.Equal(artistMbid, track.ArtistMusicBrainzId);
        Assert.True(track.Autocorrected);
        Assert.Equal(97, trackTags.Value?[0].Count);
        Assert.Null(Assert.Single(artistTags.Value!).Count);
        Assert.All(handler.RequestUris, uri =>
        {
            Assert.Equal(Uri.UriSchemeHttps, uri.Scheme);
            Assert.Contains("api_key=dummy-key", uri.Query, StringComparison.Ordinal);
        });
        Assert.Contains("autocorrect=1", handler.RequestUris[0].Query, StringComparison.Ordinal);
        // Valid MBIDs must not divert tag requests away from the matched names.
        Assert.Contains("artist=Artist", handler.RequestUris[1].Query, StringComparison.Ordinal);
        Assert.Contains("track=Song", handler.RequestUris[1].Query, StringComparison.Ordinal);
        Assert.Contains("artist=Artist", handler.RequestUris[2].Query, StringComparison.Ordinal);
        Assert.DoesNotContain("mbid=", handler.RequestUris[1].Query, StringComparison.Ordinal);
        Assert.DoesNotContain("mbid=", handler.RequestUris[2].Query, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(10, LastFmApiResultKind.InvalidCredentials, LastFmErrorCategory.InvalidApiKey)]
    [InlineData(26, LastFmApiResultKind.InvalidCredentials, LastFmErrorCategory.SuspendedApiKey)]
    [InlineData(29, LastFmApiResultKind.RateLimited, LastFmErrorCategory.RateLimit)]
    [InlineData(6, LastFmApiResultKind.NoMatch, LastFmErrorCategory.NoMatch)]
    [InlineData(7, LastFmApiResultKind.NoMatch, LastFmErrorCategory.NoMatch)]
    [InlineData(8, LastFmApiResultKind.Unavailable, LastFmErrorCategory.ServerError)]
    [InlineData(11, LastFmApiResultKind.Unavailable, LastFmErrorCategory.ServiceOffline)]
    [InlineData(16, LastFmApiResultKind.Unavailable, LastFmErrorCategory.ServiceOffline)]
    public async Task MapsProviderErrors(
        int code,
        LastFmApiResultKind expectedKind,
        LastFmErrorCategory expectedCategory)
    {
        QueueHttpMessageHandler handler = new(Json($$"""{"error":{{code}},"message":"safe"}"""));
        LastFmApiClient client = new(new HttpClient(handler));

        LastFmApiResult<LastFmTrackInfo> result = await client.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(expectedKind, result.Kind);
        Assert.Equal(expectedCategory, result.ErrorCategory);
    }

    [Fact]
    public async Task ReadsProviderNoMatchFromBadRequestBody()
    {
        QueueHttpMessageHandler handler = new(new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("""{"error":6,"message":"Track not found","links":[]}"""),
        });
        LastFmApiClient client = new(new HttpClient(handler));

        LastFmApiResult<LastFmTrackInfo> result = await client.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(LastFmApiResultKind.NoMatch, result.Kind);
        Assert.Equal(LastFmErrorCategory.NoMatch, result.ErrorCategory);
    }

    [Fact]
    public async Task MapsMalformedJsonWithoutLeakingTheResponse()
    {
        QueueHttpMessageHandler handler = new(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("not-json"),
        });
        LastFmApiClient client = new(new HttpClient(handler));

        LastFmApiResult<LastFmTrackInfo> result = await client.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(LastFmApiResultKind.Error, result.Kind);
        Assert.Equal(LastFmErrorCategory.MalformedResponse, result.ErrorCategory);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, LastFmApiResultKind.InvalidCredentials, LastFmErrorCategory.InvalidApiKey)]
    [InlineData(HttpStatusCode.Forbidden, LastFmApiResultKind.InvalidCredentials, LastFmErrorCategory.InvalidApiKey)]
    [InlineData(HttpStatusCode.NotFound, LastFmApiResultKind.NoMatch, LastFmErrorCategory.NoMatch)]
    [InlineData(HttpStatusCode.TooManyRequests, LastFmApiResultKind.RateLimited, LastFmErrorCategory.RateLimit)]
    [InlineData(HttpStatusCode.InternalServerError, LastFmApiResultKind.Unavailable, LastFmErrorCategory.ServerError)]
    [InlineData(HttpStatusCode.BadRequest, LastFmApiResultKind.Error, LastFmErrorCategory.UnexpectedResponse)]
    public async Task MapsHttpFailures(
        HttpStatusCode statusCode,
        LastFmApiResultKind expectedKind,
        LastFmErrorCategory expectedCategory)
    {
        LastFmApiClient client = new(new HttpClient(new QueueHttpMessageHandler(new HttpResponseMessage(statusCode))));

        LastFmApiResult<LastFmTrackInfo> result = await client.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(expectedKind, result.Kind);
        Assert.Equal(expectedCategory, result.ErrorCategory);
    }

    [Fact]
    public async Task HonorsRetryAfterAndPropagatesCallerCancellation()
    {
        HttpResponseMessage response = new(HttpStatusCode.TooManyRequests);
        response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(90));
        LastFmApiClient rateLimitedClient = new(new HttpClient(new QueueHttpMessageHandler(response)));

        LastFmApiResult<LastFmTrackInfo> rateLimited = await rateLimitedClient.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);

        Assert.Equal(TimeSpan.FromSeconds(90), rateLimited.RetryAfter);

        LastFmApiClient waitingClient = new(new HttpClient(new WaitingHttpMessageHandler()));
        using CancellationTokenSource cancellation = CancellationTokenSource.CreateLinkedTokenSource(
            TestContext.Current.CancellationToken);
        cancellation.CancelAfter(TimeSpan.FromMilliseconds(10));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waitingClient.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(5),
            cancellation.Token));
    }

    [Fact]
    public async Task MapsNetworkAndTimeoutFailures()
    {
        LastFmApiClient networkClient = new(new HttpClient(new ThrowingHttpMessageHandler()));
        LastFmApiClient timeoutClient = new(new HttpClient(new WaitingHttpMessageHandler()));

        LastFmApiResult<LastFmTrackInfo> network = await networkClient.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromSeconds(1),
            TestContext.Current.CancellationToken);
        LastFmApiResult<LastFmTrackInfo> timeout = await timeoutClient.GetTrackInfoAsync(
            "dummy-key",
            "Artist",
            "Song",
            TimeSpan.FromMilliseconds(10),
            TestContext.Current.CancellationToken);

        Assert.Equal(LastFmErrorCategory.Network, network.ErrorCategory);
        Assert.Equal(LastFmErrorCategory.Timeout, timeout.ErrorCategory);
    }

    private static HttpResponseMessage Json(string json) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(json),
    };

    private sealed class QueueHttpMessageHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> _responses = new(responses);

        public List<Uri> RequestUris { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RequestUris.Add(Assert.IsType<Uri>(request.RequestUri));
            return Task.FromResult(_responses.Dequeue());
        }
    }

    private sealed class ThrowingHttpMessageHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) => throw new HttpRequestException("offline");
    }

    private sealed class WaitingHttpMessageHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }
    }
}
