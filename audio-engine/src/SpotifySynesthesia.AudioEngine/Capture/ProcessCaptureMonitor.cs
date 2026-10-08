using System.ComponentModel;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;

namespace SpotifySynesthesia.AudioEngine.Capture;

public sealed record ProcessCaptureMonitorOptions(
    TimeSpan TargetSearchInterval,
    TimeSpan SessionPollInterval,
    TimeSpan RestartBackoff)
{
    public static ProcessCaptureMonitorOptions Default { get; } =
        new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
}

public enum ProcessCaptureMonitorEventKind
{
    WaitingForTarget,
    CaptureStarted,
    Heartbeat,
    TargetExited,
    CaptureStopped,
    Restarting,
}

public sealed record ProcessCaptureMonitorEvent(
    ProcessCaptureMonitorEventKind Kind,
    int? ProcessId,
    Exception? Error = null);

public sealed class ProcessCaptureMonitor
{
    // AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_SERVICE_NOT_RUNNING:
    // Microsoft guidance is to release and reactivate the audio client after these failures.
    private const int DeviceInvalidatedHResult = unchecked((int)0x88890004);
    private const int ResourcesInvalidatedHResult = unchecked((int)0x88890026);
    private const int ServiceNotRunningHResult = unchecked((int)0x88890010);

    private readonly IAudioCaptureSession _captureSession;
    private readonly Func<int?> _resolveProcessId;
    private readonly Func<int, bool> _isProcessAlive;
    private readonly ProcessCaptureMonitorOptions _options;
    private readonly Func<TimeSpan, CancellationToken, Task> _delayAsync;
    private int _running;

    public ProcessCaptureMonitor(
        IAudioCaptureSession captureSession,
        Func<int?> resolveProcessId,
        Func<int, bool> isProcessAlive,
        ProcessCaptureMonitorOptions? options = null,
        Func<TimeSpan, CancellationToken, Task>? delayAsync = null)
    {
        ArgumentNullException.ThrowIfNull(captureSession);
        ArgumentNullException.ThrowIfNull(resolveProcessId);
        ArgumentNullException.ThrowIfNull(isProcessAlive);
        options ??= ProcessCaptureMonitorOptions.Default;
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(options.TargetSearchInterval, TimeSpan.Zero, nameof(options));
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(options.SessionPollInterval, TimeSpan.Zero, nameof(options));
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(options.RestartBackoff, TimeSpan.Zero, nameof(options));

        _captureSession = captureSession;
        _resolveProcessId = resolveProcessId;
        _isProcessAlive = isProcessAlive;
        _options = options;
        _delayAsync = delayAsync ?? ((delay, token) => Task.Delay(delay, token));
    }

    // Raised from the monitor task only, never from the capture callback thread.
    public event Action<ProcessCaptureMonitorEvent>? StatusChanged;

