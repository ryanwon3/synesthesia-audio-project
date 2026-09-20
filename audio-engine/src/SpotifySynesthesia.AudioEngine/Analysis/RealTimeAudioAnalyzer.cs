using System.Diagnostics;
using System.Numerics;
using NAudio.Dsp;
using SpotifySynesthesia.AudioEngine.Capture;
using DspComplex = NAudio.Dsp.Complex;

namespace SpotifySynesthesia.AudioEngine.Analysis;

public sealed class RealTimeAudioAnalyzer : IAudioSampleSink
{
    private const double ChromaLowerHz = 50d;
    private const double ChromaUpperHz = 5_000d;

    private readonly object _sync = new();
    private readonly AudioAnalyzerOptions _options;
    private readonly float[] _leftHistory;
    private readonly float[] _rightHistory;
    private readonly DspComplex[] _fftBuffer;
    private readonly double[] _magnitudes;
    private readonly double[] _previousMagnitudes;
    private readonly double[] _rawChroma = new double[12];
    private readonly double[] _smoothedChroma = new double[12];
    private readonly BandAnalyzer[] _bands;
    private readonly AttackReleaseSmoother[] _chromaSmoothers;
    private readonly AttackReleaseSmoother _rmsSmoother = new(0.03d, 0.20d);
    private readonly AttackReleaseSmoother _bassSmoother = new(0.03d, 0.15d);
    private readonly AttackReleaseSmoother _midSmoother = new(0.05d, 0.20d);
    private readonly AttackReleaseSmoother _trebleSmoother = new(0.03d, 0.15d);
    private readonly AttackReleaseSmoother _centroidSmoother = new(0.08d, 0.30d);
    private readonly AttackReleaseSmoother _fluxSmoother = new(0.01d, 0.08d);
    private readonly AttackReleaseSmoother _onsetSmoother = new(0.005d, 0.12d);
    private readonly AttackReleaseSmoother _balanceSmoother = new(0.08d, 0.30d);
    private readonly AttackReleaseSmoother _widthSmoother = new(0.08d, 0.30d);

    private int _writeIndex;
    private int _historyFrameCount;
    private int _framesSinceAnalysis;
    private long _sequence;
    private long _latestCaptureTimestamp;
    private bool _hasPreviousSpectrum;

    public RealTimeAudioAnalyzer(AudioAnalyzerOptions? options = null)
    {
        _options = options ?? new AudioAnalyzerOptions();
        _bands = [new(_options.LayerChromaUpperHz), new(_options.LayerChromaUpperHz), new(_options.LayerChromaUpperHz)];
        _leftHistory = new float[_options.FftSize];
        _rightHistory = new float[_options.FftSize];
        _fftBuffer = new DspComplex[_options.FftSize];
        _magnitudes = new double[(_options.FftSize / 2) + 1];
        _previousMagnitudes = new double[_magnitudes.Length];
        _chromaSmoothers = Enumerable
            .Range(0, 12)
            .Select(_ => new AttackReleaseSmoother(0.08d, 0.35d))
            .ToArray();
    }

    public event Action<AudioFrame>? FrameProduced;

    public AudioAnalyzerOptions Options => _options;

    public void Write(ReadOnlySpan<float> interleavedSamples, in AudioPacketInfo packetInfo)
    {
        if (packetInfo.SampleRate != _options.SampleRate || packetInfo.ChannelCount != _options.ChannelCount)
        {
            throw new ArgumentException(
                "Captured PCM format does not match the analyzer configuration.",
                nameof(packetInfo));
        }

        if (interleavedSamples.Length != packetInfo.FrameCount * packetInfo.ChannelCount)
        {
            throw new ArgumentException("Sample data does not match the packet frame count.", nameof(interleavedSamples));
        }

        lock (_sync)
        {
            _latestCaptureTimestamp = packetInfo.CaptureTimestamp;

            for (int frame = 0; frame < packetInfo.FrameCount; frame++)
            {
                int offset = frame * packetInfo.ChannelCount;
                float left = Sanitize(interleavedSamples[offset]);
                float right = packetInfo.ChannelCount > 1 ? Sanitize(interleavedSamples[offset + 1]) : left;

                _leftHistory[_writeIndex] = left;
                _rightHistory[_writeIndex] = right;
                _writeIndex = (_writeIndex + 1) % _options.FftSize;
                _historyFrameCount = Math.Min(_historyFrameCount + 1, _options.FftSize);
                _framesSinceAnalysis++;

                if (_historyFrameCount == _options.FftSize && _framesSinceAnalysis >= _options.HopSize)
                {
                    _framesSinceAnalysis -= _options.HopSize;
                    AudioFrame audioFrame = AnalyzeCurrentWindow();
                    FrameProduced?.Invoke(audioFrame);
                }
            }
        }
    }

