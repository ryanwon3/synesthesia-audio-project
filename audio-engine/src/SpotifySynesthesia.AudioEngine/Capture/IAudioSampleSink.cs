namespace SpotifySynesthesia.AudioEngine.Capture;

public interface IAudioSampleSink
{
    /// <summary>
    /// Consumes interleaved IEEE float samples synchronously on the capture thread.
    /// Implementations must return quickly and must not retain the supplied span.
    /// </summary>
    void Write(ReadOnlySpan<float> interleavedSamples, in AudioPacketInfo packetInfo);
}
