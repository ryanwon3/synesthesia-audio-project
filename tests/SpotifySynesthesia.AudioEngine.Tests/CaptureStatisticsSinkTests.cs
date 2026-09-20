using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class CaptureStatisticsSinkTests
{
    [Fact]
    public void MeasuresStereoSineWave()
    {
        const int sampleRate = 48_000;
        const int frameCount = 48_000;
        const float amplitude = 0.2f;
        const double frequency = 440d;
        float[] samples = new float[frameCount * 2];

        for (int frame = 0; frame < frameCount; frame++)
        {
            float sample = amplitude * (float)Math.Sin(2d * Math.PI * frequency * frame / sampleRate);
            samples[frame * 2] = sample;
            samples[(frame * 2) + 1] = sample;
        }

        CaptureStatisticsSink sink = new();
        AudioPacketInfo packet = CreatePacket(frameCount, sampleRate, channels: 2);
        sink.Write(samples, in packet);

        CaptureStatisticsSnapshot result = sink.GetSnapshot();

        Assert.True(result.HasSignal);
        Assert.Equal(frameCount, result.FrameCount);
        Assert.Equal(1d, result.DurationSeconds, precision: 6);
        Assert.Equal(amplitude / Math.Sqrt(2d), result.Rms, precision: 3);
        Assert.InRange(result.EstimatedFrequencyHz, 439d, 441d);
        Assert.True(result.NonSilentRatio > 0.99d);
    }

    [Fact]
    public void ReportsSilentFramesWithoutNaN()
    {
        float[] samples = new float[960];
        CaptureStatisticsSink sink = new();
        AudioPacketInfo packet = CreatePacket(frameCount: 480, sampleRate: 48_000, channels: 2, isSilent: true);

        sink.Write(samples, in packet);
        CaptureStatisticsSnapshot result = sink.GetSnapshot();

        Assert.False(result.HasSignal);
        Assert.Equal(0d, result.Rms);
        Assert.Equal(0f, result.Peak);
        Assert.True(double.IsFinite(result.EstimatedFrequencyHz));
    }

    [Fact]
    public void SanitizesInvalidSamplesAndCountsDiscontinuities()
    {
        float[] samples = [float.NaN, float.PositiveInfinity, 2f, -2f];
        CaptureStatisticsSink sink = new();
        AudioPacketInfo packet = CreatePacket(
            frameCount: 2,
            sampleRate: 48_000,
            channels: 2,
            hasDiscontinuity: true);

        sink.Write(samples, in packet);
        CaptureStatisticsSnapshot result = sink.GetSnapshot();

        Assert.Equal(1, result.DiscontinuityCount);
        Assert.Equal(1f, result.Peak);
        Assert.True(double.IsFinite(result.Rms));
    }

    private static AudioPacketInfo CreatePacket(
        int frameCount,
        int sampleRate,
        int channels,
        bool isSilent = false,
        bool hasDiscontinuity = false) =>
        new(
            CaptureTimestamp: 0,
            DevicePosition: 0,
            AudioClockPosition: 0,
            FrameCount: frameCount,
            SampleRate: sampleRate,
            ChannelCount: channels,
            IsSilent: isSilent,
            HasDiscontinuity: hasDiscontinuity);
}