    private AudioFrame AnalyzeCurrentWindow()
    {
        double leftSumSquares = 0d;
        double rightSumSquares = 0d;
        double monoSumSquares = 0d;
        double midSumSquares = 0d;
        double sideSumSquares = 0d;

        for (int index = 0; index < _options.FftSize; index++)
        {
            int historyIndex = (_writeIndex + index) % _options.FftSize;
            double left = _leftHistory[historyIndex];
            double right = _rightHistory[historyIndex];
            double mono = (left + right) * 0.5d;
            double mid = mono;
            double side = (left - right) * 0.5d;
            double window = 0.5d * (1d - Math.Cos(2d * Math.PI * index / (_options.FftSize - 1d)));

            leftSumSquares += left * left;
            rightSumSquares += right * right;
            monoSumSquares += mono * mono;
            midSumSquares += mid * mid;
            sideSumSquares += side * side;
            _fftBuffer[index].X = (float)(mono * window);
            _fftBuffer[index].Y = 0f;
        }

        FastFourierTransform.FFT(
            forward: true,
            m: BitOperations.Log2(checked((uint)_options.FftSize)),
            _fftBuffer);

        Array.Clear(_rawChroma);
        foreach (BandAnalyzer band in _bands) band.Begin();
        double bassPower = 0d;
        double midPower = 0d;
        double treblePower = 0d;
        double magnitudeSum = 0d;
        double centroidNumerator = 0d;
        double positiveFlux = 0d;
        double chromaSum = 0d;
        double frequencyResolution = (double)_options.SampleRate / _options.FftSize;
        double nyquist = _options.SampleRate * 0.5d;
        // NAudio normalizes the forward transform by N; double positive-frequency bins.
        const double magnitudeScale = 2d;

        for (int bin = 1; bin < _magnitudes.Length; bin++)
        {
            double real = _fftBuffer[bin].X;
            double imaginary = _fftBuffer[bin].Y;
            double magnitude = Math.Sqrt((real * real) + (imaginary * imaginary)) * magnitudeScale;
            magnitude = NormalizeFinite(magnitude);
            _magnitudes[bin] = magnitude;

            double frequency = bin * frequencyResolution;
            double power = magnitude * magnitude;
            int bandIndex = frequency < _options.BassUpperHz ? 0 : frequency < _options.MidUpperHz ? 1 : 2;
            _bands[bandIndex].Add(frequency, power,
                _hasPreviousSpectrum ? Math.Max(0d, magnitude - _previousMagnitudes[bin]) : 0d);

            if (frequency < _options.BassUpperHz)
            {
                bassPower += power;
            }
            else if (frequency < _options.MidUpperHz)
            {
                midPower += power;
            }
            else
            {
                treblePower += power;
            }

            magnitudeSum += magnitude;
            centroidNumerator += frequency * magnitude;

            if (_hasPreviousSpectrum)
            {
                positiveFlux += Math.Max(0d, magnitude - _previousMagnitudes[bin]);
            }

            _previousMagnitudes[bin] = magnitude;

            if (frequency is >= ChromaLowerHz and <= ChromaUpperHz && magnitude > 0d)
            {
                double midiNote = 69d + (12d * Math.Log2(frequency / 440d));
                int pitchClass = ((int)Math.Round(midiNote) % 12 + 12) % 12;
                _rawChroma[pitchClass] += power;
                chromaSum += power;
            }
        }

        _hasPreviousSpectrum = true;
        double elapsedSeconds = (double)_options.HopSize / _options.SampleRate;
        double rms = Math.Sqrt(monoSumSquares / _options.FftSize);
        double leftRms = Math.Sqrt(leftSumSquares / _options.FftSize);
        double rightRms = Math.Sqrt(rightSumSquares / _options.FftSize);
        double balance = (leftRms + rightRms) > 1e-9d ? rightRms / (leftRms + rightRms) : 0.5d;
        double midRms = Math.Sqrt(midSumSquares / _options.FftSize);
        double sideRms = Math.Sqrt(sideSumSquares / _options.FftSize);
        double width = sideRms / Math.Max(midRms + sideRms, 1e-9d);
        double centroid = magnitudeSum > 1e-12d ? centroidNumerator / magnitudeSum / nyquist : 0d;
        double flux = Math.Clamp(positiveFlux * 8d, 0d, 1d);
        double onset = Math.Clamp(flux * 2.5d, 0d, 1d);

        double maxChroma = 0d;
        int dominantChroma = 0;
        for (int pitchClass = 0; pitchClass < _smoothedChroma.Length; pitchClass++)
        {
            double normalizedChroma = chromaSum > 1e-12d ? _rawChroma[pitchClass] / chromaSum : 0d;
            _smoothedChroma[pitchClass] = _chromaSmoothers[pitchClass].Update(normalizedChroma, elapsedSeconds);

            if (_smoothedChroma[pitchClass] > maxChroma)
            {
                maxChroma = _smoothedChroma[pitchClass];
                dominantChroma = pitchClass;
            }
        }

        double smoothedChromaSum = _smoothedChroma.Sum();
        double chromaConfidence = smoothedChromaSum > 1e-12d
            ? Math.Clamp(maxChroma / smoothedChromaSum, 0d, 1d)
            : 0d;
        PitchClass? dominantPitchClass = rms > 0.0001d && chromaConfidence > 0.12d
            ? (PitchClass)dominantChroma
            : null;

        return new AudioFrame(
            Sequence: ++_sequence,
            TimestampUnixMilliseconds: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            CaptureTimestamp: _latestCaptureTimestamp,
            DspCompletedTimestamp: Stopwatch.GetTimestamp(),
            Rms: _rmsSmoother.Update(rms, elapsedSeconds),
            BassEnergy: _bassSmoother.Update(Math.Sqrt(bassPower) * 2d, elapsedSeconds),
            MidEnergy: _midSmoother.Update(Math.Sqrt(midPower) * 2d, elapsedSeconds),
            TrebleEnergy: _trebleSmoother.Update(Math.Sqrt(treblePower) * 2d, elapsedSeconds),
            SpectralCentroid: _centroidSmoother.Update(centroid, elapsedSeconds),
            SpectralFlux: _fluxSmoother.Update(flux, elapsedSeconds),
            OnsetStrength: _onsetSmoother.Update(onset, elapsedSeconds),
            StereoBalance: _balanceSmoother.Update(balance, elapsedSeconds),
            StereoWidth: _widthSmoother.Update(width, elapsedSeconds),
            Chroma: ChromaVector.From(_smoothedChroma),
            DominantPitchClass: dominantPitchClass,
            ChromaConfidence: NormalizeFinite(chromaConfidence),
            Bass: _bands[0].Complete(elapsedSeconds),
            Mid: _bands[1].Complete(elapsedSeconds),
            Treble: _bands[2].Complete(elapsedSeconds));
    }

