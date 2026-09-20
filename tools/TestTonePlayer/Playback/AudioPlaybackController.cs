using SpotifySynesthesia.TestTonePlayer.Signals;

namespace SpotifySynesthesia.TestTonePlayer.Playback;

public sealed class AudioPlaybackController : IAsyncDisposable
{
    private static readonly TimeSpan StopPadding = TimeSpan.FromMilliseconds(5);

    private readonly IAudioOutputFactory _outputFactory;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly SemaphoreSlim _operationGate = new(initialCount: 1, maxCount: 1);

    private IAudioOutputSession? _session;
    private TestSignalSampleProvider? _source;
    private TestSignalSettings? _settings;
    private int _state = (int)PlaybackState.Stopped;
    private bool _disposed;

    public AudioPlaybackController(
        IAudioOutputFactory outputFactory,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _outputFactory = outputFactory ?? throw new ArgumentNullException(nameof(outputFactory));
        _delay = delay ?? Task.Delay;
    }

    public event Action<PlaybackState>? StateChanged;

    public PlaybackState State => (PlaybackState)Volatile.Read(ref _state);

    public IReadOnlyList<AudioOutputDevice> GetActiveRenderDevices()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _outputFactory.GetActiveRenderDevices();
    }

    public async Task StartAsync(
        TestSignalSettings settings,
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(settings);
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceId);

        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            await StopCoreAsync(cancellationToken).ConfigureAwait(false);
            SetState(PlaybackState.Starting);

            TestSignalSampleProvider source = new(settings);
            IAudioOutputSession? session = null;

            try
            {
                session = _outputFactory.Create(deviceId);
                session.Start(source);

                _settings = settings;
                _source = source;
                _session = session;
                SetState(PlaybackState.Playing);
            }
            catch
            {
                if (session is not null)
                {
                    await session.DisposeAsync().ConfigureAwait(false);
                }

                _settings = null;
                _source = null;
                _session = null;
                SetState(PlaybackState.Faulted);
                throw;
            }
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await StopCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _operationGate.Release();
        }
    }

    public void UpdateLevel(float level)
    {
        TestSignalSettings.ValidateLevel(level);
        TestSignalSampleProvider? source = Volatile.Read(ref _source);
        if (source is not null)
        {
            source.Level = level;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        await _operationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed)
            {
                return;
            }

            await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);
            _disposed = true;
        }
        finally
        {
            _operationGate.Release();
        }
    }

    private async Task StopCoreAsync(CancellationToken cancellationToken)
    {
        IAudioOutputSession? session = _session;
        TestSignalSampleProvider? source = _source;
        TestSignalSettings? settings = _settings;

        if (session is null)
        {
            if (State != PlaybackState.Stopped)
            {
                SetState(PlaybackState.Stopped);
            }

            return;
        }

        SetState(PlaybackState.Stopping);
        source?.BeginFadeOut();

        if (settings is not null && settings.FadeDuration > TimeSpan.Zero)
        {
            await _delay(settings.FadeDuration + StopPadding, cancellationToken).ConfigureAwait(false);
        }

        try
        {
            session.StopPlayback();
        }
        finally
        {
            await session.DisposeAsync().ConfigureAwait(false);
            _session = null;
            _source = null;
            _settings = null;
            SetState(PlaybackState.Stopped);
        }
    }

    private void SetState(PlaybackState state)
    {
        Volatile.Write(ref _state, (int)state);
        StateChanged?.Invoke(state);
    }
}
