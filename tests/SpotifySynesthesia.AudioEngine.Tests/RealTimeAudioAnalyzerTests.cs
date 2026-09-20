using System.Diagnostics;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class RealTimeAudioAnalyzerTests
{
    [Fact]
    public void DetectsRmsMidEnergyAndAChromaFor440Hz()
    {
        List<AudioFrame> frames = AnalyzeSine(440d, leftAmplitude: 0.2f, rightAmplitude: 0.2f);
        AudioFrame frame = frames[^1];

        Assert.InRange(frame.Rms, 0.13d, 0.15d);
        Assert.True(frame.MidEnergy > frame.BassEnergy);
        Assert.True(frame.MidEnergy > frame.TrebleEnergy);
        Assert.Equal(PitchClass.A, frame.DominantPitchClass);
        Assert.True(frame.Chroma.A > frame.Chroma.C);
        Assert.InRange(frame.ChromaConfidence, 0d, 1d);
    }

    [Fact]
    public void SeparatesBassMidAndTrebleBands()
    {
        AudioFrame bass = AnalyzeSine(100d, 0.2f, 0.2f)[^1];
        AudioFrame mid = AnalyzeSine(1_000d, 0.2f, 0.2f)[^1];
        AudioFrame treble = AnalyzeSine(8_000d, 0.2f, 0.2f)[^1];

        Assert.True(bass.BassEnergy > bass.MidEnergy);
        Assert.True(mid.MidEnergy > mid.BassEnergy);
        Assert.True(mid.MidEnergy > mid.TrebleEnergy);
        Assert.True(treble.TrebleEnergy > treble.MidEnergy);
        Assert.NotNull(bass.Bass); Assert.NotNull(mid.Mid); Assert.NotNull(treble.Treble);
        Assert.True(mid.Mid.ChromaConfidence > 0.3);
        Assert.InRange(treble.Bass!.Attack, 0, 0.005);
        Assert.InRange(bass.Bass.Attack, 0, 0.05); // steady tone, not a train of attacks
    }

    [Fact]
    public void MeasuresStereoBalanceAndWidth()
    {
        AudioFrame stereo = AnalyzeSine(440d, 0.2f, 0.2f)[^1];
        AudioFrame leftOnly = AnalyzeSine(440d, 0.2f, 0f)[^1];
        AudioFrame rightOnly = AnalyzeSine(440d, 0f, 0.2f)[^1];

        Assert.InRange(stereo.StereoBalance, 0.49d, 0.51d);
        Assert.InRange(stereo.StereoWidth, 0d, 0.01d);
        Assert.InRange(leftOnly.StereoBalance, 0d, 0.01d);
        Assert.InRange(rightOnly.StereoBalance, 0.99d, 1d);
        Assert.True(leftOnly.StereoWidth > 0.45d);
        Assert.True(rightOnly.StereoWidth > 0.45d);
    }

    [Fact]
    public void ToneAttackProducesFluxAndOnset()
    {
        RealTimeAudioAnalyzer analyzer = new();
        List<AudioFrame> frames = [];
        analyzer.FrameProduced += frames.Add;

        FeedSignal(analyzer, seconds: 0.5d, (_, _) => (0f, 0f));
        int framesBeforeTone = frames.Count;
        FeedSignal(analyzer, seconds: 0.5d, (frame, sampleRate) =>
        {
            float sample = 0.2f * (float)Math.Sin(2d * Math.PI * 440d * frame / sampleRate);
            return (sample, sample);
        });

        Assert.True(frames.Count > framesBeforeTone);
        double maximumFlux = frames.Skip(framesBeforeTone).Max(frame => frame.SpectralFlux);
        double maximumOnset = frames.Skip(framesBeforeTone).Max(frame => frame.OnsetStrength);
        Assert.True(maximumFlux > 0.01d, $"Maximum spectral flux was {maximumFlux:F6}.");
        Assert.True(maximumOnset > 0.02d, $"Maximum onset strength was {maximumOnset:F6}.");
    }

    [Fact]
    public void SilenceProducesFiniteNormalizedFrames()
    {
        RealTimeAudioAnalyzer analyzer = new();
        List<AudioFrame> frames = [];
        analyzer.FrameProduced += frames.Add;

        FeedSignal(analyzer, seconds: 0.5d, (_, _) => (float.NaN, float.PositiveInfinity));

        Assert.NotEmpty(frames);
        foreach (AudioFrame frame in frames)
        {
            AssertNormalized(frame.Rms);
            AssertNormalized(frame.BassEnergy);
            AssertNormalized(frame.MidEnergy);
            AssertNormalized(frame.TrebleEnergy);
            AssertNormalized(frame.SpectralCentroid);
            AssertNormalized(frame.SpectralFlux);
            AssertNormalized(frame.OnsetStrength);
            AssertNormalized(frame.StereoBalance);
            AssertNormalized(frame.StereoWidth);
            AssertNormalized(frame.ChromaConfidence);
            Assert.Null(frame.DominantPitchClass);
        }
    }

    [Fact]
    public void EmitsApproximatelyThirtyFramesPerSecondAfterWarmup()
    {
        List<AudioFrame> frames = AnalyzeSine(440d, 0.2f, 0.2f, seconds: 2d);

        Assert.InRange(frames.Count, 55, 60);
        Assert.Equal(Enumerable.Range(1, frames.Count).Select(value => (long)value), frames.Select(frame => frame.Sequence));
    }

    private static List<AudioFrame> AnalyzeSine(
        double frequency,
        float leftAmplitude,
        float rightAmplitude,
        double seconds = 1d)
    {
        RealTimeAudioAnalyzer analyzer = new();
        List<AudioFrame> frames = [];
        analyzer.FrameProduced += frames.Add;
        FeedSignal(analyzer, seconds, (frame, sampleRate) =>
        {
            float unit = (float)Math.Sin(2d * Math.PI * frequency * frame / sampleRate);
            return (unit * leftAmplitude, unit * rightAmplitude);
        });
        return frames;
    }

    private static void FeedSignal(
        RealTimeAudioAnalyzer analyzer,
        double seconds,
        Func<long, int, (float Left, float Right)> sampleFactory)
    {
        const int packetFrames = 480;
        int sampleRate = analyzer.Options.SampleRate;
        int totalFrames = (int)Math.Round(seconds * sampleRate);
        long absoluteFrame = 0;

        while (absoluteFrame < totalFrames)
        {
            int frameCount = Math.Min(packetFrames, totalFrames - (int)absoluteFrame);
            float[] samples = new float[frameCount * 2];

            for (int frame = 0; frame < frameCount; frame++)
            {
                (float left, float right) = sampleFactory(absoluteFrame + frame, sampleRate);
                samples[frame * 2] = left;
                samples[(frame * 2) + 1] = right;
            }

            AudioPacketInfo packet = new(
                CaptureTimestamp: Stopwatch.GetTimestamp(),
                DevicePosition: absoluteFrame,
                AudioClockPosition: absoluteFrame,
                FrameCount: frameCount,
                SampleRate: sampleRate,
                ChannelCount: 2,
                IsSilent: false,
                HasDiscontinuity: false);
            analyzer.Write(samples, in packet);
            absoluteFrame += frameCount;
        }
    }

    private static void AssertNormalized(double value)
    {
        Assert.True(double.IsFinite(value));
        Assert.InRange(value, 0d, 1d);
    }
}
