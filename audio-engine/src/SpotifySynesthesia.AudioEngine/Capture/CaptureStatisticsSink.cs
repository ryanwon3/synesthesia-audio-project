namespace SpotifySynesthesia.AudioEngine.Capture;

public sealed class CaptureStatisticsSink : IAudioSampleSink
{
    private readonly object _sync = new();

    private long _packetCount;
    private long _frameCount;
    private long _nonSilentFrameCount;
    private long _positiveCrossingCount;
    private long _discontinuityCount;
    private double _sumSquares;
    private double _leftSumSquares;
    private double _rightSumSquares;
    private float _peak;
    private float _previousLeft;
    private bool _hasPreviousLeft;
    private int _sampleRate;
    private int _channelCount;

    public void Write(ReadOnlySpan<float> interleavedSamples, in AudioPacketInfo packetInfo)
    {
        if (packetInfo.ChannelCount <= 0 || interleavedSamples.Length % packetInfo.ChannelCount != 0)
        {
            throw new ArgumentException("Sample data must contain complete interleaved frames.", nameof(interleavedSamples));
        }

        lock (_sync)
        {
            _packetCount++;
            _frameCount += packetInfo.FrameCount;
            _sampleRate = packetInfo.SampleRate;
            _channelCount = packetInfo.ChannelCount;

            if (packetInfo.HasDiscontinuity)
            {
                _discontinuityCount++;
            }

            for (int frame = 0; frame < packetInfo.FrameCount; frame++)
            {
                int frameOffset = frame * packetInfo.ChannelCount;
                float left = Sanitize(interleavedSamples[frameOffset]);
                float right = packetInfo.ChannelCount > 1
                    ? Sanitize(interleavedSamples[frameOffset + 1])
                    : left;

                _leftSumSquares += left * left;
                _rightSumSquares += right * right;

                for (int channel = 0; channel < packetInfo.ChannelCount; channel++)
                {
                    float sample = Sanitize(interleavedSamples[frameOffset + channel]);
                    _sumSquares += sample * sample;
                    _peak = Math.Max(_peak, Math.Abs(sample));
                }

                if (Math.Abs(left) > 0.0001f || Math.Abs(right) > 0.0001f)
                {
                    _nonSilentFrameCount++;
                }

                if (_hasPreviousLeft && _previousLeft <= 0f && left > 0f)
                {
                    _positiveCrossingCount++;
                }

                _previousLeft = left;
                _hasPreviousLeft = true;
            }
        }
    }

    public CaptureStatisticsSnapshot GetSnapshot()
    {
        lock (_sync)
        {
            long sampleCount = _frameCount * Math.Max(_channelCount, 1);
            double durationSeconds = _sampleRate > 0 ? (double)_frameCount / _sampleRate : 0d;

            return new CaptureStatisticsSnapshot(
                PacketCount: _packetCount,
                FrameCount: _frameCount,
                NonSilentFrameCount: _nonSilentFrameCount,
                DiscontinuityCount: _discontinuityCount,
                SampleRate: _sampleRate,
                ChannelCount: _channelCount,
                DurationSeconds: durationSeconds,
                Rms: SafeRootMeanSquare(_sumSquares, sampleCount),
                LeftRms: SafeRootMeanSquare(_leftSumSquares, _frameCount),
                RightRms: SafeRootMeanSquare(_rightSumSquares, _frameCount),
                Peak: _peak,
                EstimatedFrequencyHz: durationSeconds > 0d ? _positiveCrossingCount / durationSeconds : 0d);
        }
    }

    private static float Sanitize(float sample) => float.IsFinite(sample) ? Math.Clamp(sample, -1f, 1f) : 0f;

    private static double SafeRootMeanSquare(double sumSquares, long sampleCount) =>
        sampleCount > 0 && double.IsFinite(sumSquares)
            ? Math.Sqrt(sumSquares / sampleCount)
            : 0d;
}

public sealed record CaptureStatisticsSnapshot(
    long PacketCount,
    long FrameCount,
    long NonSilentFrameCount,
    long DiscontinuityCount,
    int SampleRate,
    int ChannelCount,
    double DurationSeconds,
    double Rms,
    double LeftRms,
    double RightRms,
    float Peak,
    double EstimatedFrequencyHz)
{
    public bool HasSignal => Peak > 0.001f && Rms > 0.0001d;

    public double NonSilentRatio => FrameCount > 0 ? (double)NonSilentFrameCount / FrameCount : 0d;
}
