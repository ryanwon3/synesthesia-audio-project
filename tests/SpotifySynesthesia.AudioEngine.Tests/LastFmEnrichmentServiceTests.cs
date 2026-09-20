using System.Globalization;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LastFmEnrichmentServiceTests
{
    [Fact]
    public async Task KeepsTrackAndArtistTagsSeparate()
    {
        StubLastFmApiClient client = new(
            new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.Success,
                new LastFmTrackInfo("Song", "Artist", null, null, 180_000, false)),
            [new LastFmProviderTag("dreamy", 100, 0)],
            [new LastFmProviderTag("dream pop", 50, 0)]);
        LastFmEnrichmentService service = new(client, new LastFmTagNormalizer());

        LastFmEnrichmentResult result = await service.EnrichAsync(
            "dummy-key",
            CreateProfile(),
            TestContext.Current.CancellationToken);

        LastFmEnrichment enrichment = Assert.IsType<LastFmEnrichment>(result.Enrichment);
        Assert.Equal("dreamy", Assert.Single(enrichment.TrackTags).Name);
        Assert.Equal("dream pop", Assert.Single(enrichment.ArtistTags).Name);
    }

    [Fact]
    public async Task SuccessfulEmptyTagResponsesAreNotFailures()
    {
        StubLastFmApiClient client = new(
            new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.Success,
                new LastFmTrackInfo("Song", "Artist", null, null, 180_000, false)),
            [],
            []);
        LastFmEnrichmentService service = new(client, new LastFmTagNormalizer());

        LastFmEnrichmentResult result = await service.EnrichAsync(
            "dummy-key",
            CreateProfile(),
            TestContext.Current.CancellationToken);

        Assert.Equal(LastFmStatus.Succeeded, result.Status);
        Assert.Empty(Assert.IsType<LastFmEnrichment>(result.Enrichment).TrackTags);
    }

    [Fact]
    public async Task MissingTrackTagsDoNotDiscardSuccessfulArtistTags()
    {
        LastFmEnrichmentService service = new(
            new MissingTrackTagsLastFmApiClient(),
            new LastFmTagNormalizer());

        LastFmEnrichmentResult result = await service.EnrichAsync(
            "dummy-key",
            CreateProfile(),
            TestContext.Current.CancellationToken);

        LastFmEnrichment enrichment = Assert.IsType<LastFmEnrichment>(result.Enrichment);
        Assert.Equal(LastFmStatus.Succeeded, result.Status);
        Assert.Empty(enrichment.TrackTags);
        Assert.Equal("indie pop", Assert.Single(enrichment.ArtistTags).Name);
    }

    [Fact]
    public async Task NoMatchCreatesAThirtyDayCacheableResult()
    {
        StubLastFmApiClient client = new(
            new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.NoMatch,
                ErrorCategory: LastFmErrorCategory.NoMatch),
            [],
            []);
        LastFmEnrichmentService service = new(client, new LastFmTagNormalizer());

        LastFmEnrichmentResult result = await service.EnrichAsync(
            "dummy-key",
            CreateProfile(),
            TestContext.Current.CancellationToken);

        Assert.Equal(LastFmStatus.NoMatch, result.Status);
        Assert.Equal(LastFmStatus.NoMatch, Assert.IsType<LastFmEnrichment>(result.Enrichment).Status);
    }

    private static SongProfile CreateProfile() => new(
        new SongProfileIdentity(
            "track-id",
            null,
            null,
            "Song",
            [new SpotifyArtistIdentity("artist-id", "Artist")],
            null,
            180_000,
            false),
        new ReservedSongProfileData(null, null, null, null, null),
        new SongProfileCacheMetadata(
            DateTimeOffset.Parse("2026-08-12T12:00:00Z", CultureInfo.InvariantCulture),
            DateTimeOffset.Parse("2026-08-12T12:00:00Z", CultureInfo.InvariantCulture),
            2));

    private sealed class StubLastFmApiClient(
        LastFmApiResult<LastFmTrackInfo> trackInfo,
        IReadOnlyList<LastFmProviderTag> trackTags,
        IReadOnlyList<LastFmProviderTag> artistTags) : ILastFmApiClient
    {
        public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(trackInfo);

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(LastFmApiResultKind.Success, trackTags));

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(LastFmApiResultKind.Success, artistTags));
    }

    private sealed class MissingTrackTagsLastFmApiClient : ILastFmApiClient
    {
        public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<LastFmTrackInfo>(
                    LastFmApiResultKind.Success,
                    new LastFmTrackInfo(track, artist, null, null, 180_000, false)));

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(
                    LastFmApiResultKind.NoMatch,
                    ErrorCategory: LastFmErrorCategory.NoMatch));

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(
                    LastFmApiResultKind.Success,
                    [new LastFmProviderTag("indie pop", 100, 0)]));
    }
}
