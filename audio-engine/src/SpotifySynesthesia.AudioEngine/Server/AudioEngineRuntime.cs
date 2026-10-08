using System.Diagnostics;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.AudioEngine.Server;

public sealed class AudioEngineRuntime : IAudioCaptureSession, IAsyncDisposable
{
    private readonly ProcessLoopbackCapture _capture;
    private readonly RealTimeAudioAnalyzer _analyzer;
    private readonly AudioFrameWebSocketServer _server;
    private AudioFrame? _latestFrame;
    private bool _disposed;

    public AudioEngineRuntime(
        AudioFrameWebSocketServerOptions? serverOptions = null,
        AudioAnalyzerOptions? analyzerOptions = null)
    {
        _capture = new ProcessLoopbackCapture();
        _analyzer = new RealTimeAudioAnalyzer(analyzerOptions);
        _server = new AudioFrameWebSocketServer(serverOptions);
        _analyzer.FrameProduced += HandleAudioFrame;
    }

    public event Action<AudioFrame>? FrameProduced;

    // Forwards directly to the capture; handlers run on the capture thread.
    public event Action<ProcessLoopbackCaptureStopped>? CaptureStopped
    {
        add => _capture.CaptureStopped += value;
        remove => _capture.CaptureStopped -= value;
    }

    public ProcessLoopbackCaptureState CaptureState => _capture.State;

    public ProcessLoopbackCaptureOptions? ActiveCapture => _capture.ActiveOptions;

    public AudioFrame? LatestFrame => Volatile.Read(ref _latestFrame);

    public AudioFrameWebSocketServer Server => _server;

    public async Task StartServerAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _server.StartAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task StartCaptureAsync(int processId, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _capture
            .StartAsync(new ProcessLoopbackCaptureOptions(processId), _analyzer, cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task StopCaptureAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        await _capture.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    public AudioEngineRuntimeSnapshot GetSnapshot()
    {
        AudioFrame? frame = LatestFrame;
        double captureToDspMilliseconds = frame is null
            ? 0d
            : Stopwatch.GetElapsedTime(frame.CaptureTimestamp, frame.DspCompletedTimestamp).TotalMilliseconds;

        return new AudioEngineRuntimeSnapshot(
            CaptureState,
            ActiveCapture?.TargetProcessId,
            _server.IsRunning,
            _server.ConnectedClientCount,
            _server.FramesPublished,
            frame?.Sequence ?? 0,
            captureToDspMilliseconds);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _analyzer.FrameProduced -= HandleAudioFrame;
        await _capture.DisposeAsync().ConfigureAwait(false);
        await _server.DisposeAsync().ConfigureAwait(false);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void HandleAudioFrame(AudioFrame frame)
    {
        Volatile.Write(ref _latestFrame, frame);
        _server.Publish(frame);
        FrameProduced?.Invoke(frame);
    }
}

public sealed record AudioEngineRuntimeSnapshot(
    ProcessLoopbackCaptureState CaptureState,
    int? TargetProcessId,
    bool ServerRunning,
    int ConnectedClients,
    long FramesPublished,
    long LatestSequence,
    double CaptureToDspMilliseconds);
