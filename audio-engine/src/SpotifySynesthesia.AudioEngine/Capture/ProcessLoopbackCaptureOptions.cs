namespace SpotifySynesthesia.AudioEngine.Capture;

public sealed record ProcessLoopbackCaptureOptions
{
    public const int DefaultSampleRate = 48_000;
    public const int DefaultChannelCount = 2;

    public ProcessLoopbackCaptureOptions(
        int targetProcessId,
        bool includeProcessTree = true,
        int sampleRate = DefaultSampleRate,
        int channelCount = DefaultChannelCount)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(targetProcessId);

        if (sampleRate < 8_000 || sampleRate > 192_000)
        {
            throw new ArgumentOutOfRangeException(
                nameof(sampleRate),
                sampleRate,
                "Sample rate must be between 8 kHz and 192 kHz.");
        }

        if (channelCount is < 1 or > 2)
        {
            throw new ArgumentOutOfRangeException(
                nameof(channelCount),
                channelCount,
                "Process capture currently supports mono or stereo output.");
        }

        TargetProcessId = targetProcessId;
        IncludeProcessTree = includeProcessTree;
        SampleRate = sampleRate;
        ChannelCount = channelCount;
    }

    public int TargetProcessId { get; }

    public bool IncludeProcessTree { get; }

    public int SampleRate { get; }

    public int ChannelCount { get; }
}
