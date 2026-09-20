namespace SpotifySynesthesia.AudioEngine.Analysis;

public sealed record AudioFrame(
    long Sequence,
    long TimestampUnixMilliseconds,
    long CaptureTimestamp,
    long DspCompletedTimestamp,
    double Rms,
    double BassEnergy,
    double MidEnergy,
    double TrebleEnergy,
    double SpectralCentroid,
    double SpectralFlux,
    double OnsetStrength,
    double StereoBalance,
    double StereoWidth,
    ChromaVector Chroma,
    PitchClass? DominantPitchClass,
    double ChromaConfidence,
    AudioBandFrame? Bass = null,
    AudioBandFrame? Mid = null,
    AudioBandFrame? Treble = null);

public sealed record AudioBandFrame(ChromaVector Chroma, double ChromaConfidence, double Attack);
