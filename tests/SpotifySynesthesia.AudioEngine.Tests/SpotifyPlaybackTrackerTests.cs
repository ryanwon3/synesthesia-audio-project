using System.Globalization;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class SpotifyPlaybackTrackerTests
{
    public static TheoryData<PlaybackObservation[], string[]> StableTrackSequences => new()
    {
        { [Track("A"), Track("A")], ["A"] },
        { [Track("A", progress: 100), Track("A", progress: 200)], ["A"] },
        { [Track("A", playing: true), Track("A", playing: false), Track("A", playing: true)], ["A"] },
        { [Track("A"), Track("B")], ["A", "B"] },
        { [Track("A"), Unavailable(), Track("A")], ["A"] },
        { [Track("A"), Unavailable(), Track("B")], ["A", "B"] },
        { [Track("A"), Unsupported(), Track("A")], ["A"] },
        { [Track("A"), Unsupported(), Track("B")], ["A", "B"] },
        { [Track("A"), NoPlayback(), Track("A")], ["A"] },
    };

    [Theory]
    [MemberData(nameof(StableTrackSequences))]
    public void EmitsTrackChangedOnlyForStableIdChanges(PlaybackObservation[] steps, string[] expectedIds)
    {
        SpotifyPlaybackTracker tracker = new();
        List<string> changedIds = [];
        tracker.TrackChanged += track => changedIds.Add(track.SpotifyTrackId);

        foreach (PlaybackObservation step in steps)
        {
            tracker.Apply(step.Result, step.ObservedAtUtc);
        }

        Assert.Equal(expectedIds, changedIds);
    }

    [Fact]
    public void DistinguishesUnavailableNoPlaybackAndUnsupportedContent()
    {
        SpotifyPlaybackTracker tracker = new();
        DateTimeOffset now = Utc("2026-08-12T12:00:00Z");
        tracker.Apply(Track("A").Result, now);

        tracker.Apply(Unavailable().Result, now.AddSeconds(1), now.AddSeconds(6));
        Assert.Equal(SpotifyMetadataStatus.MetadataUnavailable, tracker.State.MetadataStatus);
        Assert.Equal("A", tracker.State.CurrentTrack?.SpotifyTrackId);
        Assert.True(tracker.State.Stale);

        tracker.Apply(NoPlayback().Result, now.AddSeconds(2));
        Assert.Equal(SpotifyMetadataStatus.NoPlayback, tracker.State.MetadataStatus);
        Assert.Null(tracker.State.CurrentTrack);
        Assert.False(tracker.State.Stale);

        tracker.Apply(Unsupported().Result, now.AddSeconds(3));
        Assert.Equal(SpotifyMetadataStatus.UnsupportedContent, tracker.State.MetadataStatus);
        Assert.Null(tracker.State.CurrentTrack);
        Assert.False(tracker.State.Stale);
        Assert.Equal("A", tracker.LastStableTrackId);
    }

    [Fact]
    public void PollingOptionsProduceConfiguredIntervalsAndBoundedBackoff()
    {
        SpotifyPollingOptions options = new();

        Assert.Equal(TimeSpan.FromSeconds(5), options.GetPollingInterval(SpotifyMetadataStatus.PlayingTrack));
        Assert.Equal(TimeSpan.FromSeconds(10), options.GetPollingInterval(SpotifyMetadataStatus.PausedTrack));
        Assert.Equal(
            [5, 10, 20, 40, 60, 60],
            Enumerable.Range(1, 6).Select(attempt => (int)options.GetBackoff(attempt).TotalSeconds));
    }

    private static PlaybackObservation Track(string id, long progress = 0, bool playing = true)
    {
        DateTimeOffset observedAt = Utc("2026-08-12T12:00:00Z").AddMilliseconds(progress);
        CurrentTrack track = new(
            id,
            $"spotify:track:{id}",
            Isrc: null,
            Title: id,
            Artists: [],
            Album: null,
            DurationMs: 180_000,
            Explicit: false,
            ProgressMs: progress,
            IsPlaying: playing,
            observedAt);
        return new PlaybackObservation(SpotifyPlaybackResult.Playing(track), observedAt);
    }

    private static PlaybackObservation Unavailable() => new(
        new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable),
        Utc("2026-08-12T12:00:01Z"));

    private static PlaybackObservation Unsupported() => new(
        new SpotifyPlaybackResult(SpotifyPlaybackResultKind.UnsupportedContent),
        Utc("2026-08-12T12:00:01Z"));

    private static PlaybackObservation NoPlayback() => new(
        new SpotifyPlaybackResult(SpotifyPlaybackResultKind.NoPlayback),
        Utc("2026-08-12T12:00:01Z"));

    private static DateTimeOffset Utc(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture);

    public sealed record PlaybackObservation(SpotifyPlaybackResult Result, DateTimeOffset ObservedAtUtc);
}
