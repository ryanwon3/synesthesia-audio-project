using SpotifySynesthesia.TestTonePlayer.Signals;

namespace SpotifySynesthesia.TestTonePlayer.Tests;

public sealed class TestSignalSampleProviderTests
{
    private static readonly TimeSpan NoFade = TimeSpan.Zero;

    [Theory]
    [InlineData(TestSignalKind.Sine100Hz, 100)]
    [InlineData(TestSignalKind.Sine440Hz, 440)]
    [InlineData(TestSignalKind.Sine1000Hz, 1000)]
    public void SineSignalsProduceExpectedFrequency(TestSignalKind signal, int expectedFrequency)
    {
        TestSignalSampleProvider provider = CreateProvider(signal, ChannelMode.Stereo, fadeDuration: NoFade);

        float[] samples = ReadFrames(provider, TestSignalSettings.DefaultSampleRate);
        int positiveCrossings = CountPositiveCrossings(samples);

        Assert.InRange(positiveCrossings, expectedFrequency - 1, expectedFrequency + 1);
    }

    [Fact]
    public void GeneratedSamplesAreFiniteAndBounded()
    {
        foreach (TestSignalKind signal in Enum.GetValues<TestSignalKind>())
        {
            TestSignalSampleProvider provider = CreateProvider(
                signal,
                ChannelMode.Stereo,
                level: TestSignalSettings.MaximumLevel);

            float[] samples = ReadFrames(provider, TestSignalSettings.DefaultSampleRate * 2);

            Assert.All(samples, sample =>
            {
                Assert.True(float.IsFinite(sample));
                Assert.InRange(sample, -TestSignalSettings.MaximumLevel, TestSignalSettings.MaximumLevel);
            });
        }
    }

    [Fact]
    public void WhiteNoiseHasNonZeroVarianceAndNearZeroMean()
    {
        TestSignalSampleProvider provider = CreateProvider(
            TestSignalKind.WhiteNoise,
            ChannelMode.Stereo,
            level: 0.25f,
            fadeDuration: NoFade,
            randomSeed: 42);

        float[] interleaved = ReadFrames(provider, 48_000);
        double[] left = GetLeftChannel(interleaved).Select(sample => (double)sample).ToArray();
        double mean = left.Average();
        double variance = left.Average(sample => Math.Pow(sample - mean, 2d));

        Assert.InRange(mean, -0.01d, 0.01d);
        Assert.True(variance > 0.01d, $"Expected nonzero noise variance, got {variance}.");
    }

    [Fact]
    public void PulseIsActiveForOneHundredMillisecondsEachSecond()
    {
        TestSignalSampleProvider provider = CreateProvider(
            TestSignalKind.Pulse440Hz,
            ChannelMode.Stereo,
            level: 0.25f,
            fadeDuration: NoFade);

        float[] left = GetLeftChannel(ReadFrames(provider, TestSignalSettings.DefaultSampleRate));
        int onFrameCount = (int)(TestSignalSettings.DefaultSampleRate * 0.1d);

        Assert.Contains(left[..onFrameCount], sample => Math.Abs(sample) > 0.1f);
        Assert.All(left[onFrameCount..], sample => Assert.Equal(0f, sample));
    }