    private static float Sanitize(float sample) =>
        float.IsFinite(sample) ? Math.Clamp(sample, -1f, 1f) : 0f;

    private static double NormalizeFinite(double value) =>
        double.IsFinite(value) ? Math.Clamp(value, 0d, 1d) : 0d;

    // Reuses the existing FFT; all work buffers are allocated at construction.
    private sealed class BandAnalyzer(double chromaUpperHz)
    {
        private readonly double[] _raw = new double[12];
        private readonly double[] _smooth = new double[12];
        private double _power, _flux;
        public void Begin() { Array.Clear(_raw); _power = _flux = 0; }
        public void Add(double hz, double power, double flux)
        {
            _flux += flux;
            if (hz < 50 || hz > chromaUpperHz) return;
            int pitch = ((int)Math.Round(69 + 12 * Math.Log2(hz / 440)) % 12 + 12) % 12;
            _raw[pitch] += power;
            _power += power;
        }
        public AudioBandFrame Complete(double delta)
        {
            double sum = 0, maximum = 0;
            double alpha = 1 - Math.Exp(-delta / 0.12);
            for (int i = 0; i < 12; i++)
            {
                _smooth[i] += ((_power > 1e-10 ? _raw[i] / _power : 0) - _smooth[i]) * alpha;
                sum += _smooth[i]; maximum = Math.Max(maximum, _smooth[i]);
            }
            return new(ChromaVector.From(_smooth), _power > 1e-8 && sum > 0 ? maximum / sum : 0,
                Math.Clamp(_flux * 20, 0, 1));
        }
    }
}
