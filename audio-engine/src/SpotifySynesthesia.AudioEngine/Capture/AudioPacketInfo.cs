namespace SpotifySynesthesia.AudioEngine.Capture;

public readonly record struct AudioPacketInfo(
    long CaptureTimestamp,
    long DevicePosition,
    long AudioClockPosition,
    int FrameCount,
    int SampleRate,
    int ChannelCount,
    bool IsSilent,
    bool HasDiscontinuity);