    [Theory]
    [InlineData(ChannelMode.Stereo)]
    [InlineData(ChannelMode.LeftOnly)]
    [InlineData(ChannelMode.RightOnly)]
    public void ChannelModesRouteSamplesCorrectly(ChannelMode channelMode)
    {
        TestSignalSampleProvider provider = CreateProvider(
            TestSignalKind.Sine440Hz,
            channelMode,
            level: 0.25f,
            fadeDuration: NoFade);

        float[] samples = ReadFrames(provider, 2_000);
        float[] left = GetLeftChannel(samples);
        float[] right = GetRightChannel(samples);

        switch (channelMode)
        {
            case ChannelMode.Stereo:
                Assert.Equal(left, right);
                break;
            case ChannelMode.LeftOnly:
                Assert.Contains(left, sample => Math.Abs(sample) > 0.1f);
                Assert.All(right, sample => Assert.Equal(0f, sample));
                break;
            case ChannelMode.RightOnly:
                Assert.All(left, sample => Assert.Equal(0f, sample));
                Assert.Contains(right, sample => Math.Abs(sample) > 0.1f);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(channelMode), channelMode, null);
        }
    }

    [Fact]
    public void FadeInUsesTenMillisecondEnvelope()
    {
        TestSignalSampleProvider baseline = CreateProvider(
            TestSignalKind.Sine440Hz,
            ChannelMode.Stereo,
            level: 0.25f,
            fadeDuration: NoFade);
        TestSignalSampleProvider faded = CreateProvider(
            TestSignalKind.Sine440Hz,
            ChannelMode.Stereo,
            level: 0.25f);

        float[] baselineLeft = GetLeftChannel(ReadFrames(baseline, 480));
        float[] fadedLeft = GetLeftChannel(ReadFrames(faded, 480));

        Assert.Equal(2f / 480f, GetRatio(fadedLeft[1], baselineLeft[1]), precision: 4);
        Assert.Equal(241f / 480f, GetRatio(fadedLeft[240], baselineLeft[240]), precision: 4);
        Assert.Equal(1f, GetRatio(fadedLeft[479], baselineLeft[479]), precision: 4);
    }

    [Fact]
    public void FadeOutReachesSilenceAfterTenMilliseconds()
    {
        TestSignalSampleProvider baseline = CreateProvider(
            TestSignalKind.Sine440Hz,
            ChannelMode.Stereo,
            level: 0.25f,
            fadeDuration: NoFade);
        TestSignalSampleProvider faded = CreateProvider(
            TestSignalKind.Sine440Hz,
            ChannelMode.Stereo,
            level: 0.25f);

        _ = ReadFrames(baseline, 480);
        _ = ReadFrames(faded, 480);
        faded.BeginFadeOut();

        float[] baselineLeft = GetLeftChannel(ReadFrames(baseline, 480));
        float[] fadedLeft = GetLeftChannel(ReadFrames(faded, 480));

        Assert.Equal(1f, GetRatio(fadedLeft[0], baselineLeft[0]), precision: 4);
        Assert.Equal(0.5f, GetRatio(fadedLeft[240], baselineLeft[240]), precision: 4);
        Assert.Equal(1f / 480f, GetRatio(fadedLeft[479], baselineLeft[479]), precision: 4);
        Assert.True(faded.IsFadeOutComplete);

        float[] silence = ReadFrames(faded, 32);
        Assert.All(silence, sample => Assert.Equal(0f, sample));
    }

    [Fact]
    public void SettingsRejectNonFiniteOrUnsafeLevels()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new TestSignalSettings(TestSignalKind.Sine440Hz, ChannelMode.Stereo, float.NaN));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new TestSignalSettings(TestSignalKind.Sine440Hz, ChannelMode.Stereo, 0.51f));
    }

    private static TestSignalSampleProvider CreateProvider(
        TestSignalKind signal,
        ChannelMode channelMode,
        float level = 0.2f,
        TimeSpan? fadeDuration = null,
        int? randomSeed = null)
    {
        TestSignalSettings settings = new(
            signal,
            channelMode,
            level,
            TestSignalSettings.DefaultSampleRate,
            fadeDuration);
        return new TestSignalSampleProvider(settings, randomSeed);
    }

    private static float[] ReadFrames(TestSignalSampleProvider provider, int frameCount)
    {
        float[] buffer = new float[frameCount * 2];
        int read = provider.Read(buffer, 0, buffer.Length);
        Assert.Equal(buffer.Length, read);
        return buffer;
    }

    private static int CountPositiveCrossings(float[] interleaved)
    {
        float[] left = GetLeftChannel(interleaved);
        int crossings = 0;

        for (int index = 1; index < left.Length; index++)
        {
            if (left[index - 1] <= 0f && left[index] > 0f)
            {
                crossings++;
            }
        }

        return crossings;
    }

    private static float[] GetLeftChannel(float[] interleaved) =>
        interleaved.Where((_, index) => index % 2 == 0).ToArray();

    private static float[] GetRightChannel(float[] interleaved) =>
        interleaved.Where((_, index) => index % 2 == 1).ToArray();

    private static float GetRatio(float actual, float baseline)
    {
        Assert.True(Math.Abs(baseline) > 0.0001f, "The selected baseline sample must be nonzero.");
        return actual / baseline;
    }
}
