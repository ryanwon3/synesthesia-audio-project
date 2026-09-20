using System.Numerics;

namespace SpotifySynesthesia.AudioEngine.Analysis;

public sealed record AudioAnalyzerOptions
{
    public AudioAnalyzerOptions(
        int sampleRate = 48_000,
        int channelCount = 2,
        int framesPerSecond = 30,
        int fftSize = 4096,
        double bassUpperHz = 250,
        double midUpperHz = 4000,
        double layerChromaUpperHz = 12000)
    {
        if (sampleRate < 8_000 || sampleRate > 192_000)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleRate));
        }

        if (channelCount is < 1 or > 2)
        {
            throw new ArgumentOutOfRangeException(nameof(channelCount));
        }

        if (framesPerSecond is < 10 or > 120)
        {
            throw new ArgumentOutOfRangeException(nameof(framesPerSecond));
        }

        if (fftSize < 1024 || fftSize > 32768 || !BitOperations.IsPow2(checked((uint)fftSize)))
        {
            throw new ArgumentOutOfRangeException(nameof(fftSize), "FFT size must be a power of two from 1024 to 32768.");
        }

        SampleRate = sampleRate;
        if (!double.IsFinite(bassUpperHz) || !double.IsFinite(midUpperHz) ||
            bassUpperHz < 50 || midUpperHz <= bassUpperHz || midUpperHz > sampleRate * 0.5)
            throw new ArgumentOutOfRangeException(nameof(bassUpperHz), "Bands must be ordered within the sample-rate range.");
        if (!double.IsFinite(layerChromaUpperHz) || layerChromaUpperHz < midUpperHz)
            throw new ArgumentOutOfRangeException(nameof(layerChromaUpperHz));
        BassUpperHz = bassUpperHz; MidUpperHz = midUpperHz; LayerChromaUpperHz = layerChromaUpperHz;
        ChannelCount = channelCount;
        FramesPerSecond = framesPerSecond;
        FftSize = fftSize;
    }

    public int SampleRate { get; }

    public int ChannelCount { get; }

    public int FramesPerSecond { get; }

    public int FftSize { get; }
    public double BassUpperHz { get; }
    public double MidUpperHz { get; }
    public double LayerChromaUpperHz { get; }

    public int HopSize => Math.Max(1, SampleRate / FramesPerSecond);
}
