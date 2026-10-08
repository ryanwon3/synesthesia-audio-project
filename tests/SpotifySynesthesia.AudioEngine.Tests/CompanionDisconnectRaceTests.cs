using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Tests;

// The companion can rotate a token before the browser receives the renewal reply. Only a same-origin disconnect
// may still present the prior token, and only within 10 seconds (two initial-message deadlines) of the rotation.
public sealed class CompanionDisconnectRaceTests
{
    private const string Hosted = "https://app.example";
    private const string Preview = "https://preview.example";
    private const string Bundled = "http://127.0.0.1:8765";

    private static readonly DateTimeOffset Start = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(10);
    private static readonly string[] ConfiguredOrigins = [Hosted, Preview, Bundled];

    [Fact]
    public void PriorTokenDisconnectsImmediatelyAfterRotation()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential original = Pair(sessions, Hosted);
        CompanionCredential other = Pair(sessions, Hosted);
        CompanionCredential current = Renew(sessions, original, Hosted);

        Assert.True(sessions.Revoke(original.Token, Hosted));
        Assert.False(sessions.TryGetSessionLease(original.SessionId, out _));
        Assert.False(sessions.TryAuthenticate(current.Token, Hosted, out _));
        Assert.Null(sessions.Renew(current.Token, Hosted));
        Assert.False(sessions.Revoke(current.Token, Hosted));
        Assert.True(sessions.TryAuthenticate(other.Token, Hosted, out Guid otherId));
        Assert.Equal(other.SessionId, otherId);
    }

    [Fact]
    public void PriorTokenFromWrongOriginNeitherDisconnectsNorDamagesFamily()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential original = Pair(sessions, Hosted);
        CompanionCredential current = Renew(sessions, original, Hosted);

        Assert.False(sessions.Revoke(original.Token, Preview));
        Assert.False(sessions.Revoke(original.Token, Bundled));
        Assert.False(sessions.Revoke(original.Token, "https://app.example.evil.test"));
        Assert.True(sessions.TryGetSessionLease(original.SessionId, out _));
        Assert.True(sessions.TryAuthenticate(current.Token, Hosted, out Guid sessionId));
        Assert.Equal(original.SessionId, sessionId);

        // Foreign attempts must not consume the grace either.
        Assert.True(sessions.Revoke(original.Token, Hosted));
    }

    [Fact]
    public void PriorTokenGraceEndsAtTenSeconds()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential early = Pair(sessions, Hosted);
        CompanionCredential late = Pair(sessions, Hosted);
        Renew(sessions, early, Hosted);
        CompanionCredential lateCurrent = Renew(sessions, late, Hosted);

        time.Advance(Grace - TimeSpan.FromTicks(1));
        Assert.True(sessions.Revoke(early.Token, Hosted));
        Assert.False(sessions.TryGetSessionLease(early.SessionId, out _));

        time.Advance(TimeSpan.FromTicks(1));
        Assert.False(sessions.Revoke(late.Token, Hosted));
        Assert.True(sessions.TryGetSessionLease(late.SessionId, out _));
        Assert.True(sessions.TryAuthenticate(lateCurrent.Token, Hosted, out _));
        Assert.True(sessions.Revoke(lateCurrent.Token, Hosted));
    }

    [Fact]
    public void PriorTokenNeverAuthenticatesOrRenewsInsideGrace()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential original = Pair(sessions, Hosted);
        CompanionCredential current = Renew(sessions, original, Hosted);
        time.Advance(TimeSpan.FromSeconds(1));

        Assert.False(sessions.TryAuthenticate(original.Token, Hosted, out Guid sessionId));
        Assert.Equal(Guid.Empty, sessionId);
        Assert.Null(sessions.Renew(original.Token, Hosted));
        Assert.True(sessions.TryAuthenticate(current.Token, Hosted, out _));

        // Rejected authenticate and renew attempts must not consume the disconnect grace.
        Assert.True(sessions.Revoke(original.Token, Hosted));
    }

    [Fact]
    public void SecondRotationInvalidatesTheOlderPriorToken()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential first = Pair(sessions, Hosted);
        CompanionCredential second = Renew(sessions, first, Hosted);
        CompanionCredential third = Renew(sessions, second, Hosted);

        Assert.False(sessions.Revoke(first.Token, Hosted));
        Assert.True(sessions.TryGetSessionLease(first.SessionId, out _));
        Assert.True(sessions.TryAuthenticate(third.Token, Hosted, out _));

        Assert.True(sessions.Revoke(second.Token, Hosted));
        Assert.False(sessions.TryGetSessionLease(first.SessionId, out _));
    }

    [Fact]
    public void RevokeAllClearsPriorToken()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential original = Pair(sessions, Hosted);
        CompanionCredential current = Renew(sessions, original, Hosted);

        sessions.RevokeAll();
        Assert.False(sessions.Revoke(original.Token, Hosted));
        Assert.False(sessions.Revoke(current.Token, Hosted));
    }

    [Fact]
    public void AbsoluteExpiryInsideGraceClearsPriorToken()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        DateTimeOffset absolute = Start.AddHours(8);
        CompanionCredential current = Pair(sessions, Hosted);
        while (current.ExpiresAtUtc < absolute)
        {
            time.Advance(TimeSpan.FromMinutes(25));
            current = Renew(sessions, current, Hosted);
        }

        time.Advance(absolute - time.GetUtcNow() - TimeSpan.FromSeconds(5));
        CompanionCredential prior = current;
        CompanionCredential last = Renew(sessions, prior, Hosted);
        Assert.Equal(absolute, last.ExpiresAtUtc);

        time.Advance(TimeSpan.FromSeconds(5));
        Assert.False(sessions.Revoke(prior.Token, Hosted));
        Assert.False(sessions.Revoke(last.Token, Hosted));
        CompanionCredential fresh = Pair(sessions, Hosted);
        Assert.False(sessions.Revoke(prior.Token, Hosted));
        Assert.True(sessions.TryAuthenticate(fresh.Token, Hosted, out _));
    }

    [Fact]
    public void LocalReplacementClearsPriorToken()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        Renew(sessions, local, Bundled);

        CompanionCredential replaced = sessions.ReplaceLocalCredential(Bundled, local.SessionId);
        Assert.False(sessions.Revoke(local.Token, Bundled));
        Assert.True(sessions.TryAuthenticate(replaced.Token, Bundled, out Guid sessionId));
        Assert.Equal(replaced.SessionId, sessionId);
    }

    private static BrowserOriginPolicy Policy() => new(ConfiguredOrigins);

    private static CompanionCredential Pair(CompanionSessionManager sessions, string origin)
    {
        PairingChallenge challenge = sessions.CreatePairingChallenge();
        Assert.True(sessions.TryPair(challenge.Code, origin, out CompanionCredential? credential));
        Assert.NotNull(credential);
        return credential;
    }

    private static CompanionCredential Renew(CompanionSessionManager sessions, CompanionCredential credential, string origin)
    {
        CompanionCredential? renewed = sessions.Renew(credential.Token, origin);
        Assert.NotNull(renewed);
        Assert.Equal(credential.SessionId, renewed.SessionId);
        return renewed;
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow = Start;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan delta) => _utcNow += delta;
    }
}
