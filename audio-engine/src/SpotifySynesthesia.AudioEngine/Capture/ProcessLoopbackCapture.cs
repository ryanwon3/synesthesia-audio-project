using System.Buffers;
using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using SpotifySynesthesia.AudioEngine.Capture.Interop;

namespace SpotifySynesthesia.AudioEngine.Capture;

public sealed class ProcessLoopbackCapture : IProcessLoopbackCapture
{
    private readonly SemaphoreSlim _operationGate = new(initialCount: 1, maxCount: 1);

    private AudioClient? _audioClient;
    private AudioCaptureClient? _captureClient;
    private AutoResetEvent? _sampleReadyEvent;
    private CancellationTokenSource? _captureCancellation;
    private Task? _captureTask;
    private IAudioSampleSink? _sink;
    private WaveFormat? _waveFormat;
    private Exception? _loopError;
    private int _state = (int)ProcessLoopbackCaptureState.Stopped;
    private int _stoppedEventRaised;
    private bool _disposed;

    public event Action<ProcessLoopbackCaptureState>? StateChanged;

    public event Action<ProcessLoopbackCaptureStopped>? CaptureStopped;

    public ProcessLoopbackCaptureState State =>
        (ProcessLoopbackCaptureState)Volatile.Read(ref _state);

    public ProcessLoopbackCaptureOptions? ActiveOptions { get; private set; }

    public async Task StartAsync(
        ProcessLoopbackCaptureOptions options,
        IAudioSampleSink sink,
        CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(sink);

        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
        {
            throw new PlatformNotSupportedException(
                "Process-specific loopback capture requires Windows build 20348 or later.");
        }

        using (Process targetProcess = Process.GetProcessById(options.TargetProcessId))
        {
            if (targetProcess.HasExited)
            {
                throw new ArgumentException("The target process has already exited.", nameof(options));
            }
        }

        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);

            ActiveOptions = options;
            _sink = sink;
            _loopError = null;
            Interlocked.Exchange(ref _stoppedEventRaised, 0);
            SetState(ProcessLoopbackCaptureState.Activating);

            try
            {
                _waveFormat = WaveFormat.CreateIeeeFloatWaveFormat(options.SampleRate, options.ChannelCount);
                _audioClient = await ProcessLoopbackActivator
                    .ActivateAsync(options, cancellationToken)
                    .ConfigureAwait(false);

                AudioClientStreamFlags streamFlags =
                    AudioClientStreamFlags.Loopback |
                    AudioClientStreamFlags.EventCallback |
                    AudioClientStreamFlags.AutoConvertPcm |
                    AudioClientStreamFlags.SrcDefaultQuality;
                _audioClient.Initialize(
                    AudioClientShareMode.Shared,
                    streamFlags,
                    bufferDuration: 0,
                    periodicity: 0,
                    _waveFormat,
                    Guid.Empty);

                _captureClient = _audioClient.AudioCaptureClient;
                _sampleReadyEvent = new AutoResetEvent(initialState: false);
                _audioClient.SetEventHandle(_sampleReadyEvent.SafeWaitHandle.DangerousGetHandle());
                _captureCancellation = new CancellationTokenSource();
                _captureTask = Task.Factory.StartNew(
                    CaptureLoop,
                    _captureCancellation.Token,
                    TaskCreationOptions.LongRunning,
                    TaskScheduler.Default);

                _audioClient.Start();
                SetState(ProcessLoopbackCaptureState.Capturing);
            }
            catch (Exception exception)
            {
                _loopError = exception;
                CleanupResources();
                SetState(ProcessLoopbackCaptureState.Faulted);
                RaiseCaptureStoppedOnce(exception);
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

        GC.SuppressFinalize(this);
    }

