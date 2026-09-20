using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class ProcessLoopbackCaptureOptionsTests
{
    [Fact]
    public void DefaultsDescribeStereoFloatAnalysisStream()
    {
        ProcessLoopbackCaptureOptions options = new(targetProcessId: 42);

        Assert.Equal(42, options.TargetProcessId);
        Assert.True(options.IncludeProcessTree);
        Assert.Equal(48_000, options.SampleRate);
        Assert.Equal(2, options.ChannelCount);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void RejectsInvalidProcessIds(int processId)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new ProcessLoopbackCaptureOptions(processId));
    }
}