    public async Task RunAsync(
        bool waitForTargetRestart,
        CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref _running, 1) != 0)
        {
            throw new InvalidOperationException("The capture monitor is already running.");
        }

        try
        {
            while (await FindTargetAsync(waitForTargetRestart, cancellationToken).ConfigureAwait(false) is int processId)
            {
                if (await CaptureUntilStoppedAsync(processId, cancellationToken).ConfigureAwait(false))
                {
                    await _delayAsync(_options.RestartBackoff, cancellationToken).ConfigureAwait(false);
                    cancellationToken.ThrowIfCancellationRequested();
                    Report(ProcessCaptureMonitorEventKind.Restarting, processId);
                }
                else if (!waitForTargetRestart)
                {
                    return;
                }
            }
        }
        finally
        {
            Volatile.Write(ref _running, 0);
        }
    }

    private async Task<int?> FindTargetAsync(bool waitForTarget, CancellationToken cancellationToken)
    {
        bool reportedWaiting = false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_resolveProcessId() is int processId)
            {
                // Cancellation can land while the resolver runs; honor it before any session is attempted.
                cancellationToken.ThrowIfCancellationRequested();
                return processId;
            }

            if (!waitForTarget)
            {
                return null;
            }

            if (!reportedWaiting)
            {
                Report(ProcessCaptureMonitorEventKind.WaitingForTarget, processId: null);
                reportedWaiting = true;
            }

            await _delayAsync(_options.TargetSearchInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    // Returns true to restart after backoff, false when the target process exited.
    private async Task<bool> CaptureUntilStoppedAsync(int processId, CancellationToken cancellationToken)
    {
        TaskCompletionSource<ProcessLoopbackCaptureStopped> stopped =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        // Runs on the capture thread: match the session and signal, nothing else.
        Action<ProcessLoopbackCaptureStopped> onStopped = stoppedEvent =>
        {
            if (stoppedEvent.TargetProcessId == processId)
            {
                stopped.TrySetResult(stoppedEvent);
            }
        };

        _captureSession.CaptureStopped += onStopped;
        try
        {
            try
            {
                await _captureSession.StartCaptureAsync(processId, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (IsStartupProcessRace(exception) && !_isProcessAlive(processId))
                {
                    // The target vanished mid-startup: that is an exit, not a device fault to retry.
                    Report(ProcessCaptureMonitorEventKind.TargetExited, processId);
                    return false;
                }

                if (!IsTransientAudioFailure(exception))
                {
                    throw;
                }

                Report(ProcessCaptureMonitorEventKind.CaptureStopped, processId, exception);
                return true;
            }

            Report(ProcessCaptureMonitorEventKind.CaptureStarted, processId);
            ProcessLoopbackCaptureStopped? notice =
                await ObserveAsync(processId, stopped.Task, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (notice is null || !_isProcessAlive(processId))
            {
                Report(ProcessCaptureMonitorEventKind.TargetExited, processId);
                return false;
            }

            Report(ProcessCaptureMonitorEventKind.CaptureStopped, processId, notice.Error);
            if (notice.Error is not null && !IsTransientAudioFailure(notice.Error))
            {
                ExceptionDispatchInfo.Throw(notice.Error);
            }

            return true;
        }
        finally
        {
            _captureSession.CaptureStopped -= onStopped;
            await _captureSession.StopCaptureAsync(CancellationToken.None).ConfigureAwait(false);
        }
    }

    // Returns the stop notice, or null when a liveness poll finds the target gone.
    private async Task<ProcessLoopbackCaptureStopped?> ObserveAsync(
        int processId,
        Task<ProcessLoopbackCaptureStopped> stopped,
        CancellationToken cancellationToken)
    {
        while (!stopped.IsCompleted)
        {
            using CancellationTokenSource pollCancellation =
                CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Task poll = _delayAsync(_options.SessionPollInterval, pollCancellation.Token);
            if (await Task.WhenAny(stopped, poll).ConfigureAwait(false) != poll)
            {
                // Retire the losing poll so no timer outlives this session.
                await pollCancellation.CancelAsync().ConfigureAwait(false);
                await poll.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                break;
            }

            await poll.ConfigureAwait(false);
            if (!_isProcessAlive(processId))
            {
                return null;
            }

            Report(ProcessCaptureMonitorEventKind.Heartbeat, processId);
        }

        return await stopped.ConfigureAwait(false);
    }

    // Exceptions the Process APIs throw when the target dies between resolution and activation:
    // Process.GetProcessById throws ArgumentException for a PID that is no longer running, opening
    // the handle throws Win32Exception, and HasExited/Handle on an exited or unassociated Process
    // throw InvalidOperationException. ObjectDisposedException derives from InvalidOperationException
    // but signals our own use-after-dispose bug, so it is excluded. A match counts as an exit only
    // when the liveness probe confirms the target is gone; otherwise the caller rethrows it.
    private static bool IsStartupProcessRace(Exception exception) =>
        exception is (ArgumentException or Win32Exception or InvalidOperationException)
            and not ObjectDisposedException;

    private static bool IsTransientAudioFailure(Exception exception) =>
        exception is COMException
        {
            HResult: DeviceInvalidatedHResult or ResourcesInvalidatedHResult or ServiceNotRunningHResult,
        };

    private void Report(ProcessCaptureMonitorEventKind kind, int? processId, Exception? error = null) =>
        StatusChanged?.Invoke(new ProcessCaptureMonitorEvent(kind, processId, error));
}
