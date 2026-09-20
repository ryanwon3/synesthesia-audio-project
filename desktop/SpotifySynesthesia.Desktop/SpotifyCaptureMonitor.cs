using System.Diagnostics;
using SpotifySynesthesia.AudioEngine.Capture;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.Desktop;

internal sealed class SpotifyCaptureMonitor(AudioEngineRuntime runtime)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            ProcessTarget? target = ProcessTargetLocator.FindOldestExactMatch("Spotify");
            if (target is null)
            {
                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
                continue;
            }

            try
            {
                await runtime.StartCaptureAsync(target.ProcessId, cancellationToken).ConfigureAwait(false);
                await WaitForExitAsync(target.ProcessId, cancellationToken).ConfigureAwait(false);
                await runtime.StopCaptureAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception)
            {
                if (runtime.CaptureState is ProcessLoopbackCaptureState.Capturing)
                {
                    await runtime.StopCaptureAsync(CancellationToken.None).ConfigureAwait(false);
                }

                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static async Task WaitForExitAsync(int processId, CancellationToken cancellationToken)
    {
        while (IsAlive(processId))
        {
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
        }
    }

    private static bool IsAlive(int processId)
    {
        try
        {
            using Process process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
