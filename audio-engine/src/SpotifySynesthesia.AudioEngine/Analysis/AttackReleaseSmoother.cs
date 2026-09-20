namespace SpotifySynesthesia.AudioEngine.Analysis;

internal sealed class AttackReleaseSmoother
{
    private readonly double _attackSeconds;
    private readonly double _releaseSeconds;
    private bool _initialized;

    public AttackReleaseSmoother(double attackSeconds, double releaseSeconds)
    {
        _attackSeconds = attackSeconds;
        _releaseSeconds = releaseSeconds;
    }

    public double Value { get; private set; }

    public double Update(double target, double elapsedSeconds)
    {
        target = Normalize(target);

        if (!_initialized)
        {
            Value = target;
            _initialized = true;
            return Value;
        }

        double timeConstant = target > Value ? _attackSeconds : _releaseSeconds;
        double coefficient = timeConstant <= 0d
            ? 0d
            : Math.Exp(-Math.Max(elapsedSeconds, 0d) / timeConstant);
        Value = Normalize((coefficient * Value) + ((1d - coefficient) * target));
        return Value;
    }

    private static double Normalize(double value) =>
        double.IsFinite(value) ? Math.Clamp(value, 0d, 1d) : 0d;
}
