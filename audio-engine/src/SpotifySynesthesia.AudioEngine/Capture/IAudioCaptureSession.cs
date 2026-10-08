namespace SpotifySynesthesia.AudioEngine.Capture;

public interface IAudioCaptureSession
{
    event Action<ProcessLoopbackCaptureStopped>? CaptureStopped;

    ProcessLoopbackCaptureState CaptureState { get; }

    Task StartCaptureAsync(int processId, CancellationToken cancellationToken = default);

    Task StopCaptureAsync(CancellationToken cancellationToken = default);
}