    private void CaptureLoop()
    {
        AutoResetEvent sampleReadyEvent =
            _sampleReadyEvent ?? throw new InvalidOperationException("Capture event was not initialized.");
        CancellationToken cancellationToken =
            _captureCancellation?.Token ?? throw new InvalidOperationException("Capture cancellation was not initialized.");
        WaitHandle[] waitHandles = [sampleReadyEvent, cancellationToken.WaitHandle];

        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                int signaled = WaitHandle.WaitAny(waitHandles);
                if (signaled == 1 || cancellationToken.IsCancellationRequested)
                {
                    break;
                }

                DrainAvailablePackets();
            }
        }
        catch (Exception exception)
        {
            _loopError = exception;
            SetState(ProcessLoopbackCaptureState.Faulted);
            RaiseCaptureStoppedOnce(exception);
            _captureCancellation?.Cancel();
        }
    }

    private void DrainAvailablePackets()
    {
        AudioCaptureClient captureClient =
            _captureClient ?? throw new InvalidOperationException("Capture client was not initialized.");
        IAudioSampleSink sink = _sink ?? throw new InvalidOperationException("Audio sink was not initialized.");
        WaveFormat waveFormat = _waveFormat ?? throw new InvalidOperationException("Wave format was not initialized.");

        int frameCount = captureClient.GetNextPacketSize();
        while (frameCount > 0)
        {
            IntPtr data = captureClient.GetBuffer(
                out int availableFrames,
                out AudioClientBufferFlags flags,
                out long devicePosition,
                out long audioClockPosition);
            int sampleCount = checked(availableFrames * waveFormat.Channels);
            float[] rentedSamples = ArrayPool<float>.Shared.Rent(sampleCount);

            try
            {
                bool isSilent = (flags & AudioClientBufferFlags.Silent) != 0;
                Span<float> samples = rentedSamples.AsSpan(0, sampleCount);

                if (isSilent)
                {
                    samples.Clear();
                }
                else
                {
                    Marshal.Copy(data, rentedSamples, startIndex: 0, sampleCount);
                }

                AudioPacketInfo packetInfo = new(
                    CaptureTimestamp: Stopwatch.GetTimestamp(),
                    DevicePosition: devicePosition,
                    AudioClockPosition: audioClockPosition,
                    FrameCount: availableFrames,
                    SampleRate: waveFormat.SampleRate,
                    ChannelCount: waveFormat.Channels,
                    IsSilent: isSilent,
                    HasDiscontinuity: (flags & AudioClientBufferFlags.DataDiscontinuity) != 0);
                sink.Write(samples, in packetInfo);
            }
            finally
            {
                ArrayPool<float>.Shared.Return(rentedSamples, clearArray: false);
                captureClient.ReleaseBuffer(availableFrames);
            }

            frameCount = captureClient.GetNextPacketSize();
        }
    }

    private async Task StopCoreAsync(CancellationToken cancellationToken)
    {
        if (_audioClient is null && _captureTask is null)
        {
            if (State is not ProcessLoopbackCaptureState.Stopped and not ProcessLoopbackCaptureState.Faulted)
            {
                SetState(ProcessLoopbackCaptureState.Stopped);
            }

            return;
        }

        if (State != ProcessLoopbackCaptureState.Faulted)
        {
            SetState(ProcessLoopbackCaptureState.Stopping);
        }

        _captureCancellation?.Cancel();
        _sampleReadyEvent?.Set();

        if (_captureTask is not null)
        {
            await _captureTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        try
        {
            _audioClient?.Stop();
        }
        catch (COMException exception) when (_loopError is null)
        {
            _loopError = exception;
        }

        Exception? error = _loopError;
        CleanupResources();

        if (error is null)
        {
            SetState(ProcessLoopbackCaptureState.Stopped);
        }
        else
        {
            SetState(ProcessLoopbackCaptureState.Faulted);
        }

        RaiseCaptureStoppedOnce(error);
    }

    private void CleanupResources()
    {
        _captureClient?.Dispose();
        _captureClient = null;
        _audioClient?.Dispose();
        _audioClient = null;
        _sampleReadyEvent?.Dispose();
        _sampleReadyEvent = null;
        _captureCancellation?.Dispose();
        _captureCancellation = null;
        _captureTask = null;
        _sink = null;
        _waveFormat = null;
    }

    private void SetState(ProcessLoopbackCaptureState state)
    {
        Volatile.Write(ref _state, (int)state);
        StateChanged?.Invoke(state);
    }

    private void RaiseCaptureStoppedOnce(Exception? error)
    {
        ProcessLoopbackCaptureOptions? options = ActiveOptions;
        if (options is null || Interlocked.Exchange(ref _stoppedEventRaised, 1) != 0)
        {
            return;
        }

        CaptureStopped?.Invoke(new ProcessLoopbackCaptureStopped(
            options.TargetProcessId,
            error,
            DateTimeOffset.UtcNow));
        ActiveOptions = null;
    }
}
