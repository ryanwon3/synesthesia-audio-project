using SpotifySynesthesia.AudioEngine.Capture;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.Desktop;

internal sealed class SpotifyCaptureMonitor(AudioEngineRuntime runtime)
{
    private readonly ProcessCaptureMonitor _monitor = new(
        runtime,
        () => ProcessTargetLocator.FindOldestExactMatch("Spotify")?.ProcessId,
        ProcessTargetLocator.IsAlive);

    public Task RunAsync(CancellationToken cancellationToken) =>
        _monitor.RunAsync(waitForTargetRestart: true, cancellationToken);
}
