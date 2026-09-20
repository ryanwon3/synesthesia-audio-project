using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class AudioFrameWebSocketServerTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    [Fact]
    public async Task StreamsTypedFramesAndAcceptsAReconnect()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);

        using ClientWebSocket firstClient = new();
        await firstClient.ConnectAsync(options.WebSocketUri, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);

        server.Publish(CreateFrame(sequence: 11));
        AudioFrameMessage firstMessage = await ReceiveMessageAsync(firstClient, cancellationToken);

        Assert.Equal(AudioFrameProtocol.CurrentVersion, firstMessage.ProtocolVersion);
        Assert.Equal(AudioFrameProtocol.AudioFrameMessageType, firstMessage.Type);
        Assert.Equal(11, firstMessage.Payload.Sequence);
        Assert.Equal(PitchClass.A, firstMessage.Payload.DominantPitchClass);

        await firstClient.CloseAsync(WebSocketCloseStatus.NormalClosure, "test", cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 0, cancellationToken);

        using ClientWebSocket secondClient = new();
        await secondClient.ConnectAsync(options.WebSocketUri, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);

        server.Publish(CreateFrame(sequence: 12));
        AudioFrameMessage secondMessage = await ReceiveMessageAsync(secondClient, cancellationToken);

        Assert.Equal(12, secondMessage.Payload.Sequence);
        Assert.Equal(2, server.FramesPublished);
    }

    [Fact]
    public async Task PublishesWithoutClientsAndReportsHealth()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);

        server.Publish(CreateFrame(sequence: 1));

        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(options.HealthUri, cancellationToken);
        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        AudioServerHealth? health = JsonSerializer.Deserialize<AudioServerHealth>(
            json,
            JsonOptions);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(health);
        Assert.Equal(AudioFrameProtocol.CurrentVersion, health.ProtocolVersion);
        Assert.Equal(0, health.ConnectedClients);
        Assert.Equal(1, health.FramesPublished);
        Assert.Equal("running", health.State);
    }

    [Fact]
    public async Task StopClosesListenerAndClientsCleanly()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        using ClientWebSocket client = new();
        await client.ConnectAsync(options.WebSocketUri, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);

        await server.StopAsync(cancellationToken);

        Assert.False(server.IsRunning);
        Assert.Equal(0, server.ConnectedClientCount);
    }

    [Fact]
    public async Task ServesVisualizerFilesWithoutAllowingPathsOutsideItsRoot()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        string contentRoot = Path.Combine(Path.GetTempPath(), $"synesthesia-static-{Guid.NewGuid():N}");
        Directory.CreateDirectory(contentRoot);
        await File.WriteAllTextAsync(Path.Combine(contentRoot, "index.html"), "<main>painting</main>", cancellationToken);

        try
        {
            AudioFrameWebSocketServerOptions options = new(GetAvailablePort(), staticContentPath: contentRoot);
            await using AudioFrameWebSocketServer server = new(options);
            await server.StartAsync(cancellationToken);
            using HttpClient client = new();

            string html = await client.GetStringAsync(options.HttpPrefix, cancellationToken);
            using HttpResponseMessage traversal = await client.GetAsync(
                new Uri(options.HttpPrefix + "%2e%2e/secret.txt"),
                cancellationToken);

            Assert.Equal("<main>painting</main>", html);
            Assert.Equal(HttpStatusCode.NotFound, traversal.StatusCode);
        }
        finally
        {
            Directory.Delete(contentRoot, recursive: true);
        }
    }

    private static async Task<AudioFrameMessage> ReceiveMessageAsync(
        ClientWebSocket client,
        CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[16 * 1024];
        WebSocketReceiveResult result = await client.ReceiveAsync(buffer, cancellationToken);
        Assert.Equal(WebSocketMessageType.Text, result.MessageType);
        Assert.True(result.EndOfMessage);

        AudioFrameMessage? message = JsonSerializer.Deserialize<AudioFrameMessage>(
            buffer.AsSpan(0, result.Count),
            JsonOptions);
        return Assert.IsType<AudioFrameMessage>(message);
    }

    private static async Task WaitUntilAsync(Func<bool> condition, CancellationToken cancellationToken)
    {
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));

        while (!condition())
        {
            await Task.Delay(TimeSpan.FromMilliseconds(20), timeout.Token);
        }
    }

    private static int GetAvailablePort()
    {
        using TcpListener listener = new(IPAddress.Loopback, port: 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static AudioFrame CreateFrame(long sequence) => new(
        Sequence: sequence,
        TimestampUnixMilliseconds: 1,
        CaptureTimestamp: 2,
        DspCompletedTimestamp: 3,
        Rms: 0.1d,
        BassEnergy: 0.2d,
        MidEnergy: 0.3d,
        TrebleEnergy: 0.4d,
        SpectralCentroid: 0.5d,
        SpectralFlux: 0.6d,
        OnsetStrength: 0.7d,
        StereoBalance: 0.5d,
        StereoWidth: 0.1d,
        Chroma: new ChromaVector(0d, 0d, 0d, 0d, 0d, 0d, 0d, 0d, 0d, 1d, 0d, 0d),
        DominantPitchClass: PitchClass.A,
        ChromaConfidence: 1d);
}
