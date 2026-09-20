namespace SpotifySynesthesia.AudioEngine.Capture;

public interface IProcessLoopbackCapture : IAsyncDisposable
{
    event Action<ProcessLoopbackCaptureState>? StateChanged;

    event Action<ProcessLoopbackCaptureStopped>? CaptureStopped;

    ProcessLoopbackCaptureState State { get; }

    ProcessLoopbackCaptureOptions? ActiveOptions { get; }

    Task StartAsync(
        ProcessLoopbackCaptureOptions options,
        IAudioSampleSink sink,
        CancellationToken cancellationToken = default);

    Task StopAsync(CancellationToken cancellationToken = default);
}
