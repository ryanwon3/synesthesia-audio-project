namespace SpotifySynesthesia.AudioEngine.Spotify;

public sealed record SpotifyPollingOptions
{
    public TimeSpan PlayingInterval { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan PausedInterval { get; init; } = TimeSpan.FromSeconds(10);

    public TimeSpan EmptyInterval { get; init; } = TimeSpan.FromSeconds(10);

    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan InitialBackoff { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan MaximumBackoff { get; init; } = TimeSpan.FromSeconds(60);

    public TimeSpan GetPollingInterval(SpotifyMetadataStatus status) => status switch
    {
        SpotifyMetadataStatus.PlayingTrack => PlayingInterval,
        SpotifyMetadataStatus.PausedTrack => PausedInterval,
        _ => EmptyInterval,
    };

    public TimeSpan GetBackoff(int consecutiveFailures)
    {
        int exponent = Math.Clamp(consecutiveFailures - 1, 0, 30);
        double milliseconds = InitialBackoff.TotalMilliseconds * Math.Pow(2, exponent);
        return TimeSpan.FromMilliseconds(Math.Min(milliseconds, MaximumBackoff.TotalMilliseconds));
    }

    public void Validate()
    {
        ValidatePositive(PlayingInterval, nameof(PlayingInterval));
        ValidatePositive(PausedInterval, nameof(PausedInterval));
        ValidatePositive(EmptyInterval, nameof(EmptyInterval));
        ValidatePositive(RequestTimeout, nameof(RequestTimeout));
        ValidatePositive(InitialBackoff, nameof(InitialBackoff));
        ValidatePositive(MaximumBackoff, nameof(MaximumBackoff));
    }

    private static void ValidatePositive(TimeSpan value, string name)
    {
        if (value <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(name, "Polling durations must be positive.");
        }
    }
}
