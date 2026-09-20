namespace SpotifySynesthesia.AudioEngine.Capture;

public sealed class CompositeAudioSampleSink : IAudioSampleSink
{
    private readonly IReadOnlyList<IAudioSampleSink> _sinks;

    public CompositeAudioSampleSink(params IAudioSampleSink[] sinks)
    {
        ArgumentNullException.ThrowIfNull(sinks);

        if (sinks.Length == 0 || sinks.Any(sink => sink is null))
        {
            throw new ArgumentException("At least one non-null audio sink is required.", nameof(sinks));
        }

        _sinks = sinks;
    }

    public void Write(ReadOnlySpan<float> interleavedSamples, in AudioPacketInfo packetInfo)
    {
        foreach (IAudioSampleSink sink in _sinks)
        {
            sink.Write(interleavedSamples, in packetInfo);
        }
    }
}
