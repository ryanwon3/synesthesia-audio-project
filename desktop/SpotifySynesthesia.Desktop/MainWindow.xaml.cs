using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.Desktop;

public partial class MainWindow : Window, IAsyncDisposable
{
    private const string HostedOriginVariable = "SYNESTHESIA_HOSTED_ORIGIN";
    private const string LegacyEnrichmentVariable = "SYNESTHESIA_LEGACY_ENRICHMENT";
    private readonly CancellationTokenSource _shutdown = new();
    private readonly DispatcherTimer _pairingCodeTimer = new();
    private AudioEngineRuntime? _runtime;
    private SpotifyMetadataRuntime? _metadataRuntime;
    private SpotifyCaptureMonitor? _captureMonitor;
    private Task? _captureTask;
    private CompanionSettings _companionSettings = new();
    private int _port;
    private string _bundledOrigin = string.Empty;
    private string _bundledRoot = string.Empty;
    // The desktop-held bundled session only; replaced on each trusted ready request.
    private Guid? _localSessionId;
    private bool _captureFaulted;
    private bool _closing;
    private bool _disposed;

    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => EnableDarkTitleBar();
        _pairingCodeTimer.Tick += HandlePairingCodeExpired;
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
        Dispatcher.VerifyAccess();
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();

        // WebView2 must be released on its owner thread, before any await can resume on the pool.
        _pairingCodeTimer.Stop();
        _pairingCodeTimer.Tick -= HandlePairingCodeExpired;
        if (Visualizer.CoreWebView2 is CoreWebView2 coreWebView)
        {
            coreWebView.NavigationStarting -= HandleNavigationStarting;
            coreWebView.NewWindowRequested -= HandleNewWindowRequested;
            coreWebView.NavigationCompleted -= HandleNavigationCompleted;
            coreWebView.WebMessageReceived -= HandleWebMessageReceived;
        }

        Visualizer.Dispose();

        try
        {
            await DisposeRuntimeAsync().ConfigureAwait(false);
        }
        finally
        {
            _shutdown.Dispose();
        }

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

            _companionSettings = LoadCompanionSettings();
            string[] allowedOrigins = _companionSettings.HostedOrigin is string hostedOrigin ? [hostedOrigin] : [];
            AudioFrameWebSocketServerOptions serverOptions = new(
                staticContentPath: visualizerPath,
                allowedBrowserOrigins: allowedOrigins);
            _port = serverOptions.Port;
            _bundledOrigin = string.Create(CultureInfo.InvariantCulture, $"http://127.0.0.1:{_port}");
            _bundledRoot = _bundledOrigin + "/";
            _runtime = new AudioEngineRuntime(serverOptions);
            await _runtime.StartServerAsync(_shutdown.Token);

            // Default companion mode never opens legacy protected stores or automatic paid enrichment.
            if (!_companionSettings.CompanionMode)
            {
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
            }

            await Visualizer.EnsureCoreWebView2Async();
            // Guards attach before the first bundled navigation can start.
            ConfigureWebView(Visualizer.CoreWebView2);
            Visualizer.Source = new Uri(_bundledRoot);
            CompanionControls.IsEnabled = true;

            _captureMonitor = new SpotifyCaptureMonitor(_runtime);
            _captureTask = ObserveCaptureAsync(_captureMonitor, _shutdown.Token);
            CaptureStatusText.Text = "Listening for Spotify";
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
            // A capture fault reported before the page loaded must stay visible.
            if (!_captureFaulted)
            {
                StartupStatus.Visibility = Visibility.Collapsed;
            }

