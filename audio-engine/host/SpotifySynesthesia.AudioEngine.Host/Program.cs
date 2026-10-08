using System.Globalization;
using SpotifySynesthesia.AudioEngine.Capture;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Host;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        HostArguments options;
        AudioFrameWebSocketServerOptions serverOptions;
        try
        {
            options = HostArguments.Parse(args);
            // The options policy validates each exact origin; authentication stays required.
            serverOptions = new(options.Port, allowedBrowserOrigins: options.AllowedOrigins);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine(exception.Message);
            Console.Error.WriteLine(HostArguments.Usage);
            return 2;
        }

        using CancellationTokenSource shutdown = new();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            shutdown.Cancel();
        };

        await using AudioEngineRuntime runtime = new(serverOptions);
        await runtime.StartServerAsync(shutdown.Token);

        Console.WriteLine($"AudioFrame server: {serverOptions.WebSocketUri}");
        Console.WriteLine($"Health endpoint: {serverOptions.HealthUri}");
        Console.WriteLine(
            "This diagnostic host cannot issue pairing codes. Use the Windows app to pair a browser.");
        Console.WriteLine(options.ProcessId is int processId
            ? $"Target PID: {processId}"
            : $"Waiting for process: {options.ProcessName}");
        Console.WriteLine("Press Ctrl+C to stop.");

        try
        {
            return await RunMonitoredCaptureAsync(runtime, options, shutdown.Token);
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
        {
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Capture stopped and will not restart: {exception.Message}");
            return 1;
        }
    }

    private static async Task<int> RunMonitoredCaptureAsync(
        AudioEngineRuntime runtime,
        HostArguments options,
        CancellationToken cancellationToken)
    {
        bool captureStarted = false;
        ProcessCaptureMonitor monitor = new(
            runtime,
            () => ResolveProcessId(options),
            ProcessTargetLocator.IsAlive);
        monitor.StatusChanged += status =>
        {
            captureStarted |= status.Kind == ProcessCaptureMonitorEventKind.CaptureStarted;
            WriteStatus(runtime, status);
        };

        await monitor.RunAsync(waitForTargetRestart: !options.ProcessId.HasValue, cancellationToken);

        if (options.ProcessId is int processId && !captureStarted)
        {
            Console.Error.WriteLine($"Target PID {processId} is not running.");
            return 1;
        }

        return 0;
    }

    private static int? ResolveProcessId(HostArguments options)
    {
        if (options.ProcessId is int processId)
        {
            return ProcessTargetLocator.IsAlive(processId) ? processId : null;
        }

        return ProcessTargetLocator.FindOldestExactMatch(options.ProcessName)?.ProcessId;
    }

    // Raised from the monitor task, never from the capture thread.
    private static void WriteStatus(AudioEngineRuntime runtime, ProcessCaptureMonitorEvent status)
    {
        switch (status.Kind)
        {
            case ProcessCaptureMonitorEventKind.WaitingForTarget:
                Console.WriteLine("Waiting for the target process to start.");
                break;
            case ProcessCaptureMonitorEventKind.CaptureStarted:
                Console.WriteLine($"Capturing process tree rooted at PID {status.ProcessId}.");
                break;
            case ProcessCaptureMonitorEventKind.Heartbeat:
                AudioEngineRuntimeSnapshot snapshot = runtime.GetSnapshot();
                Console.WriteLine(
                    $"state={snapshot.CaptureState} clients={snapshot.ConnectedClients} " +
                    $"frame={snapshot.LatestSequence} dsp={snapshot.CaptureToDspMilliseconds:F2}ms");
                break;
            case ProcessCaptureMonitorEventKind.TargetExited:
                Console.WriteLine($"Target process {status.ProcessId} exited.");
                break;
            case ProcessCaptureMonitorEventKind.CaptureStopped when status.Error is not null:
                Console.Error.WriteLine($"Capture stopped for PID {status.ProcessId}: {status.Error.Message}");
                break;
            case ProcessCaptureMonitorEventKind.CaptureStopped:
                Console.WriteLine($"Capture stopped for PID {status.ProcessId}.");
                break;
            case ProcessCaptureMonitorEventKind.Restarting:
                Console.WriteLine($"Restarting capture for PID {status.ProcessId}.");
                break;
        }
    }
}

internal sealed record HostArguments(int? ProcessId, string ProcessName, int Port, IReadOnlyList<string> AllowedOrigins)
{
    private const int MaxAllowedOrigins = 8;

    public const string Usage =
        "Usage: AudioEngine.Host [--pid <id> | --process-name <name>] [--port <1024-65535>] " +
        "[--allowed-origin <exact-origin>]...";

    public static HostArguments Parse(string[] args)
    {
        int? processId = null;
        string processName = "Spotify";
        int port = 8765;
        List<string> allowedOrigins = [];

        for (int index = 0; index < args.Length; index++)
        {
            string argument = args[index];
            string value = index + 1 < args.Length ? args[++index] :
                throw new ArgumentException($"Missing value for {argument}.");

            switch (argument)
            {
                case "--pid":
                    processId = ParseInt(value, argument);
                    break;
                case "--process-name":
                    processName = string.IsNullOrWhiteSpace(value)
                        ? throw new ArgumentException("--process-name cannot be empty.")
                        : Path.GetFileNameWithoutExtension(value);
                    break;
                case "--port":
                    port = ParseInt(value, argument);
                    if (port is < 1024 or > 65535)
                    {
                        throw new ArgumentException("--port must be between 1024 and 65535.");
                    }

                    break;
                case "--allowed-origin":
                    if (allowedOrigins.Count >= MaxAllowedOrigins)
                    {
                        throw new ArgumentException($"--allowed-origin can be given at most {MaxAllowedOrigins} times.");
                    }

                    allowedOrigins.Add(value);
                    break;
                default:
                    throw new ArgumentException($"Unknown argument '{argument}'.");
            }
        }

        return new HostArguments(processId, processName, port, allowedOrigins);
    }

    private static int ParseInt(string value, string argument)
    {
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int result) || result <= 0)
        {
            throw new ArgumentException($"{argument} requires a positive integer.");
        }

        return result;
    }
}
