using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.Desktop;

public partial class MainWindow : Window, IAsyncDisposable
{
    private readonly CancellationTokenSource _shutdown = new();
    private AudioEngineRuntime? _runtime;
    private SpotifyMetadataRuntime? _metadataRuntime;
    private SpotifyCaptureMonitor? _captureMonitor;
    private Task? _captureTask;
    private bool _closing;
    private bool _disposed;

    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => EnableDarkTitleBar();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_closing)
        {
            _closing = true;
            _shutdown.Cancel();
        }

        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        DisposeAsync().AsTask().GetAwaiter().GetResult();
        base.OnClosed(e);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();
        await DisposeRuntimeAsync().ConfigureAwait(false);
        _shutdown.Dispose();
        GC.SuppressFinalize(this);
    }

    private async void HandleLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            string visualizerPath = Path.Combine(AppContext.BaseDirectory, "visualizer");
            string indexPath = Path.Combine(visualizerPath, "index.html");
            if (!File.Exists(indexPath))
            {
                throw new FileNotFoundException("The visualizer bundle is missing.", indexPath);
            }

            AudioFrameWebSocketServerOptions serverOptions = new(staticContentPath: visualizerPath);
            _runtime = new AudioEngineRuntime(serverOptions);
            await _runtime.StartServerAsync(_shutdown.Token);

            _metadataRuntime = SpotifyMetadataRuntime.CreateDefault(_runtime.Server);
            try
            {
                await _metadataRuntime.InitializeAsync(_shutdown.Token);
            }
            catch (Exception exception) when (
                exception is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                await _metadataRuntime.DisposeAsync();
                _metadataRuntime = null;
            }

            await Visualizer.EnsureCoreWebView2Async();
            ConfigureWebView(Visualizer.CoreWebView2);
            Visualizer.Source = new Uri(serverOptions.HttpPrefix);
            Visualizer.NavigationCompleted += HandleNavigationCompleted;

            _captureMonitor = new SpotifyCaptureMonitor(_runtime);
            _captureTask = _captureMonitor.RunAsync(_shutdown.Token);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            StartupTitle.Text = "Unable to start";
            StartupDetail.Text = exception.Message;
        }
    }

    private void HandleNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            StartupStatus.Visibility = Visibility.Collapsed;
            return;
        }

        StartupTitle.Text = "Unable to open the visualizer";
        StartupDetail.Text = e.WebErrorStatus.ToString();
    }

    private void ConfigureWebView(CoreWebView2 coreWebView)
    {
        coreWebView.Settings.AreDefaultContextMenusEnabled = false;
        coreWebView.Settings.AreDevToolsEnabled = true;
        coreWebView.Settings.IsStatusBarEnabled = false;
        coreWebView.Settings.IsZoomControlEnabled = false;
        coreWebView.Settings.IsBuiltInErrorPageEnabled = false;
        coreWebView.WebMessageReceived += HandleWebMessageReceived;
    }

    private async void HandleWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_metadataRuntime is null ||
            !IsTrustedVisualizerSource(e.Source) ||
            !TryGetHostMessageType(e.WebMessageAsJson, out string? messageType))
        {
            return;
        }

        if (string.Equals(messageType, "openLastFmSetup", StringComparison.Ordinal))
        {
            await OpenLastFmSettingsAsync();
        }
        else if (string.Equals(messageType, "openOpenAiSetup", StringComparison.Ordinal))
        {
            await OpenOpenAiSettingsAsync();
        }
        else if (string.Equals(messageType, "reanalyzeLyrics", StringComparison.Ordinal) &&
            MessageBox.Show(this, "Analyze this song again? This sends matched lyrics to OpenAI and uses API credits.",
                "Reanalyze lyrics", MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes)
        {
            _metadataRuntime.ReanalyzeLyrics();
        }
    }

    private async Task OpenLastFmSettingsAsync()
    {
        if (_metadataRuntime is null)
        {
            return;
        }

        LastFmSettingsDialog dialog = new(_metadataRuntime.IsLastFmConfigured) { Owner = this };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        try
        {
            await _metadataRuntime.ConfigureLastFmApiKeyAsync(
                dialog.RemoveRequested ? null : dialog.ApiKey,
                _shutdown.Token);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        {
            MessageBox.Show(
                this,
                exception.Message,
                "Unable to save Last.fm settings",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private async Task OpenOpenAiSettingsAsync()
    {
        if (_metadataRuntime is null)
        {
            return;
        }

        OpenAiSettingsDialog dialog = new(_metadataRuntime.IsOpenAiConfigured, _metadataRuntime.LyricsSettings) { Owner = this };
        if (dialog.ShowDialog() != true)
        {
            return;
        }

        try
        {
            // Apply automation preferences before changing the key so saving cannot race a paid job.
            await _metadataRuntime.ConfigureLyricsAsync(dialog.Settings, _shutdown.Token);
            if (dialog.RemoveRequested || dialog.ApiKey is not null)
                await _metadataRuntime.ConfigureOpenAiApiKeyAsync(
                    dialog.RemoveRequested ? null : dialog.ApiKey, _shutdown.Token);
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        {
            MessageBox.Show(
                this,
                exception.Message,
                "Unable to save OpenAI settings",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private static bool IsTrustedVisualizerSource(string source) =>
        Uri.TryCreate(source, UriKind.Absolute, out Uri? uri) &&
        string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal) &&
        uri.Port == 8765;

    private static bool TryGetHostMessageType(string json, out string? messageType)
    {
        messageType = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("protocolVersion", out JsonElement version) ||
                version.ValueKind != JsonValueKind.Number ||
                !version.TryGetInt32(out int protocolVersion) ||
                protocolVersion != 1 ||
                !root.TryGetProperty("type", out JsonElement type) ||
                type.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            messageType = type.GetString();
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private async Task DisposeRuntimeAsync()
    {
        if (_captureTask is not null)
        {
            try
            {
                await _captureTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
            {
            }
        }

        if (_runtime is not null)
        {
            if (_metadataRuntime is not null)
            {
                await _metadataRuntime.DisposeAsync().ConfigureAwait(false);
            }

            await _runtime.DisposeAsync().ConfigureAwait(false);
        }

        if (Visualizer.CoreWebView2 is not null)
        {
            Visualizer.CoreWebView2.WebMessageReceived -= HandleWebMessageReceived;
        }

        Visualizer.Dispose();
    }

    private void EnableDarkTitleBar()
    {
        nint handle = new WindowInteropHelper(this).Handle;
        int enabled = 1;
        _ = DwmSetWindowAttribute(handle, 20, ref enabled, sizeof(int));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        nint windowHandle,
        int attribute,
        ref int attributeValue,
        int attributeSize);
}
