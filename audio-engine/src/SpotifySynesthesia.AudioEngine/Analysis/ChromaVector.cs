namespace SpotifySynesthesia.AudioEngine.Analysis;

public sealed record ChromaVector(
    double C,
    double CSharp,
    double D,
    double DSharp,
    double E,
    double F,
    double FSharp,
    double G,
    double GSharp,
    double A,
    double ASharp,
    double B)
{
    public double this[PitchClass pitchClass] => pitchClass switch
    {
        PitchClass.C => C,
        PitchClass.CSharp => CSharp,
        PitchClass.D => D,
        PitchClass.DSharp => DSharp,
        PitchClass.E => E,
        PitchClass.F => F,
        PitchClass.FSharp => FSharp,
        PitchClass.G => G,
        PitchClass.GSharp => GSharp,
        PitchClass.A => A,
        PitchClass.ASharp => ASharp,
        PitchClass.B => B,
        _ => 0d,
    };

    internal static ChromaVector From(ReadOnlySpan<double> values) => new(
        values[(int)PitchClass.C],
        values[(int)PitchClass.CSharp],
        values[(int)PitchClass.D],
        values[(int)PitchClass.DSharp],
        values[(int)PitchClass.E],
        values[(int)PitchClass.F],
        values[(int)PitchClass.FSharp],
        values[(int)PitchClass.G],
        values[(int)PitchClass.GSharp],
        values[(int)PitchClass.A],
        values[(int)PitchClass.ASharp],
        values[(int)PitchClass.B]);
}
