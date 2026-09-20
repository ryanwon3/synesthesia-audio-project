using NAudio.Wave;

namespace SpotifySynesthesia.TestTonePlayer.Signals;

public sealed class TestSignalSampleProvider : ISampleProvider
{
    private readonly TestSignalSettings _settings;
    private readonly Random _random;
    private readonly int _fadeFrameCount;
    private readonly long _pulseOnFrameCount;
    private readonly long _pulsePeriodFrameCount;
    private readonly double _phaseIncrement;

    private long _frameIndex;
    private double _phase;
    private int _nextChannel;
    private float _currentLeftSample;
    private float _currentRightSample;
    private int _fadeOutFramesRemaining = -1;
    private float _level;

    public TestSignalSampleProvider(TestSignalSettings settings, int? randomSeed = null)
    {
        ArgumentNullException.ThrowIfNull(settings);

        _settings = settings;
        _random = randomSeed.HasValue ? new Random(randomSeed.Value) : Random.Shared;
        _fadeFrameCount = (int)Math.Round(
            settings.FadeDuration.TotalSeconds * settings.SampleRate,
            MidpointRounding.AwayFromZero);
        _pulseOnFrameCount = (long)Math.Round(
            TestSignalSettings.PulseOnDuration.TotalSeconds * settings.SampleRate,
            MidpointRounding.AwayFromZero);
        _pulsePeriodFrameCount = (long)Math.Round(
            TestSignalSettings.PulsePeriod.TotalSeconds * settings.SampleRate,
            MidpointRounding.AwayFromZero);
        _phaseIncrement = 2d * Math.PI * settings.Signal.GetFrequencyHz() / settings.SampleRate;
        _level = settings.Level;

        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(settings.SampleRate, channels: 2);
    }

    public WaveFormat WaveFormat { get; }

    public float Level
    {
        get => Volatile.Read(ref _level);
        set
        {
            TestSignalSettings.ValidateLevel(value);
            Volatile.Write(ref _level, value);
        }
    }

    public bool IsFadeOutComplete => Volatile.Read(ref _fadeOutFramesRemaining) == 0;

    public void BeginFadeOut()
    {
        int remaining = _fadeFrameCount;
        Interlocked.CompareExchange(ref _fadeOutFramesRemaining, remaining, comparand: -1);
    }

    public int Read(float[] buffer, int offset, int count)
    {
        ArgumentNullException.ThrowIfNull(buffer);

        if (offset < 0 || count < 0 || offset > buffer.Length - count)
        {
            throw new ArgumentOutOfRangeException(nameof(offset), "Offset and count must fit within the buffer.");
        }

        for (int index = 0; index < count; index++)
        {
            if (_nextChannel == 0)
            {
                PrepareFrame();
                buffer[offset + index] = _currentLeftSample;
                _nextChannel = 1;
            }
            else
            {
                buffer[offset + index] = _currentRightSample;
                _nextChannel = 0;
                CompleteFrame();
            }
        }

        return count;
    }

    private void PrepareFrame()
    {
        float monoSample = GenerateMonoSample();
        float envelope = GetEnvelope();
        float sample = Math.Clamp(monoSample * Level * envelope, -TestSignalSettings.MaximumLevel, TestSignalSettings.MaximumLevel);

        if (!float.IsFinite(sample))
        {
            sample = 0f;
        }

        (_currentLeftSample, _currentRightSample) = _settings.ChannelMode switch
        {
            ChannelMode.Stereo => (sample, sample),
            ChannelMode.LeftOnly => (sample, 0f),
            ChannelMode.RightOnly => (0f, sample),
            _ => (0f, 0f),
        };
    }

    private float GenerateMonoSample()
    {
        return _settings.Signal switch
        {
            TestSignalKind.Sine100Hz or
            TestSignalKind.Sine440Hz or
            TestSignalKind.Sine1000Hz => (float)Math.Sin(_phase),
            TestSignalKind.WhiteNoise => (float)((_random.NextDouble() * 2d) - 1d),
            TestSignalKind.Pulse440Hz when (_frameIndex % _pulsePeriodFrameCount) < _pulseOnFrameCount =>
                (float)Math.Sin(_phase),
            TestSignalKind.Pulse440Hz => 0f,
            _ => 0f,
        };
    }

    private float GetEnvelope()
    {
        float fadeIn = _fadeFrameCount == 0 || _frameIndex >= _fadeFrameCount
            ? 1f
            : (float)(_frameIndex + 1) / _fadeFrameCount;

        int fadeOutRemaining = Volatile.Read(ref _fadeOutFramesRemaining);
        float fadeOut = fadeOutRemaining switch
        {
            < 0 => 1f,
            0 => 0f,
            _ when _fadeFrameCount == 0 => 0f,
            _ => (float)fadeOutRemaining / _fadeFrameCount,
        };

        return Math.Min(fadeIn, fadeOut);
    }

    private void CompleteFrame()
    {
        _frameIndex++;

        if (_phaseIncrement > 0d)
        {
            _phase += _phaseIncrement;
            if (_phase >= 2d * Math.PI)
            {
                _phase -= 2d * Math.PI;
            }
        }

        int fadeOutRemaining = Volatile.Read(ref _fadeOutFramesRemaining);
        if (fadeOutRemaining > 0)
        {
            Interlocked.Decrement(ref _fadeOutFramesRemaining);
        }
    }
}
