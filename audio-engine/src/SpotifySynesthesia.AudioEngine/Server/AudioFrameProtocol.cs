using SpotifySynesthesia.AudioEngine.Analysis;

namespace SpotifySynesthesia.AudioEngine.Server;

public static class AudioFrameProtocol
{
    public const int CurrentVersion = 1;
    public const string AudioFrameMessageType = "audioFrame";
    public const string DefaultPath = "/audio";
}

public sealed record AudioFrameMessage(
    int ProtocolVersion,
    string Type,
    AudioFrame Payload)
{
    public static AudioFrameMessage Create(AudioFrame frame) => new(
        AudioFrameProtocol.CurrentVersion,
        AudioFrameProtocol.AudioFrameMessageType,
        frame);
}

public sealed record AudioServerHealth(
    int ProtocolVersion,
    int ConnectedClients,
    long FramesPublished,
    string State);
