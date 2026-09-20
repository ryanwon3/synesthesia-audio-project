namespace SpotifySynesthesia.TestTonePlayer.Signals;

public enum ChannelMode
{
    Stereo,
    LeftOnly,
    RightOnly,
}

public static class ChannelModeExtensions
{
    public static string GetDisplayName(this ChannelMode channelMode) => channelMode switch
    {
        ChannelMode.Stereo => "Stereo",
        ChannelMode.LeftOnly => "Left only",
        ChannelMode.RightOnly => "Right only",
        _ => throw new ArgumentOutOfRangeException(
            nameof(channelMode),
            channelMode,
            "Unknown channel mode."),
    };
}
