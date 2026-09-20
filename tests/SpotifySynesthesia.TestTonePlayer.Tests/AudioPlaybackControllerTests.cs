using ISampleProvider = NAudio.Wave.ISampleProvider;
using SpotifySynesthesia.TestTonePlayer.Playback;
using SpotifySynesthesia.TestTonePlayer.Signals;

namespace SpotifySynesthesia.TestTonePlayer.Tests;

public sealed class AudioPlaybackControllerTests
{
    [Fact]
    public async Task StartAndStopPublishExpectedStates()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        FakeAudioOutputFactory factory = new();
        await using AudioPlaybackController controller = CreateController(factory);
        List<PlaybackState> states = [];
        controller.StateChanged += states.Add;

        await controller.StartAsync(CreateSettings(), factory.Device.Id, cancellationToken);
        await controller.StopAsync(cancellationToken);

        Assert.Equal(
            [PlaybackState.Starting, PlaybackState.Playing, PlaybackState.Stopping, PlaybackState.Stopped],
            states);
        Assert.Equal(PlaybackState.Stopped, controller.State);
        Assert.Single(factory.Sessions);
        Assert.Equal(1, factory.Sessions[0].StartCount);
        Assert.Equal(1, factory.Sessions[0].StopCount);
        Assert.True(factory.Sessions[0].Disposed);
    }

    [Fact]
    public async Task StartingAgainStopsAndDisposesPreviousSession()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        FakeAudioOutputFactory factory = new();
        await using AudioPlaybackController controller = CreateController(factory);

        await controller.StartAsync(CreateSettings(), factory.Device.Id, cancellationToken);
        await controller.StartAsync(
            new TestSignalSettings(TestSignalKind.Sine1000Hz, ChannelMode.LeftOnly),
            factory.Device.Id,
            cancellationToken);

        Assert.Equal(PlaybackState.Playing, controller.State);
        Assert.Equal(2, factory.Sessions.Count);
        Assert.True(factory.Sessions[0].Disposed);
        Assert.False(factory.Sessions[1].Disposed);
    }

    [Fact]
    public async Task UpdateLevelChangesActiveSourceWithoutRestartingSession()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        FakeAudioOutputFactory factory = new();
        await using AudioPlaybackController controller = CreateController(factory);
        await controller.StartAsync(CreateSettings(), factory.Device.Id, cancellationToken);
        TestSignalSampleProvider source = Assert.IsType<TestSignalSampleProvider>(factory.Sessions[0].Source);

        controller.UpdateLevel(0.33f);

        Assert.Equal(0.33f, source.Level);
        Assert.Single(factory.Sessions);
    }

    [Fact]
    public async Task OutputCreationFailureMovesControllerToFaultedState()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        FakeAudioOutputFactory factory = new() { ThrowOnCreate = true };
        await using AudioPlaybackController controller = CreateController(factory);

        InvalidOperationException exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            controller.StartAsync(CreateSettings(), factory.Device.Id, cancellationToken));

        Assert.Equal("Simulated output failure.", exception.Message);
        Assert.Equal(PlaybackState.Faulted, controller.State);
    }

    [Fact]
    public async Task DeviceEnumerationIsPassedThrough()
    {
        FakeAudioOutputFactory factory = new();
        await using AudioPlaybackController controller = CreateController(factory);

        IReadOnlyList<AudioOutputDevice> devices = controller.GetActiveRenderDevices();

        AudioOutputDevice device = Assert.Single(devices);
        Assert.Equal(factory.Device, device);
    }

    private static AudioPlaybackController CreateController(FakeAudioOutputFactory factory) =>
        new(factory, static (_, _) => Task.CompletedTask);

    private static TestSignalSettings CreateSettings() =>
        new(TestSignalKind.Sine440Hz, ChannelMode.Stereo);

    private sealed class FakeAudioOutputFactory : IAudioOutputFactory
    {
        public AudioOutputDevice Device { get; } = new("fake-device", "Fake output", IsDefault: true);

        public List<FakeAudioOutputSession> Sessions { get; } = [];

        public bool ThrowOnCreate { get; init; }

        public IReadOnlyList<AudioOutputDevice> GetActiveRenderDevices() => [Device];

        public IAudioOutputSession Create(string deviceId)
        {
            Assert.Equal(Device.Id, deviceId);
            if (ThrowOnCreate)
            {
                throw new InvalidOperationException("Simulated output failure.");
            }

            FakeAudioOutputSession session = new();
            Sessions.Add(session);
            return session;
        }
    }

    private sealed class FakeAudioOutputSession : IAudioOutputSession
    {
        public ISampleProvider? Source { get; private set; }

        public int StartCount { get; private set; }

        public int StopCount { get; private set; }

        public bool Disposed { get; private set; }

        public void Start(ISampleProvider source)
        {
            Source = source;
            StartCount++;
        }

        public void StopPlayback() => StopCount++;

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
