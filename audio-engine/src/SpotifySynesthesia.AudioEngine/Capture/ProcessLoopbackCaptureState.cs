namespace SpotifySynesthesia.AudioEngine.Capture;

public enum ProcessLoopbackCaptureState
{
    Stopped,
    Activating,
    Capturing,
    Stopping,
    Faulted,
}

public sealed record ProcessLoopbackCaptureStopped(
    int TargetProcessId,
    Exception? Error,
    DateTimeOffset StoppedAtUtc);
