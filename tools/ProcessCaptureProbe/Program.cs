using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Capture;

namespace SpotifySynesthesia.ProcessCaptureProbe;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    public static async Task<int> Main(string[] args)
    {
        ProbeArguments options;
        try
        {
            options = ProbeArguments.Parse(args);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine(exception.Message);
            Console.Error.WriteLine(ProbeArguments.Usage);
            return 2;
        }

        using CancellationTokenSource cancellation = new();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };

        CaptureStatisticsSink sink = new();
        RealTimeAudioAnalyzer analyzer = new();
        AudioFrame? latestAudioFrame = null;
        long analysisFrameCount = 0;
        analyzer.FrameProduced += frame =>
        {
            latestAudioFrame = frame;
            analysisFrameCount++;
        };
        CompositeAudioSampleSink compositeSink = new(sink, analyzer);
        await using ProcessLoopbackCapture capture = new();
        List<ProcessLoopbackCaptureState> states = [];
        capture.StateChanged += states.Add;

        Stopwatch timer = Stopwatch.StartNew();
        await capture.StartAsync(
            new ProcessLoopbackCaptureOptions(options.ProcessId),
            compositeSink,
            cancellation.Token);
        await Task.Delay(options.Duration, cancellation.Token);
        await capture.StopAsync(cancellation.Token);
        timer.Stop();

        CaptureStatisticsSnapshot statistics = sink.GetSnapshot();
        (bool passed, string expectationMessage) = EvaluateExpectation(options, statistics);
        CaptureProbeResult result = new(
            TargetProcessId: options.ProcessId,
            RequestedDurationSeconds: options.Duration.TotalSeconds,
            WallClockDurationSeconds: timer.Elapsed.TotalSeconds,
            Expectation: options.Expectation,
            ExpectedFrequencyHz: options.ExpectedFrequencyHz,
            Passed: passed,
            ExpectationMessage: expectationMessage,
            StateHistory: states,
            Statistics: statistics,
            AnalysisFrameCount: analysisFrameCount,
            LatestAudioFrame: latestAudioFrame);

        Console.WriteLine(JsonSerializer.Serialize(result, JsonOptions));
        return passed ? 0 : 1;
    }

    private static (bool Passed, string Message) EvaluateExpectation(
        ProbeArguments options,
        CaptureStatisticsSnapshot statistics)
    {
        if (options.Expectation == ProbeExpectation.Signal && !statistics.HasSignal)
        {
            return (false, "Expected a non-silent target stream, but no signal was detected.");
        }

        if (options.Expectation == ProbeExpectation.Silence && statistics.HasSignal)
        {
            return (false, "Expected target silence, but captured samples contained a signal.");
        }

        if (options.ExpectedFrequencyHz is double expectedFrequency)
        {
            double tolerance = Math.Max(5d, expectedFrequency * 0.05d);
            double difference = Math.Abs(statistics.EstimatedFrequencyHz - expectedFrequency);
            if (!statistics.HasSignal || difference > tolerance)
            {
                return (
                    false,
                    $"Expected approximately {expectedFrequency:F1} Hz (+/- {tolerance:F1}), " +
                    $"measured {statistics.EstimatedFrequencyHz:F1} Hz.");
            }
        }

        return (true, "Capture matched the requested expectation.");
    }

    private sealed record CaptureProbeResult(
        int TargetProcessId,
        double RequestedDurationSeconds,
        double WallClockDurationSeconds,
        ProbeExpectation Expectation,
        double? ExpectedFrequencyHz,
        bool Passed,
        string ExpectationMessage,
        IReadOnlyList<ProcessLoopbackCaptureState> StateHistory,
        CaptureStatisticsSnapshot Statistics,
        long AnalysisFrameCount,
        AudioFrame? LatestAudioFrame);
}

internal enum ProbeExpectation
{
    Any,
    Signal,
    Silence,
}

internal sealed record ProbeArguments(
    int ProcessId,
    TimeSpan Duration,
    ProbeExpectation Expectation,
    double? ExpectedFrequencyHz)
{
    public const string Usage =
        "Usage: ProcessCaptureProbe --pid <id> [--duration <seconds>] " +
        "[--expect any|signal|silence] [--expected-frequency <hz>]";

    public static ProbeArguments Parse(string[] args)
    {
        int? processId = null;
        double durationSeconds = 3d;
        ProbeExpectation expectation = ProbeExpectation.Any;
        double? expectedFrequency = null;

        for (int index = 0; index < args.Length; index++)
        {
            string argument = args[index];
            string value = index + 1 < args.Length ? args[++index] :
                throw new ArgumentException($"Missing value for {argument}.");

            switch (argument)
            {
                case "--pid":
                    processId = ParsePositiveInt(value, argument);
                    break;
                case "--duration":
                    durationSeconds = ParsePositiveDouble(value, argument);
                    break;
                case "--expect":
                    if (!Enum.TryParse(value, ignoreCase: true, out expectation))
                    {
                        throw new ArgumentException($"Unknown expectation '{value}'.");
                    }

                    break;
                case "--expected-frequency":
                    expectedFrequency = ParsePositiveDouble(value, argument);
                    break;
                default:
                    throw new ArgumentException($"Unknown argument '{argument}'.");
            }
        }

        if (processId is null)
        {
            throw new ArgumentException("--pid is required.");
        }

        if (durationSeconds > 60d)
        {
            throw new ArgumentException("Capture duration cannot exceed 60 seconds.");
        }

        return new ProbeArguments(
            processId.Value,
            TimeSpan.FromSeconds(durationSeconds),
            expectation,
            expectedFrequency);
    }

    private static int ParsePositiveInt(string value, string argument)
    {
        if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed) || parsed <= 0)
        {
            throw new ArgumentException($"{argument} requires a positive integer.");
        }

        return parsed;
    }

    private static double ParsePositiveDouble(string value, string argument)
    {
        if (!double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out double parsed) ||
            !double.IsFinite(parsed) ||
            parsed <= 0d)
        {
            throw new ArgumentException($"{argument} requires a positive finite number.");
        }

        return parsed;
    }
}
