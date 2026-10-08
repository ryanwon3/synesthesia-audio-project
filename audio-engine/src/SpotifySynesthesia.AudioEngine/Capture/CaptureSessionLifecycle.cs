using System.Runtime.InteropServices;

namespace SpotifySynesthesia.AudioEngine.Capture;

internal static class CaptureSessionLifecycle
{
    // The worker is created only after the audio stream starts, so a failed start leaves no orphan.
    internal static void StartAudioThenWorker(Action startAudio, Action startWorker)
    {
        ArgumentNullException.ThrowIfNull(startAudio);
        ArgumentNullException.ThrowIfNull(startWorker);
        startAudio();
        startWorker();
    }

    // Always cleans up. A COM stop failure is kept only when no earlier error explains the stop;
    // any other exception propagates after cleanup.
    internal static Exception? StopAudioAndCleanup(Action stopAudio, Action cleanup, Exception? priorError)
    {
        ArgumentNullException.ThrowIfNull(stopAudio);
        ArgumentNullException.ThrowIfNull(cleanup);
        try
        {
            stopAudio();
        }
        catch (COMException error)
        {
            priorError ??= error;
        }
        finally
        {
            cleanup();
        }

        return priorError;
    }
}
