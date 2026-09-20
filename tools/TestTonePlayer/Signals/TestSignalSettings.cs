namespace SpotifySynesthesia.TestTonePlayer.Signals;

public sealed record TestSignalSettings
{
    public const int DefaultSampleRate = 48_000;
    public const float DefaultLevel = 0.15f;
    public const float MaximumLevel = 0.50f;

    public static readonly TimeSpan DefaultFadeDuration = TimeSpan.FromMilliseconds(10);
    public static readonly TimeSpan PulseOnDuration = TimeSpan.FromMilliseconds(100);
    public static readonly TimeSpan PulsePeriod = TimeSpan.FromSeconds(1);

    public TestSignalSettings(
        TestSignalKind signal,
        ChannelMode channelMode,
        float level = DefaultLevel,
        int sampleRate = DefaultSampleRate,
        TimeSpan? fadeDuration = null)
    {
        if (!Enum.IsDefined(signal))
        {
            throw new ArgumentOutOfRangeException(nameof(signal));
        }

        if (!Enum.IsDefined(channelMode))
        {
            throw new ArgumentOutOfRangeException(nameof(channelMode));
        }

        ValidateLevel(level);

        if (sampleRate < 8_000 || sampleRate > 384_000)
        {
            throw new ArgumentOutOfRangeException(
                nameof(sampleRate),
                sampleRate,
                "Sample rate must be between 8 kHz and 384 kHz.");
        }

        TimeSpan resolvedFadeDuration = fadeDuration ?? DefaultFadeDuration;
        if (resolvedFadeDuration < TimeSpan.Zero || resolvedFadeDuration > TimeSpan.FromSeconds(1))
        {
            throw new ArgumentOutOfRangeException(
                nameof(fadeDuration),
                resolvedFadeDuration,
                "Fade duration must be between zero and one second.");
        }

        Signal = signal;
        ChannelMode = channelMode;
        Level = level;
        SampleRate = sampleRate;
        FadeDuration = resolvedFadeDuration;
    }

    public TestSignalKind Signal { get; }

    public ChannelMode ChannelMode { get; }

    public float Level { get; }

    public int SampleRate { get; }

    public TimeSpan FadeDuration { get; }

    public TestSignalSettings WithLevel(float level) =>
        new(Signal, ChannelMode, level, SampleRate, FadeDuration);

    public static void ValidateLevel(float level)
    {
        if (!float.IsFinite(level) || level < 0f || level > MaximumLevel)
        {
            throw new ArgumentOutOfRangeException(
                nameof(level),
                level,
                $"Level must be finite and between 0 and {MaximumLevel:P0}.");
        }
    }
}
