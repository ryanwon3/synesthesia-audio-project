using System.Net.WebSockets;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Tests;

// Drives the production StreamClient that RunAudioClientAsync constructs over an in-memory transport, so a stalled
// send is deterministic without a network or buffer filling.
public sealed class StreamClientLifetimeTests
{
    private const string Bundled = "http://127.0.0.1:8765";
    private const WebSocketCloseStatus AuthenticationClose =
        (WebSocketCloseStatus)CompanionConnectionProtocol.AuthenticationCloseCode;

    private static readonly DateTimeOffset Start = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);

    // Above the intended 1-second send deadline and the 250 ms lease poll; reaching it is a genuine failure.
    private static readonly TimeSpan SafetyBound = TimeSpan.FromSeconds(2);

    [Theory]
    [InlineData("revoke")]
    [InlineData("expire")]
    public async Task LeaseLossReleasesStalledSend(string loss)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(new BrowserOriginPolicy([Bundled]), time);
        CompanionCredential credential = sessions.CreateLocalCredential(Bundled);
        FakeStreamWebSocket socket = new(stallSends: true);
        using AudioFrameWebSocketServer.StreamClient<AudioFrame> client = CreateClient(socket, sessions, credential.SessionId);
        using CancellationTokenSource serverCancellation = new();
        Task run = client.RunAsync(serverCancellation.Token);
        try
        {
            Assert.True(client.TryPublish(CreateFrame(sequence: 1)));
            await socket.SendEntered.Task.WaitAsync(SafetyBound, cancellationToken);
            if (string.Equals(loss, "revoke", StringComparison.Ordinal))
            {
                sessions.RevokeAll();
            }
            else
            {
                time.Advance(TimeSpan.FromMinutes(30));
            }

            await AssertCompletesWithinBoundAsync(
                run,
                "Lease loss completed the channel, but the stalled send kept the stream and its admission alive.",
                cancellationToken);
            Assert.True(socket.SendCancelled.Task.IsCompleted, "The stalled send was never cancelled or aborted.");
            Assert.False(socket.WritersOverlapped, "A close was written while a send was still in flight.");
        }
        finally
        {
            await StopSafelyAsync(serverCancellation, client, socket, run);
        }
    }

    [Fact]
    public async Task StalledSendWithLiveLeaseHitsSendDeadline()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        CompanionSessionManager sessions = new(new BrowserOriginPolicy([Bundled]), new ManualTimeProvider());
        CompanionCredential credential = sessions.CreateLocalCredential(Bundled);
        FakeStreamWebSocket socket = new(stallSends: true);
        using AudioFrameWebSocketServer.StreamClient<AudioFrame> client = CreateClient(socket, sessions, credential.SessionId);
        using CancellationTokenSource serverCancellation = new();
        Task run = client.RunAsync(serverCancellation.Token);
        try
        {
            Assert.True(client.TryPublish(CreateFrame(sequence: 1)));
            await socket.SendEntered.Task.WaitAsync(SafetyBound, cancellationToken);
            Assert.True(sessions.TryGetSessionLease(credential.SessionId, out _));

            await AssertCompletesWithinBoundAsync(
                run,
                "A send stalled without lease loss never reached the intended 1-second send deadline.",
                cancellationToken);
            Assert.True(socket.SendCancelled.Task.IsCompleted, "The stalled send was never cancelled or aborted.");
            Assert.False(socket.WritersOverlapped, "A close was written while a send was still in flight.");
            Assert.True(
                sessions.TryGetSessionLease(credential.SessionId, out _),
                "A transient send failure must not revoke the session.");
        }
        finally
        {
            await StopSafelyAsync(serverCancellation, client, socket, run);
        }
    }

    [Theory]
    [InlineData("revoke-then-publish")]
    [InlineData("idle-expiry")]
    public async Task CooperativeLeaseLossClosesWithAuthenticationStatusAsOnlyWriter(string loss)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(new BrowserOriginPolicy([Bundled]), time);
        CompanionCredential credential = sessions.CreateLocalCredential(Bundled);
        FakeStreamWebSocket socket = new(stallSends: false);
        using AudioFrameWebSocketServer.StreamClient<AudioFrame> client = CreateClient(socket, sessions, credential.SessionId);
        using CancellationTokenSource serverCancellation = new();
        Task run = client.RunAsync(serverCancellation.Token);
        try
        {
            Assert.True(client.TryPublish(CreateFrame(sequence: 1)));
            await socket.SendCompleted.Task.WaitAsync(SafetyBound, cancellationToken);
            if (string.Equals(loss, "revoke-then-publish", StringComparison.Ordinal))
            {
                // The lease poll may complete the channel first, so the publication result is not asserted.
                sessions.RevokeAll();
                _ = client.TryPublish(CreateFrame(sequence: 2));
            }
            else
            {
                time.Advance(TimeSpan.FromMinutes(30));
            }

            await AssertCompletesWithinBoundAsync(run, "A cooperative stream did not close after lease loss.", cancellationToken);
            Assert.Equal(AuthenticationClose, socket.SentCloseStatus);
            Assert.Equal(1, socket.CompletedSends);
            Assert.False(socket.SendCancelled.Task.IsCompleted, "A cooperative send must not be cancelled.");
            Assert.False(socket.WritersOverlapped, "A close was written while a send was still in flight.");
            Assert.False(socket.SentAfterClose, "A payload was sent after the close frame.");
        }
        finally
        {
            await StopSafelyAsync(serverCancellation, client, socket, run);
        }
    }

    private static AudioFrameWebSocketServer.StreamClient<AudioFrame> CreateClient(
        WebSocket socket,
        CompanionSessionManager sessions,
        Guid sessionId) =>
        new(socket, capacity: 2, static _ => "{}"u8.ToArray(), commandHandler: null, sessionId, sessions);

    private static async Task AssertCompletesWithinBoundAsync(Task run, string because, CancellationToken cancellationToken)
    {
        using CancellationTokenSource delay = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task completed = await Task.WhenAny(run, Task.Delay(SafetyBound, delay.Token));
        await delay.CancelAsync();
        Assert.True(ReferenceEquals(completed, run), because);
        await run;
    }

    // Cleanup must never hang the suite, including while the defect is still present.
    private static async Task StopSafelyAsync(
        CancellationTokenSource serverCancellation,
        AudioFrameWebSocketServer.StreamClient<AudioFrame> client,
        FakeStreamWebSocket socket,
        Task run)
    {
        await serverCancellation.CancelAsync();
        client.Abort();
        socket.Abort();
        await Task.WhenAny(run, Task.Delay(SafetyBound, CancellationToken.None));
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

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow = Start;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan delta) => _utcNow += delta;
    }

    // No I/O: a send either completes at once or waits only for its token or Abort; a receive waits for its token,
    // Abort, or the peer's reply to our close.
    private sealed class FakeStreamWebSocket(bool stallSends) : WebSocket
    {
        private readonly CancellationTokenSource _aborted = new();
        private readonly TaskCompletionSource _peerClose = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _state = (int)WebSocketState.Open;
        private int _closeStatus;
        private int _activeWriters;
        private int _completedSends;
        private int _writersOverlapped;
        private int _sentAfterClose;
        private int _disposed;

        public TaskCompletionSource SendEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource SendCompleted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource SendCancelled { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int CompletedSends => Volatile.Read(ref _completedSends);

        public bool WritersOverlapped => Volatile.Read(ref _writersOverlapped) != 0;

        public bool SentAfterClose => Volatile.Read(ref _sentAfterClose) != 0;

        public WebSocketCloseStatus? SentCloseStatus =>
            Volatile.Read(ref _closeStatus) is var status and not 0 ? (WebSocketCloseStatus)status : null;

        public override WebSocketCloseStatus? CloseStatus => SentCloseStatus;

        public override string? CloseStatusDescription => null;

        public override string? SubProtocol => null;

        public override WebSocketState State => (WebSocketState)Volatile.Read(ref _state);

        public override void Abort()
        {
            if (State != WebSocketState.Closed)
            {
                Volatile.Write(ref _state, (int)WebSocketState.Aborted);
            }

            try
            {
                _aborted.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        public override Task CloseAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken) =>
            CloseOutputAsync(closeStatus, statusDescription, cancellationToken);

        public override Task CloseOutputAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken)
        {
            EnterWriter();
            try
            {
                if (State is not (WebSocketState.Open or WebSocketState.CloseReceived))
                {
                    return Task.FromException(new WebSocketException(WebSocketError.InvalidState));
                }

                Volatile.Write(ref _closeStatus, (int)closeStatus);
                Volatile.Write(ref _state, (int)WebSocketState.CloseSent);
                _peerClose.TrySetResult();
                return Task.CompletedTask;
            }
            finally
            {
                Interlocked.Decrement(ref _activeWriters);
            }
        }

        public override async ValueTask<ValueWebSocketReceiveResult> ReceiveAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken)
        {
            using CancellationTokenSource linked =
                CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _aborted.Token);
            await _peerClose.Task.WaitAsync(linked.Token);
            Interlocked.CompareExchange(ref _state, (int)WebSocketState.Closed, (int)WebSocketState.CloseSent);
            return new ValueWebSocketReceiveResult(0, WebSocketMessageType.Close, endOfMessage: true);
        }

        public override async Task<WebSocketReceiveResult> ReceiveAsync(
            ArraySegment<byte> buffer,
            CancellationToken cancellationToken)
        {
            ValueWebSocketReceiveResult result = await ReceiveAsync(buffer.AsMemory(), cancellationToken);
            return new WebSocketReceiveResult(result.Count, result.MessageType, result.EndOfMessage, SentCloseStatus, null);
        }

        public override Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken) =>
            WriteAsync(cancellationToken);

        public override ValueTask SendAsync(
            ReadOnlyMemory<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken) =>
            new(WriteAsync(cancellationToken));

        public override ValueTask SendAsync(
            ReadOnlyMemory<byte> buffer,
            WebSocketMessageType messageType,
            WebSocketMessageFlags messageFlags,
            CancellationToken cancellationToken) =>
            new(WriteAsync(cancellationToken));

        public override void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Abort();
                _aborted.Dispose();
            }
        }

        private void EnterWriter()
        {
            if (Interlocked.Increment(ref _activeWriters) > 1)
            {
                Volatile.Write(ref _writersOverlapped, 1);
            }
        }

        private async Task WriteAsync(CancellationToken cancellationToken)
        {
            EnterWriter();
            try
            {
                if (Volatile.Read(ref _closeStatus) != 0)
                {
                    Volatile.Write(ref _sentAfterClose, 1);
                }

                if (State != WebSocketState.Open)
                {
                    throw new WebSocketException(WebSocketError.InvalidState);
                }

                SendEntered.TrySetResult();
                if (stallSends)
                {
                    using CancellationTokenSource linked =
                        CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _aborted.Token);
                    try
                    {
                        await Task.Delay(Timeout.Infinite, linked.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        SendCancelled.TrySetResult();
                        throw;
                    }
                }

                Interlocked.Increment(ref _completedSends);
                SendCompleted.TrySetResult();
            }
            finally
            {
                Interlocked.Decrement(ref _activeWriters);
            }
        }
    }
}
