namespace SpotifySynesthesia.TestTonePlayer.Signals;

public enum TestSignalKind
{
    Sine100Hz,
    Sine440Hz,
    Sine1000Hz,
    WhiteNoise,
    Pulse440Hz,
}

public static class TestSignalKindExtensions
{
    public static string GetDisplayName(this TestSignalKind signal) => signal switch
    {
        TestSignalKind.Sine100Hz => "100 Hz sine",
        TestSignalKind.Sine440Hz => "440 Hz sine",
        TestSignalKind.Sine1000Hz => "1000 Hz sine",
        TestSignalKind.WhiteNoise => "White noise",
        TestSignalKind.Pulse440Hz => "440 Hz repeating pulse",
        _ => throw new ArgumentOutOfRangeException(nameof(signal), signal, "Unknown test signal."),
    };

    public static double GetFrequencyHz(this TestSignalKind signal) => signal switch
    {
        TestSignalKind.Sine100Hz => 100d,
        TestSignalKind.Sine440Hz or TestSignalKind.Pulse440Hz => 440d,
        TestSignalKind.Sine1000Hz => 1000d,
        TestSignalKind.WhiteNoise => 0d,
        _ => throw new ArgumentOutOfRangeException(nameof(signal), signal, "Unknown test signal."),
    };
}
