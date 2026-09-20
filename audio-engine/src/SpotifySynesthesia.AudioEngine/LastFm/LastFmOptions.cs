namespace SpotifySynesthesia.AudioEngine.LastFm;

public sealed record LastFmOptions
{
    public TimeSpan RequestTimeout { get; init; } = TimeSpan.FromSeconds(5);

    public TimeSpan NegativeCacheDuration { get; init; } = TimeSpan.FromDays(30);

    public TimeSpan DefaultRateLimitCooldown { get; init; } = TimeSpan.FromSeconds(60);

    public int MaximumConcurrentEnrichments { get; init; } = 2;

    public int MaximumTagCount { get; init; } = 20;

    public double MinimumNormalizedWeight { get; init; } = 0.10;

    public void Validate()
    {
        if (RequestTimeout <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(RequestTimeout));
        }

        if (NegativeCacheDuration <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(NegativeCacheDuration));
        }

        if (DefaultRateLimitCooldown <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(DefaultRateLimitCooldown));
        }

        if (MaximumConcurrentEnrichments <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumConcurrentEnrichments));
        }

        if (MaximumTagCount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaximumTagCount));
        }

        if (MinimumNormalizedWeight is < 0 or > 1)
        {
            throw new ArgumentOutOfRangeException(nameof(MinimumNormalizedWeight));
        }
    }
}
