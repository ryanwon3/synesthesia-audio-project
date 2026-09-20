using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using SpotifySynesthesia.TestTonePlayer.Playback;
using SpotifySynesthesia.TestTonePlayer.Signals;

namespace SpotifySynesthesia.TestTonePlayer.Ui;

public sealed class TestTonePlayerViewModel : INotifyPropertyChanged, IAsyncDisposable
{
    private static readonly TimeSpan RestartDebounce = TimeSpan.FromMilliseconds(100);

    private readonly AudioPlaybackController _controller;
    private readonly SynchronizationContext? _uiContext;
    private readonly string _processId;
    private readonly string _sampleRate;

    private SignalOption _selectedSignal;
    private ChannelOption _selectedChannel;
    private AudioOutputDevice? _selectedOutputDevice;
    private double _volumePercent = TestSignalSettings.DefaultLevel * 100d;
    private string _playbackStatus = "Stopped";
    private string _errorMessage = string.Empty;
    private int _restartVersion;
    private bool _disposed;

    public TestTonePlayerViewModel()
        : this(new AudioPlaybackController(new NAudioOutputFactory()))
    {
    }

    public TestTonePlayerViewModel(AudioPlaybackController controller)
    {
        _controller = controller ?? throw new ArgumentNullException(nameof(controller));
        _uiContext = SynchronizationContext.Current;
        _processId = Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture);
        _sampleRate = $"{TestSignalSettings.DefaultSampleRate:N0} Hz";

        Signals = Enum.GetValues<TestSignalKind>()
            .Select(signal => new SignalOption(signal, signal.GetDisplayName()))
            .ToArray();
        Channels = Enum.GetValues<ChannelMode>()
            .Select(channel => new ChannelOption(channel, channel.GetDisplayName()))
            .ToArray();

        _selectedSignal = Signals.Single(option => option.Value == TestSignalKind.Sine440Hz);
        _selectedChannel = Channels.Single(option => option.Value == ChannelMode.Stereo);

        OutputDevices = [];
        TogglePlaybackCommand = new AsyncCommand(TogglePlaybackAsync, CanTogglePlayback);
        RefreshDevicesCommand = new AsyncCommand(RefreshDevicesAsync);

        _controller.StateChanged += HandleControllerStateChanged;
        RefreshDevices();
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    public IReadOnlyList<SignalOption> Signals { get; }

    public IReadOnlyList<ChannelOption> Channels { get; }

    public ObservableCollection<AudioOutputDevice> OutputDevices { get; }

    public AsyncCommand TogglePlaybackCommand { get; }

    public AsyncCommand RefreshDevicesCommand { get; }

    public SignalOption SelectedSignal
    {
        get => _selectedSignal;
        set
        {
            ArgumentNullException.ThrowIfNull(value);
            if (SetProperty(ref _selectedSignal, value))
            {
                QueuePlaybackRestart();
                OnPropertyChanged(nameof(ActiveSignal));
            }
        }
    }

    public ChannelOption SelectedChannel
    {
        get => _selectedChannel;
        set
        {
            ArgumentNullException.ThrowIfNull(value);
            if (SetProperty(ref _selectedChannel, value))
            {
                QueuePlaybackRestart();
            }
        }
    }

    public AudioOutputDevice? SelectedOutputDevice
    {
        get => _selectedOutputDevice;
        set
        {
            if (SetProperty(ref _selectedOutputDevice, value))
            {
                TogglePlaybackCommand.RaiseCanExecuteChanged();
                QueuePlaybackRestart();
                OnPropertyChanged(nameof(ActiveOutputDevice));
            }
        }
    }

    public double VolumePercent
    {
        get => _volumePercent;
        set
        {
            double clamped = Math.Clamp(value, 0d, TestSignalSettings.MaximumLevel * 100d);
            if (SetProperty(ref _volumePercent, clamped))
            {
                _controller.UpdateLevel((float)(clamped / 100d));
                OnPropertyChanged(nameof(VolumeDisplay));
            }
        }
    }

    public string VolumeDisplay => $"{VolumePercent:0}%";

    public string PlaybackStatus
    {
        get => _playbackStatus;
        private set => SetProperty(ref _playbackStatus, value);
    }

