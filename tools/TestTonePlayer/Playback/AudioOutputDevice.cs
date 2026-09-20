namespace SpotifySynesthesia.TestTonePlayer.Playback;

public sealed record AudioOutputDevice(string Id, string Name, bool IsDefault)
{
    public string DisplayName => IsDefault ? $"{Name} (Default)" : Name;
}
