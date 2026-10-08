using System.Collections.Concurrent;
using System.Globalization;
using System.Runtime.InteropServices;
using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class ProcessCaptureMonitorTests
{
    private const int DeviceInvalidatedHResult = unchecked((int)0x88890004);
    private static readonly TimeSpan HangSafety = TimeSpan.FromSeconds(10);
    private static readonly ProcessCaptureMonitorOptions Options = new(
        TargetSearchInterval: TimeSpan.FromSeconds(11),
        SessionPollInterval: TimeSpan.FromSeconds(13),
        RestartBackoff: TimeSpan.FromSeconds(17));

    [Theory]
    [InlineData(0, 1, 1)]
    [InlineData(1, 0, 1)]
    [InlineData(1, 1, 0)]
    [InlineData(-1, 1, 1)]
    [InlineData(1, -1, 1)]
    [InlineData(1, 1, -1)]
    public void RejectsNonPositiveIntervals(int searchSeconds, int pollSeconds, int backoffSeconds)
    {
        ProcessCaptureMonitorOptions options = new(
            TimeSpan.FromSeconds(searchSeconds),
            TimeSpan.FromSeconds(pollSeconds),
            TimeSpan.FromSeconds(backoffSeconds));

        Assert.Throws<ArgumentOutOfRangeException>(
            () => new ProcessCaptureMonitor(new FakeAudioCaptureSession(), () => 101, _ => true, options));
    }

    [Fact]
    public async Task DoesNotMissCaptureStoppedRaisedDuringStart()
    {
        Harness h = new(target: 101);
        int handlersDuringFirstStart = -1;
        h.Session.StartBehavior = ordinal =>
        {
            if (ordinal == 1)
            {
                handlersDuringFirstStart = h.Session.Raise(101, DeviceInvalidated());
            }

            return Task.CompletedTask;
        };
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await Observe(h.Session.Starts.Nth(1), run, "the first start");
        Assert.Equal(1, handlersDuringFirstStart);
        DelayCall backoff = await Observe(
            h.Delays.For(Options.RestartBackoff).Nth(1), run, "the restart backoff", h.Session.Starts.Nth(2));
        backoff.Elapse();
        await Observe(h.Session.Starts.Nth(2), run, "the restart");

        await cts.CancelAsync();
        await AssertCanceledAsync(run);
        Assert.Equal(2, h.Session.Starts.Count);
        Assert.Equal(0, h.Session.HandlerCount);
    }

    [Fact]
    public async Task IgnoresCaptureStoppedForDifferentProcess()
    {
        Harness h = new(target: 101);
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await Observe(h.Session.Starts.Nth(1), run, "the first start");
        DelayCall firstPoll = await Observe(h.Delays.For(Options.SessionPollInterval).Nth(1), run, "the first liveness poll");
        Assert.Equal(1, h.Session.Raise(202, error: null));
        firstPoll.Elapse();
        await Observe(
            h.Delays.For(Options.SessionPollInterval).Nth(2),
            run,
            "a second liveness poll",
            h.Session.Stops.Nth(1),
            h.Delays.For(Options.RestartBackoff).Nth(1));
        Assert.Equal("start:101", h.Session.Timeline);

        await cts.CancelAsync();
        await AssertCanceledAsync(run);
        Assert.Equal("start:101|stop", h.Session.Timeline);
        Assert.Equal(0, h.Session.HandlerCount);
    }

    [Fact]
    public async Task RestartsAfterFaultUsingConfiguredBackoff()
    {
        Harness h = new(target: 101);
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await Observe(h.Session.Starts.Nth(1), run, "the first start");
        h.Session.Raise(101, DeviceInvalidated());
        DelayCall backoff = await Observe(
            h.Delays.For(Options.RestartBackoff).Nth(1), run, "the restart backoff", h.Session.Starts.Nth(2));
        Assert.True(backoff.Token.CanBeCanceled);
        Assert.Equal(1, h.Session.Starts.Count);
        backoff.Elapse();
        await Observe(h.Session.Starts.Nth(2), run, "the restart");
        Assert.Equal("start:101|stop|start:101", h.Session.Timeline);
        Assert.Equal(1, h.Delays.For(Options.RestartBackoff).Count);

        await cts.CancelAsync();
        await AssertCanceledAsync(run);
        Assert.All(h.Session.Stops.Values, token => Assert.False(token.CanBeCanceled));
        Assert.Equal(0, h.Session.HandlerCount);
    }

    [Fact]
    public async Task CancellationStopsCaptureWithoutRestart()
    {
        Harness h = new(target: 101);
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await Observe(h.Session.Starts.Nth(1), run, "the first start");
        await Observe(h.Delays.For(Options.SessionPollInterval).Nth(1), run, "the first liveness poll");
        await cts.CancelAsync();

        await AssertCanceledAsync(run);
        Assert.Equal("start:101|stop", h.Session.Timeline);
        CancellationToken stopToken = Assert.Single(h.Session.Stops.Values);
        Assert.False(stopToken.CanBeCanceled);
        Assert.Equal(0, h.Session.HandlerCount);
        Assert.Equal(0, h.Delays.For(Options.RestartBackoff).Count);
    }

    [Fact]
    public async Task WaitsForReplacementAfterTargetExit()
    {
        Harness h = new(target: 101);
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await Observe(h.Session.Starts.Nth(1), run, "the first start");
        DelayCall poll = await Observe(h.Delays.For(Options.SessionPollInterval).Nth(1), run, "the first liveness poll");
        h.Exit(101);
        poll.Elapse();
        DelayCall search = await Observe(
            h.Delays.For(Options.TargetSearchInterval).Nth(1),
            run,
            "the target search wait",
            h.Session.Starts.Nth(2),
            h.Delays.For(Options.RestartBackoff).Nth(1));
        Assert.Equal("start:101|stop", h.Session.Timeline);
        h.SetTarget(303);
        search.Elapse();
        await Observe(h.Session.Starts.Nth(2), run, "the replacement start");
        Assert.Equal("start:101|stop|start:303", h.Session.Timeline);

        await cts.CancelAsync();
        await AssertCanceledAsync(run);
        Assert.All(h.Session.Stops.Values, token => Assert.False(token.CanBeCanceled));
        Assert.Equal(0, h.Session.HandlerCount);
    }

    [Fact]
    public async Task ReturnsAfterFixedTargetExit()
    {
        Harness h = new(target: 101);
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: false, cts.Token);

        await Observe(h.Session.Starts.Nth(1), run, "the first start");
        h.Exit(101);
        h.Session.Raise(101, error: null);
        await FirstOf(
            run,
            run,
            "RunAsync to return",
            h.Delays.For(Options.TargetSearchInterval).Nth(1),
            h.Delays.For(Options.RestartBackoff).Nth(1),
            h.Session.Starts.Nth(2));
        await run;

        Assert.Equal("start:101|stop", h.Session.Timeline);
        Assert.Equal(1, h.ResolveCalls);
        CancellationToken stopToken = Assert.Single(h.Session.Stops.Values);
        Assert.False(stopToken.CanBeCanceled);
        Assert.Equal(0, h.Session.HandlerCount);
    }

    [Fact]
    public async Task StartFailureDoesNotRetryAfterCancellation()
    {
        Harness h = new(target: 101);
        COMException failure = DeviceInvalidated();
        h.Session.StartBehavior = _ =>
        {
            h.Session.Raise(101, failure);
            return Task.FromException(failure);
        };
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        DelayCall backoff = await Observe(
            h.Delays.For(Options.RestartBackoff).Nth(1), run, "the restart backoff", h.Session.Starts.Nth(2));
        Assert.True(backoff.Token.CanBeCanceled);
        await cts.CancelAsync();

        await AssertCanceledAsync(run);
        Assert.Equal(1, h.Session.Starts.Count);
        Assert.Equal(0, h.Session.HandlerCount);
        Assert.NotEmpty(h.Session.Stops.Values);
        Assert.All(h.Session.Stops.Values, token => Assert.False(token.CanBeCanceled));
    }

    [Fact]
    public async Task DoesNotRetryNonTransientStartFailure()
    {
        Harness h = new(target: 101);
        InvalidOperationException failure = new("Capture was misconfigured.");
        h.Session.StartBehavior = _ =>
        {
            h.Session.Raise(101, failure);
            return Task.FromException(failure);
        };
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await FirstOf(run, run, "RunAsync to end", h.Delays.For(Options.RestartBackoff).Nth(1), h.Session.Starts.Nth(2));
        InvalidOperationException thrown = await Assert.ThrowsAsync<InvalidOperationException>(() => run);
        Assert.Same(failure, thrown);
        Assert.Equal(1, h.Session.Starts.Count);
        Assert.Equal(0, h.Session.HandlerCount);
    }

    [Fact]
    public async Task CancellationDuringTargetResolutionDoesNotStart()
    {
        FakeAudioCaptureSession session = new();
        ControlledDelays delays = new();
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        int resolveCalls = 0;
        ProcessCaptureMonitor monitor = new(
            session,
            () =>
            {
                // The caller cancels while the resolver is running; the resolver still reports a target.
                Interlocked.Increment(ref resolveCalls);
                cts.Cancel();
                return 101;
            },
            _ => true,
            Options,
            delays.DelayAsync);
        ConcurrentQueue<ProcessCaptureMonitorEvent> events = new();
        monitor.StatusChanged += events.Enqueue;

        Task run = monitor.RunAsync(waitForTargetRestart: true, cts.Token);

        await AssertCanceledAsync(run);
        Assert.Equal(1, Volatile.Read(ref resolveCalls));
        Assert.Equal(0, session.Starts.Count);
        Assert.Equal(string.Empty, session.Timeline);
        Assert.Equal(0, session.HandlerCount);
        Assert.Equal(0, delays.For(Options.SessionPollInterval).Count);
        Assert.Equal(0, delays.For(Options.RestartBackoff).Count);
        Assert.DoesNotContain(events, status => status.Kind == ProcessCaptureMonitorEventKind.CaptureStarted);
    }

    [Fact]
    public async Task StartupProcessExitReturnsWithoutRetry()
    {
        Harness h = new(target: 101);
        h.Session.StartBehavior = _ =>
        {
            h.Exit(101);
            return Task.FromException(new ArgumentException("The target process is no longer running."));
        };
        ConcurrentQueue<ProcessCaptureMonitorEvent> events = new();
        h.Monitor.StatusChanged += events.Enqueue;
        using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        Task run = h.Monitor.RunAsync(waitForTargetRestart: false, cts.Token);

        await FirstOf(
            run,
            run,
            "RunAsync to return",
            h.Delays.For(Options.RestartBackoff).Nth(1),
            h.Delays.For(Options.TargetSearchInterval).Nth(1),
            h.Session.Starts.Nth(2));
        await run;

        Assert.Equal("start:101|stop", h.Session.Timeline);
        Assert.Equal(1, h.ResolveCalls);
        CancellationToken stopToken = Assert.Single(h.Session.Stops.Values);
        Assert.False(stopToken.CanBeCanceled);
        Assert.Equal(0, h.Session.HandlerCount);
        Assert.Equal(0, h.Delays.For(Options.RestartBackoff).Count);
        Assert.Contains(events, status => status is { Kind: ProcessCaptureMonitorEventKind.TargetExited, ProcessId: 101 });
        Assert.DoesNotContain(events, status => status.Kind == ProcessCaptureMonitorEventKind.Restarting);
    }

    private static COMException DeviceInvalidated() =>
        (COMException)Marshal.GetExceptionForHR(DeviceInvalidatedHResult, new IntPtr(-1))!;

    private static async Task<T> Observe<T>(Task<T> expected, Task run, string description, params Task[] forbidden)
    {
        await FirstOf(expected, run, description, forbidden);
        return await expected;
    }

    private static async Task FirstOf(Task expected, Task run, string description, params Task[] forbidden)
    {
        Task[] candidates = [expected, run, .. forbidden];
        Task first = await Task.WhenAny(candidates).WaitAsync(HangSafety, TestContext.Current.CancellationToken);
        if (first == expected)
        {
            return;
        }

        if (first == run)
        {
            await run;
        }

        Assert.Fail($"Expected {description} before any other observed monitor action.");
    }

    private static Task<OperationCanceledException> AssertCanceledAsync(Task run) =>
        Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => run.WaitAsync(HangSafety, TestContext.Current.CancellationToken));

    private sealed class Harness
    {
        private readonly Lock _gate = new();
        private readonly HashSet<int> _alive = [];
        private int? _target;
        private int _resolveCalls;

        public Harness(int target)
        {
            SetTarget(target);
            Monitor = new ProcessCaptureMonitor(Session, Resolve, IsAlive, Options, Delays.DelayAsync);
        }

        public FakeAudioCaptureSession Session { get; } = new();

        public ControlledDelays Delays { get; } = new();

        public ProcessCaptureMonitor Monitor { get; }

        public int ResolveCalls { get { lock (_gate) { return _resolveCalls; } } }

        public void SetTarget(int processId)
        {
            lock (_gate)
            {
                _target = processId;
                _alive.Add(processId);
            }
        }

        public void Exit(int processId)
        {
            lock (_gate)
            {
                _alive.Remove(processId);
                if (_target == processId)
                {
                    _target = null;
                }
            }
        }

        private int? Resolve()
        {
            lock (_gate)
            {
                _resolveCalls++;
                return _target;
            }
        }

        private bool IsAlive(int processId)
        {
            lock (_gate)
            {
                return _alive.Contains(processId);
            }
        }
    }

    private sealed class FakeAudioCaptureSession : IAudioCaptureSession
    {
        private readonly Lock _gate = new();
        private readonly List<Action<ProcessLoopbackCaptureStopped>> _handlers = [];
        private readonly List<string> _timeline = [];
        private ProcessLoopbackCaptureState _state = ProcessLoopbackCaptureState.Stopped;
        private int? _activeProcessId;
        private bool _stopRaised;
        private int _startCount;

        public event Action<ProcessLoopbackCaptureStopped>? CaptureStopped
        {
            add { lock (_gate) { if (value is not null) { _handlers.Add(value); } } }
            remove { lock (_gate) { if (value is not null) { _handlers.Remove(value); } } }
        }

        public Func<int, Task>? StartBehavior { get; set; }

        public Occurrences<int> Starts { get; } = new();

        public Occurrences<CancellationToken> Stops { get; } = new();

        public ProcessLoopbackCaptureState CaptureState { get { lock (_gate) { return _state; } } }

        public int HandlerCount { get { lock (_gate) { return _handlers.Count; } } }

        public string Timeline { get { lock (_gate) { return string.Join('|', _timeline); } } }

        public Task StartCaptureAsync(int processId, CancellationToken cancellationToken = default)
        {
            int ordinal;
            lock (_gate)
            {
                _timeline.Add("start:" + processId.ToString(CultureInfo.InvariantCulture));
                _activeProcessId = processId;
                _stopRaised = false;
                _state = ProcessLoopbackCaptureState.Capturing;
                ordinal = ++_startCount;
            }

            Task outcome = StartBehavior?.Invoke(ordinal) ?? Task.CompletedTask;
            Starts.Record(processId);
            return outcome;
        }

        public Task StopCaptureAsync(CancellationToken cancellationToken = default)
        {
            int? activeProcessId;
            lock (_gate)
            {
                _timeline.Add("stop");
                activeProcessId = _activeProcessId;
            }

            // Production raises CaptureStopped once per session, including from an explicit stop.
            if (activeProcessId is int processId)
            {
                Raise(processId, error: null);
            }

            lock (_gate)
            {
                _activeProcessId = null;
                if (_state != ProcessLoopbackCaptureState.Faulted)
                {
                    _state = ProcessLoopbackCaptureState.Stopped;
                }
            }

            Stops.Record(cancellationToken);
            return Task.CompletedTask;
        }

        public int Raise(int processId, Exception? error)
        {
            Action<ProcessLoopbackCaptureStopped>[] handlers;
            lock (_gate)
            {
                if (processId == _activeProcessId)
                {
                    if (_stopRaised)
                    {
                        return 0;
                    }

                    _stopRaised = true;
                    _state = error is null ? ProcessLoopbackCaptureState.Stopped : ProcessLoopbackCaptureState.Faulted;
                }

                handlers = [.. _handlers];
            }

            ProcessLoopbackCaptureStopped stopped = new(processId, error, DateTimeOffset.UtcNow);
            foreach (Action<ProcessLoopbackCaptureStopped> handler in handlers)
            {
                handler(stopped);
            }

            return handlers.Length;
        }
    }

    private sealed class ControlledDelays
    {
        private readonly ConcurrentDictionary<TimeSpan, Occurrences<DelayCall>> _calls = new();

        public Occurrences<DelayCall> For(TimeSpan duration) =>
            _calls.GetOrAdd(duration, static _ => new Occurrences<DelayCall>());

        public Task DelayAsync(TimeSpan duration, CancellationToken cancellationToken)
        {
            DelayCall call = new(cancellationToken);
            For(duration).Record(call);
            return call.WaitAsync();
        }
    }

    private sealed class DelayCall(CancellationToken token)
    {
        private readonly TaskCompletionSource _elapsed = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public CancellationToken Token { get; } = token;

        public void Elapse() => _elapsed.TrySetResult();

        public Task WaitAsync() => _elapsed.Task.WaitAsync(Token);
    }

    private sealed class Occurrences<T>
    {
        private readonly Lock _gate = new();
        private readonly List<TaskCompletionSource<T>> _signals = [];
        private readonly List<T> _values = [];

        public int Count { get { lock (_gate) { return _values.Count; } } }

        public IReadOnlyList<T> Values { get { lock (_gate) { return [.. _values]; } } }

        public void Record(T value)
        {
            TaskCompletionSource<T> signal;
            lock (_gate)
            {
                _values.Add(value);
                signal = Slot(_values.Count);
            }

            signal.TrySetResult(value);
        }

        public Task<T> Nth(int occurrence)
        {
            lock (_gate)
            {
                return Slot(occurrence).Task;
            }
        }

        private TaskCompletionSource<T> Slot(int occurrence)
        {
            while (_signals.Count < occurrence)
            {
                _signals.Add(new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously));
            }

            return _signals[occurrence - 1];
        }
    }
}