            return;
        }

        // Blocked navigations complete as canceled; the current trusted page is still loaded.
        if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled)
        {
            return;
        }

        StartupTitle.Text = "Unable to open the visualizer";
        StartupDetail.Text = e.WebErrorStatus.ToString();
    }

    // Never throws, so shutdown always reaches runtime cleanup after awaiting it.
    private async Task ObserveCaptureAsync(SpotifyCaptureMonitor monitor, CancellationToken cancellationToken)
    {
        try
        {
            await monitor.RunAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            // Post without waiting: OnClosed blocks the UI thread on this task during shutdown.
            if (!Dispatcher.HasShutdownStarted)
            {
                _ = Dispatcher.BeginInvoke(new Action(() => ShowCaptureFault(exception)));
            }
        }
    }

    private void ShowCaptureFault(Exception exception)
    {
        if (_closing)
        {
            return;
        }

        _captureFaulted = true;
        Title = "Spotify Synesthesia - not hearing Spotify";
        CaptureStatusText.Text = "Stopped listening to Spotify. Restart the app to try again.";
        StartupTitle.Text = "Spotify Synesthesia stopped listening to Spotify";
        StartupDetail.Text =
            $"The visuals will stay open but won't react to music. Restart the app to try again. ({exception.Message})";
        StartupStatus.Visibility = Visibility.Visible;
    }

    private void ConfigureWebView(CoreWebView2 coreWebView)
    {
        coreWebView.Settings.AreDefaultContextMenusEnabled = false;
        coreWebView.Settings.AreDevToolsEnabled = true;
        coreWebView.Settings.IsStatusBarEnabled = false;
        coreWebView.Settings.IsZoomControlEnabled = false;
        coreWebView.Settings.IsBuiltInErrorPageEnabled = false;
        coreWebView.NavigationStarting += HandleNavigationStarting;
        coreWebView.NewWindowRequested += HandleNewWindowRequested;
        coreWebView.NavigationCompleted += HandleNavigationCompleted;
        coreWebView.WebMessageReceived += HandleWebMessageReceived;
    }

    // Only the exact bundled root or index may load here; hosted pages open in the external browser.
    private void HandleNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (CompanionSettings.IsTrustedBundledSource(e.Uri, _port))
        {
            return;
        }

        e.Cancel = true;
        ShowCompanionStatus("Blocked navigation away from the built-in visualizer.");
    }

    private void HandleNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        ShowCompanionStatus("Blocked a new window. Use Open hosted visualizer to open the hosted page.");
    }

    // Synchronous on the UI thread: trust is checked and the credential posted with no await between.
    private void HandleWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!TryGetHostMessageType(e.WebMessageAsJson, out string? messageType))
        {
            return;
        }

        // Dispatched before the metadata guard so offline audio works without metadata.
        if (string.Equals(messageType, "companionBootstrapReady", StringComparison.Ordinal))
        {
            DeliverCompanionBootstrap(e.Source);
        }
        else if (_metadataRuntime is not null && IsTrustedCurrentSource(e.Source))
        {
            RunHostCommand(messageType);
        }
    }

    private void DeliverCompanionBootstrap(string source)
    {
        CoreWebView2? coreWebView = Visualizer.CoreWebView2;
        CompanionSessionManager? sessions = _runtime?.Server.Sessions;
        if (_disposed || coreWebView is null || sessions is null || !IsTrustedCurrentSource(source))
        {
            return;
        }

        try
        {
            CompanionCredential credential = sessions.ReplaceLocalCredential(_bundledOrigin, _localSessionId);
            _localSessionId = credential.SessionId;
            coreWebView.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                protocolVersion = 1,
                type = "companionBootstrap",
                token = credential.Token,
                expiresAtUtc = credential.ExpiresAtUtc.ToString("O", CultureInfo.InvariantCulture),
                port = _port,
            }));
        }
        catch (Exception exception) when (exception is InvalidOperationException or COMException)
        {
            ShowCompanionStatus(
                "The built-in visualizer couldn't connect. Disconnect browsers, then select Built-in visualizer.");
        }
    }

    private async void RunHostCommand(string? messageType)
    {
        if (_metadataRuntime is null)
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

    // Both the message's source and the WebView's current document must be the exact bundled page.
    private bool IsTrustedCurrentSource(string? source) =>
        CompanionSettings.IsTrustedBundledSource(source, _port) &&
        CompanionSettings.IsTrustedBundledSource(Visualizer.CoreWebView2?.Source, _port);

    // The hosted origin is non-secret startup configuration; changing it requires a restart.
    private CompanionSettings LoadCompanionSettings()
    {
        // Non-secret opt-in flag, read once so the invalid-origin fallback keeps the same mode.
        string? legacyEnrichment = Environment.GetEnvironmentVariable(LegacyEnrichmentVariable);
        try
        {
            CompanionSettings settings = CompanionSettings.FromStartupConfiguration(
                Environment.GetEnvironmentVariable(HostedOriginVariable), legacyEnrichment);
            OpenHostedButton.IsEnabled = settings.HostedOrigin is not null;
            HostedOriginText.Text = settings.HostedOrigin is string origin
                ? $"Hosted visualizer: {origin} (from {HostedOriginVariable}; restart the app to change it)"
                : $"Hosted visualizer not configured. Set {HostedOriginVariable} to its exact HTTPS origin and restart the app.";
            return settings;
        }
        catch (ArgumentException)
        {
            HostedOriginText.Text =
                $"{HostedOriginVariable} is not an exact HTTPS origin, so only the built-in visualizer is available. Fix it and restart the app.";
            return CompanionSettings.FromStartupConfiguration(null, legacyEnrichment);
        }
    }

    private void HandleRotatePairingCode(object sender, RoutedEventArgs e)
    {
        CompanionSessionManager? sessions = _runtime?.Server.Sessions;
        if (sessions is null)
        {
            return;
        }

        PairingChallenge challenge = sessions.CreatePairingChallenge();
        TimeSpan remaining = challenge.ExpiresAtUtc - DateTimeOffset.UtcNow;
        if (remaining <= TimeSpan.Zero)
        {
            ClearPairingCode();
            return;
        }

        PairingCodeBox.Text = challenge.Code;
        PairingCodeBox.Visibility = Visibility.Visible;
        CopyCodeButton.IsEnabled = true;
        PairingExpiryText.Text = $"Expires {challenge.ExpiresAtUtc.ToLocalTime():t}";
        _pairingCodeTimer.Stop();
        _pairingCodeTimer.Interval = remaining;
        _pairingCodeTimer.Start();
        ShowCompanionStatus("Enter this code in the browser's Connect Windows companion dialog. A new code replaces this one.");
    }

    private void HandleCopyPairingCode(object sender, RoutedEventArgs e)
    {
        if (PairingCodeBox.Text.Length == 0)
        {
            return;
        }

        try
        {
            Clipboard.SetText(PairingCodeBox.Text);
            ShowCompanionStatus("Code copied. It works once and expires within five minutes.");
        }
        catch (ExternalException)
        {
            ShowCompanionStatus("Couldn't use the clipboard. Select the code and copy it manually.");
        }
    }

    private void HandlePairingCodeExpired(object? sender, EventArgs e)
    {
        ClearPairingCode();
        ShowCompanionStatus("The pairing code expired. Create a new code when you're ready to pair.");
    }

    private void ClearPairingCode()
    {
        _pairingCodeTimer.Stop();
        PairingCodeBox.Clear();
        PairingCodeBox.Visibility = Visibility.Collapsed;
        CopyCodeButton.IsEnabled = false;
        PairingExpiryText.Text = string.Empty;
    }

    private void HandleDisconnectBrowsers(object sender, RoutedEventArgs e)
    {
        CompanionSessionManager? sessions = _runtime?.Server.Sessions;
        if (sessions is null || MessageBox.Show(this,
                "Disconnect every browser, including the built-in visualizer? Select Built-in visualizer afterwards to reconnect it.",
                "Disconnect browsers", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes)
        {
            return;
        }

        sessions.RevokeAll();
        _localSessionId = null;
        ClearPairingCode();
        ShowCompanionStatus("All browsers disconnected. Select Built-in visualizer to reconnect it, or create a new pairing code.");
    }

    // Opens only the origin active since startup.
    private void HandleOpenHosted(object sender, RoutedEventArgs e)
    {
        if (_companionSettings.HostedOrigin is not string origin)
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(origin + "/") { UseShellExecute = true })?.Dispose();
            ShowCompanionStatus("Opened the hosted visualizer in your browser. Create a pairing code to connect it.");
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException)
        {
            ShowCompanionStatus("Couldn't open your default browser.");
        }
    }

    // Reloads the bundled page; its ready request then receives a fresh local credential.
    private void HandleOpenBundled(object sender, RoutedEventArgs e)
    {
        if (Visualizer.CoreWebView2 is CoreWebView2 coreWebView && _bundledRoot.Length > 0)
        {
            coreWebView.Navigate(_bundledRoot);
            ShowCompanionStatus("Opening the built-in visualizer.");
        }
    }

    private void ShowCompanionStatus(string text) => CompanionStatusText.Text = text;

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