    public string ErrorMessage
    {
        get => _errorMessage;
        private set => SetProperty(ref _errorMessage, value);
    }

    public string ToggleButtonLabel => _controller.State == PlaybackState.Playing ? "Stop" : "Play";

    public string ActiveSignal => SelectedSignal.DisplayName;

    public string ActiveOutputDevice => SelectedOutputDevice?.DisplayName ?? "No active device";

    public string ProcessId => _processId;

    public string SampleRate => _sampleRate;

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        Interlocked.Increment(ref _restartVersion);
        _controller.StateChanged -= HandleControllerStateChanged;
        await _controller.DisposeAsync();
    }

    private bool CanTogglePlayback() =>
        SelectedOutputDevice is not null &&
        _controller.State is not PlaybackState.Starting and not PlaybackState.Stopping;

    private async Task TogglePlaybackAsync()
    {
        ErrorMessage = string.Empty;

        try
        {
            if (_controller.State == PlaybackState.Playing)
            {
                await _controller.StopAsync();
            }
            else
            {
                await StartSelectedSignalAsync();
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            ErrorMessage = $"Playback failed: {exception.Message}";
        }
    }

    private Task RefreshDevicesAsync()
    {
        RefreshDevices();
        return Task.CompletedTask;
    }

    private void RefreshDevices()
    {
        try
        {
            string? selectedDeviceId = SelectedOutputDevice?.Id;
            IReadOnlyList<AudioOutputDevice> devices = _controller.GetActiveRenderDevices();

            OutputDevices.Clear();
            foreach (AudioOutputDevice device in devices)
            {
                OutputDevices.Add(device);
            }

            SelectedOutputDevice = OutputDevices.FirstOrDefault(device => device.Id == selectedDeviceId)
                ?? OutputDevices.FirstOrDefault(device => device.IsDefault)
                ?? OutputDevices.FirstOrDefault();

            ErrorMessage = OutputDevices.Count == 0
                ? "No active Windows audio output device was found."
                : string.Empty;
        }
        catch (Exception exception)
        {
            OutputDevices.Clear();
            SelectedOutputDevice = null;
            ErrorMessage = $"Could not enumerate audio devices: {exception.Message}";
        }
    }

    private async Task StartSelectedSignalAsync()
    {
        AudioOutputDevice? device = SelectedOutputDevice;
        if (device is null)
        {
            ErrorMessage = "Select an active output device before playing a signal.";
            return;
        }

        TestSignalSettings settings = CreateSettings();
        await _controller.StartAsync(settings, device.Id);
    }

    private TestSignalSettings CreateSettings() => new(
        SelectedSignal.Value,
        SelectedChannel.Value,
        (float)(VolumePercent / 100d));

    private void QueuePlaybackRestart()
    {
        int version = Interlocked.Increment(ref _restartVersion);
        _ = RestartPlaybackAfterChangeAsync(version);
    }

    private async Task RestartPlaybackAfterChangeAsync(int version)
    {
        try
        {
            await Task.Delay(RestartDebounce);

            if (_disposed ||
                version != Volatile.Read(ref _restartVersion) ||
                _controller.State != PlaybackState.Playing ||
                SelectedOutputDevice is null)
            {
                return;
            }

            await StartSelectedSignalAsync();
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            PostToUi(() => ErrorMessage = $"Could not apply the playback change: {exception.Message}");
        }
    }

    private void HandleControllerStateChanged(PlaybackState state)
    {
        PostToUi(() =>
        {
            PlaybackStatus = state.ToString();
            OnPropertyChanged(nameof(ToggleButtonLabel));
            TogglePlaybackCommand.RaiseCanExecuteChanged();
        });
    }

    private void PostToUi(Action action)
    {
        if (_uiContext is null || SynchronizationContext.Current == _uiContext)
        {
            action();
            return;
        }

        _uiContext.Post(static state => ((Action)state!).Invoke(), action);
    }

    private bool SetProperty<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
        {
            return false;
        }

        field = value;
        OnPropertyChanged(propertyName);
        return true;
    }

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));

    public sealed record SignalOption(TestSignalKind Value, string DisplayName);

    public sealed record ChannelOption(ChannelMode Value, string DisplayName);
}
