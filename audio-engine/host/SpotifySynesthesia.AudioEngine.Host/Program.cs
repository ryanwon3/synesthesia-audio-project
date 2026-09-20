using System.Diagnostics;
using System.Globalization;
using SpotifySynesthesia.AudioEngine.Capture;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Host;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        HostArguments options;
        try
        {
            options = HostArguments.Parse(args);
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

        AudioFrameWebSocketServerOptions serverOptions = new(options.Port);
        await using AudioEngineRuntime runtime = new(serverOptions);
        await runtime.StartServerAsync(shutdown.Token);

        Console.WriteLine($"AudioFrame server: {serverOptions.WebSocketUri}");
        Console.WriteLine($"Health endpoint: {serverOptions.HealthUri}");
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
    }

    private static async Task<int> RunMonitoredCaptureAsync(
        AudioEngineRuntime runtime,
        HostArguments options,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            int? processId = options.ProcessId ??
                ProcessTargetLocator.FindOldestExactMatch(options.ProcessName)?.ProcessId;
            if (processId is null)
            {
                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
                continue;
            }

            try
            {
                await runtime.StartCaptureAsync(processId.Value, cancellationToken);
                Console.WriteLine($"Capturing process tree rooted at PID {processId.Value}.");
                await MonitorSessionAsync(runtime, processId.Value, cancellationToken);
                await runtime.StopCaptureAsync(CancellationToken.None);

                if (options.ProcessId.HasValue)
                {
                    return 0;
                }

                Console.WriteLine("Target process exited; waiting for it to restart.");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine($"Capture failed for PID {processId.Value}: {exception.Message}");

                if (options.ProcessId.HasValue)
                {
                    return 1;
                }

                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
            }
        }

        return 0;
    }

    private static async Task MonitorSessionAsync(
        AudioEngineRuntime runtime,
        int processId,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && IsProcessAlive(processId))
        {
            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
            AudioEngineRuntimeSnapshot snapshot = runtime.GetSnapshot();
            Console.WriteLine(
                $"state={snapshot.CaptureState} clients={snapshot.ConnectedClients} " +
                $"frame={snapshot.LatestSequence} dsp={snapshot.CaptureToDspMilliseconds:F2}ms");
        }
    }

    private static bool IsProcessAlive(int processId)
    {
        try
        {
            using Process process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}

internal sealed record HostArguments(int? ProcessId, string ProcessName, int Port)
{
    public const string Usage =
        "Usage: AudioEngine.Host [--pid <id> | --process-name <name>] [--port <1024-65535>]";

    public static HostArguments Parse(string[] args)
    {
        int? processId = null;
        string processName = "Spotify";
        int port = 8765;

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
                default:
                    throw new ArgumentException($"Unknown argument '{argument}'.");
            }
        }

        return new HostArguments(processId, processName, port);
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
