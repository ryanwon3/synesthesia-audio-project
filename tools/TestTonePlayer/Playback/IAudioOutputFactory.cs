using NAudio.Wave;

namespace SpotifySynesthesia.TestTonePlayer.Playback;

public interface IAudioOutputFactory
{
    IReadOnlyList<AudioOutputDevice> GetActiveRenderDevices();

    IAudioOutputSession Create(string deviceId);
}

public interface IAudioOutputSession : IAsyncDisposable
{
    void Start(ISampleProvider source);

    void StopPlayback();
}
