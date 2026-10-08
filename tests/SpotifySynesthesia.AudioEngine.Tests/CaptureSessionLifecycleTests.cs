using System.Runtime.InteropServices;
using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class CaptureSessionLifecycleTests
{
    private const int DeviceInvalidatedHResult = unchecked((int)0x88890004);
    private const int NotInitializedHResult = unchecked((int)0x88890001);

    [Fact]
    public void StartFailureDoesNotCreateWorker()
    {
        COMException failure = ComFailure(DeviceInvalidatedHResult);
        List<string> timeline = [];

        COMException thrown = Assert.Throws<COMException>(() => CaptureSessionLifecycle.StartAudioThenWorker(
            () =>
            {
                timeline.Add("audio");
                throw failure;
            },
            () => timeline.Add("worker")));

        Assert.Same(failure, thrown);
        Assert.Equal("audio", string.Join('|', timeline));
    }

    [Fact]
    public void StartsAudioBeforeWorker()
    {
        List<string> timeline = [];

        CaptureSessionLifecycle.StartAudioThenWorker(
            () => timeline.Add("audio"),
            () => timeline.Add("worker"));

        Assert.Equal("audio|worker", string.Join('|', timeline));
    }

    [Fact]
    public void StopFailurePreservesOriginalErrorAndAlwaysCleans()
    {
        COMException original = ComFailure(DeviceInvalidatedHResult);
        COMException stopFailure = ComFailure(NotInitializedHResult);
        List<string> timeline = [];

        Exception? result = CaptureSessionLifecycle.StopAudioAndCleanup(
            () =>
            {
                timeline.Add("stop");
                throw stopFailure;
            },
            () => timeline.Add("cleanup"),
            original);

        Assert.Equal("stop|cleanup", string.Join('|', timeline));
        Assert.Same(original, result);
    }

    [Fact]
    public void StopFailureWithoutPriorErrorIsRetained()
    {
        COMException stopFailure = ComFailure(DeviceInvalidatedHResult);
        List<string> timeline = [];

        Exception? result = CaptureSessionLifecycle.StopAudioAndCleanup(
            () =>
            {
                timeline.Add("stop");
                throw stopFailure;
            },
            () => timeline.Add("cleanup"),
            priorError: null);

        Assert.Equal("stop|cleanup", string.Join('|', timeline));
        Assert.Same(stopFailure, result);
    }

    [Fact]
    public void UnexpectedStopFailureStillCleansAndPropagates()
    {
        InvalidOperationException failure = new("Audio client stop failed unexpectedly.");
        List<string> timeline = [];

        InvalidOperationException thrown = Assert.Throws<InvalidOperationException>(
            () => CaptureSessionLifecycle.StopAudioAndCleanup(
                () =>
                {
                    timeline.Add("stop");
                    throw failure;
                },
                () => timeline.Add("cleanup"),
                priorError: null));

        Assert.Same(failure, thrown);
        Assert.Equal("stop|cleanup", string.Join('|', timeline));
    }

    private static COMException ComFailure(int hresult) =>
        (COMException)Marshal.GetExceptionForHR(hresult, new IntPtr(-1))!;
}
