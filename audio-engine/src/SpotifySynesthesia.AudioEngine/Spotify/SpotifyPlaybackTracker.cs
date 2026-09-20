namespace SpotifySynesthesia.AudioEngine.Spotify;

public sealed class SpotifyPlaybackTracker
{
    private CurrentTrack? _lastSuccessfulTrack;
    private string? _lastStableTrackId;

    public event Action<CurrentTrack>? TrackChanged;

    public event Action<SpotifyPlaybackState>? PlaybackUpdated;

    public string? LastStableTrackId => _lastStableTrackId;

    public SpotifyPlaybackState State { get; private set; } = new(
        SpotifyMetadataStatus.AuthenticationRequired,
        CurrentTrack: null,
        Stale: false,
        LastSuccessfulUpdateUtc: null,
        NextRetryUtc: null);

    public bool Apply(SpotifyPlaybackResult result, DateTimeOffset observedAtUtc, DateTimeOffset? nextRetryUtc = null)
    {
        ArgumentNullException.ThrowIfNull(result);

        CurrentTrack? changedTrack = null;
        switch (result.Kind)
        {
            case SpotifyPlaybackResultKind.Track:
                CurrentTrack track = result.Track ?? throw new ArgumentException(
                    "A track result must contain a current track.",
                    nameof(result));
                _lastSuccessfulTrack = track;
                bool changed = !string.Equals(_lastStableTrackId, track.SpotifyTrackId, StringComparison.Ordinal);
                if (changed)
                {
                    _lastStableTrackId = track.SpotifyTrackId;
                    changedTrack = track;
                }

                State = new SpotifyPlaybackState(
                    track.IsPlaying ? SpotifyMetadataStatus.PlayingTrack : SpotifyMetadataStatus.PausedTrack,
                    track,
                    Stale: false,
                    observedAtUtc,
                    NextRetryUtc: null);
                break;

            case SpotifyPlaybackResultKind.NoPlayback:
                State = new SpotifyPlaybackState(
                    SpotifyMetadataStatus.NoPlayback,
                    CurrentTrack: null,
                    Stale: false,
                    observedAtUtc,
                    NextRetryUtc: null);
                break;

            case SpotifyPlaybackResultKind.UnsupportedContent:
                State = new SpotifyPlaybackState(
                    SpotifyMetadataStatus.UnsupportedContent,
                    CurrentTrack: null,
                    Stale: false,
                    observedAtUtc,
                    NextRetryUtc: null);
                break;

            case SpotifyPlaybackResultKind.Forbidden:
                State = CreateFailureState(SpotifyMetadataStatus.Forbidden, nextRetryUtc);
                break;

            case SpotifyPlaybackResultKind.RateLimited:
                State = CreateFailureState(SpotifyMetadataStatus.RateLimited, nextRetryUtc);
                break;

            case SpotifyPlaybackResultKind.Unauthorized:
                State = CreateFailureState(SpotifyMetadataStatus.AuthenticationRequired, nextRetryUtc);
                break;

            case SpotifyPlaybackResultKind.Unavailable:
                State = CreateFailureState(SpotifyMetadataStatus.MetadataUnavailable, nextRetryUtc);
                break;

            default:
                throw new ArgumentOutOfRangeException(nameof(result), result.Kind, "Unknown playback result.");
        }

        PlaybackUpdated?.Invoke(State);
        if (changedTrack is not null)
        {
            TrackChanged?.Invoke(changedTrack);
            return true;
        }

        return false;
    }

    public void Reset()
    {
        _lastSuccessfulTrack = null;
        _lastStableTrackId = null;
        State = new SpotifyPlaybackState(
            SpotifyMetadataStatus.AuthenticationRequired,
            CurrentTrack: null,
            Stale: false,
            LastSuccessfulUpdateUtc: null,
            NextRetryUtc: null);
        PlaybackUpdated?.Invoke(State);
    }

    private SpotifyPlaybackState CreateFailureState(
        SpotifyMetadataStatus status,
        DateTimeOffset? nextRetryUtc) => new(
            status,
            _lastSuccessfulTrack,
            Stale: true,
            State.LastSuccessfulUpdateUtc,
            nextRetryUtc);
}
