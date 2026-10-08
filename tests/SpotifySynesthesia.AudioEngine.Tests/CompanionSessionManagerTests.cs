using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class CompanionSessionManagerTests
{
    private const string Hosted = "https://app.example";
    private const string Preview = "https://preview.example";
    private const string Bundled = "http://127.0.0.1:8765";
    private const string ViteDev = "http://localhost:5173";
    private const string Base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    private static readonly DateTimeOffset Start = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);
    private static readonly string WrongCode = new('A', 22);
    private static readonly string[] ConfiguredOrigins = [Hosted, Preview, Bundled, ViteDev];
    private static readonly string[] FiveOrigins =
        ["https://app.example", "https://preview.example", "https://staging.example", "https://beta.example", "https://studio.example"];
    private static readonly string[] CanonicalConfiguration =
        ["https://App.Example:443", "http://localhost:5173", "http://127.0.0.1:8765", "http://[::1]:8765"];
    private static readonly string?[] RejectedRequestOrigins =
    [
        null, "", " ", "null", "http://app.example", "wss://app.example", "https://app.example:8443",
        "https://app.example.evil.test", "https://evil-app.example", "https://app.example.", "https://app.example/",
        "https://user@app.example", "https://app.example ", "http://localhost:5174", "https://localhost:5173",
        "http://localhost.evil.test:5173", "http://127.0.0.1:8766", "http://127.0.0.2:8765", "http://[::1]:5173",
    ];
    private static readonly string[] NonLocalCredentialOrigins =
        [Hosted, ViteDev, "http://127.0.0.1:9999", "http://[::1]:8765", "https://127.0.0.1:8765"];
    private static readonly string[] HostedVariants =
        ["https://APP.example:443", "https://app.example:443", "https://APP.example", Hosted];

    [Fact]
    public void RejectsOriginLookalikesAndNull()
    {
        BrowserOriginPolicy policy = new(CanonicalConfiguration);

        Assert.True(policy.IsAllowed("https://app.example"));
        Assert.True(policy.IsAllowed("https://APP.example"));
        Assert.True(policy.IsAllowed("https://app.example:443"));
        Assert.True(policy.IsAllowed("http://localhost:5173"));
        Assert.True(policy.IsAllowed("http://127.0.0.1:8765"));
        Assert.True(policy.IsAllowed("http://[::1]:8765"));
        foreach (string? origin in RejectedRequestOrigins)
        {
            Assert.False(policy.IsAllowed(origin), origin ?? "<null>");
        }
    }

    [Theory]
    [InlineData("https://app.example/")]
    [InlineData("https://app.example/path")]
    [InlineData("https://user@app.example")]
    [InlineData("https://app.example?x=1")]
    [InlineData("https://app.example#top")]
    [InlineData("https://*.example")]
    [InlineData("*")]
    [InlineData(" https://app.example")]
    [InlineData("https://app.example ")]
    [InlineData("https://app .example")]
    [InlineData("http://app.example")]
    [InlineData("http://192.168.1.20:5173")]
    [InlineData("http://localhost.evil.test:5173")]
    [InlineData("ws://127.0.0.1:8765")]
    [InlineData("ftp://app.example")]
    [InlineData("file:///C:/site")]
    [InlineData("app.example")]
    [InlineData("null")]
    [InlineData("")]
    public void RejectsInvalidConfiguredOrigins(string configured)
    {
        Assert.Throws<ArgumentException>(() => new BrowserOriginPolicy([Hosted, configured]));
    }

    [Fact]
    public void RejectsExpiredOrReplayedChallenge()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);

        PairingChallenge first = sessions.CreatePairingChallenge();
        PairingChallenge second = sessions.CreatePairingChallenge();
        Assert.True(IsBase64Url(second.Code, 22));
        Assert.NotEqual(first.Code, second.Code);
        Assert.Equal(Start.AddMinutes(5), second.ExpiresAtUtc);
        Assert.False(sessions.TryPair(first.Code, Hosted, out CompanionCredential? stale));
        Assert.Null(stale);

        time.Advance(TimeSpan.FromMinutes(5) - TimeSpan.FromTicks(1));
        Assert.True(sessions.TryPair(second.Code, Hosted, out CompanionCredential? credential));
        Assert.NotNull(credential);
        Assert.False(sessions.TryPair(second.Code, Hosted, out _));
        Assert.False(sessions.TryPair(second.Code, Preview, out _));

        PairingChallenge expiring = sessions.CreatePairingChallenge();
        Assert.True(sessions.TryAuthenticate(credential.Token, Hosted, out _));
        time.Advance(TimeSpan.FromMinutes(5));
        Assert.False(sessions.TryPair(expiring.Code, Hosted, out _));
        Assert.True(sessions.TryPair(sessions.CreatePairingChallenge().Code, Hosted, out _));
    }

    [Fact]
    public void BindsCredentialToExactOrigin()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential credential = Pair(sessions, Hosted);

        Assert.True(IsBase64Url(credential.Token, 43));
        Assert.NotEqual(Guid.Empty, credential.SessionId);
        Assert.Equal(Start.AddMinutes(30), credential.ExpiresAtUtc);
        Assert.True(sessions.TryAuthenticate(credential.Token, Hosted, out Guid sessionId));
        Assert.Equal(credential.SessionId, sessionId);
        Assert.False(sessions.TryAuthenticate(credential.Token, Preview, out Guid foreign));
        Assert.Equal(Guid.Empty, foreign);
        Assert.False(sessions.TryAuthenticate(credential.Token, "https://app.example.evil.test", out _));
        Assert.Null(sessions.Renew(credential.Token, Preview));

        time.Advance(TimeSpan.FromMinutes(30) - TimeSpan.FromTicks(1));
        Assert.True(sessions.TryAuthenticate(credential.Token, Hosted, out _));
        time.Advance(TimeSpan.FromTicks(1));
        Assert.False(sessions.TryAuthenticate(credential.Token, Hosted, out _));
        Assert.Null(sessions.Renew(credential.Token, Hosted));
    }

    [Fact]
    public void RenewalRotatesTokenWithinAbsoluteLifetime()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential replayed = Pair(sessions, Preview);
        Assert.NotNull(sessions.Renew(replayed.Token, Preview));
        Assert.Null(sessions.Renew(replayed.Token, Preview));

        CompanionCredential current = Pair(sessions, Hosted);
        Guid sessionId = current.SessionId;
        for (int renewal = 1; renewal <= 19; renewal++)
        {
            time.Advance(TimeSpan.FromMinutes(25));
            CompanionCredential? renewed = sessions.Renew(current.Token, Hosted);
            Assert.NotNull(renewed);
            Assert.True(IsBase64Url(renewed.Token, 43));
            Assert.NotEqual(current.Token, renewed.Token);
            Assert.Equal(sessionId, renewed.SessionId);
            Assert.Equal(Start.AddMinutes(Math.Min((renewal * 25) + 30, 480)), renewed.ExpiresAtUtc);
            Assert.False(sessions.TryAuthenticate(current.Token, Hosted, out _));
            current = renewed;
        }

        Assert.Equal(Start.AddHours(8), current.ExpiresAtUtc);
        time.Advance(TimeSpan.FromMinutes(5) - TimeSpan.FromTicks(1));
        Assert.True(sessions.TryAuthenticate(current.Token, Hosted, out Guid live));
        Assert.Equal(sessionId, live);
        time.Advance(TimeSpan.FromTicks(1));
        Assert.False(sessions.TryAuthenticate(current.Token, Hosted, out _));
        Assert.Null(sessions.Renew(current.Token, Hosted));
    }

    [Fact]
    public void RevokesOnRestart()
    {
        ManualTimeProvider time = new();
        BrowserOriginPolicy policy = Policy();
        CompanionSessionManager sessions = new(policy, time);
        CompanionCredential paired = Pair(sessions, Hosted);
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        PairingChallenge pending = sessions.CreatePairingChallenge();
        Assert.True(sessions.TryAuthenticate(paired.Token, Hosted, out _));
        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out _));

        CompanionSessionManager restarted = new(policy, time);
        Assert.False(restarted.TryAuthenticate(paired.Token, Hosted, out _));
        Assert.False(restarted.TryPair(pending.Code, Hosted, out _));

        sessions.RevokeAll();
        Assert.False(sessions.TryPair(pending.Code, Hosted, out _));
        Assert.False(sessions.TryAuthenticate(paired.Token, Hosted, out _));
        Assert.False(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.Null(sessions.Renew(paired.Token, Hosted));
        Assert.True(sessions.TryPair(sessions.CreatePairingChallenge().Code, Hosted, out _));
        Assert.True(restarted.TryPair(restarted.CreatePairingChallenge().Code, Hosted, out _));
    }

    [Fact]
    public void BoundsAttemptsAndSessions()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        sessions.CreatePairingChallenge();
        FailAttempts(sessions, Hosted, 4);
        CompanionCredential first = Pair(sessions, Hosted);
        Pair(sessions, Hosted);
        FailAttempts(sessions, Hosted, 1);

        PairingChallenge blocked = sessions.CreatePairingChallenge();
        Assert.False(sessions.TryPair(blocked.Code, Hosted, out _));
        Assert.True(sessions.TryPair(blocked.Code, Preview, out _));
        PairingChallenge later = sessions.CreatePairingChallenge();
        time.Advance(TimeSpan.FromMinutes(1));
        Assert.True(sessions.TryPair(later.Code, Hosted, out _));

        Assert.False(sessions.TryPair(sessions.CreatePairingChallenge().Code, ViteDev, out _));
        Assert.True(sessions.TryAuthenticate(first.Token, Hosted, out _));
        sessions.RevokeAll();
        Assert.True(sessions.TryPair(sessions.CreatePairingChallenge().Code, ViteDev, out _));

        Pair(sessions, Preview);
        Pair(sessions, Bundled);
        Pair(sessions, Hosted);
        Assert.False(sessions.TryPair(sessions.CreatePairingChallenge().Code, Preview, out _));
        time.Advance(TimeSpan.FromMinutes(30));
        Assert.True(sessions.TryPair(sessions.CreatePairingChallenge().Code, Preview, out _));
    }

    [Fact]
    public void BoundsFailedPairingGlobally()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager nearLimit = new(new BrowserOriginPolicy(FiveOrigins), time);
        PairingChallenge challenge = nearLimit.CreatePairingChallenge();
        foreach (string origin in FiveOrigins[..4])
        {
            FailAttempts(nearLimit, origin, 4);
        }

        FailAttempts(nearLimit, FiveOrigins[4], 3);
        Assert.True(nearLimit.TryPair(challenge.Code, FiveOrigins[4], out _));

        CompanionSessionManager exhausted = new(new BrowserOriginPolicy(FiveOrigins), time);
        challenge = exhausted.CreatePairingChallenge();
        foreach (string origin in FiveOrigins)
        {
            FailAttempts(exhausted, origin, 4);
        }

        foreach (string origin in FiveOrigins)
        {
            Assert.False(exhausted.TryPair(challenge.Code, origin, out _), origin);
        }

        time.Advance(TimeSpan.FromMinutes(1));
        Assert.True(exhausted.TryPair(challenge.Code, FiveOrigins[0], out _));
    }

    [Fact]
    public void DeniedOriginsCannotPairOrConsumeBudget()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        PairingChallenge challenge = sessions.CreatePairingChallenge();
        for (int visitor = 0; visitor < 100; visitor++)
        {
            Assert.False(sessions.TryPair(challenge.Code, $"https://visitor{visitor}.example", out _));
        }

        Assert.False(sessions.TryPair(challenge.Code, "https://app.example.evil.test", out CompanionCredential? denied));
        Assert.Null(denied);
        Assert.True(sessions.TryPair(challenge.Code, Hosted, out CompanionCredential? credential));
        Assert.NotNull(credential);
    }

    [Fact]
    public void LocalCredentialRequiresConfiguredLiteralLoopbackOrigin()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);

        Assert.True(IsBase64Url(local.Token, 43));
        Assert.Equal(Start.AddMinutes(30), local.ExpiresAtUtc);
        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out Guid sessionId));
        Assert.Equal(local.SessionId, sessionId);
        Assert.False(sessions.TryAuthenticate(local.Token, Hosted, out _));
        Assert.False(sessions.TryAuthenticate(local.Token, ViteDev, out _));
        foreach (string origin in NonLocalCredentialOrigins)
        {
            Assert.Throws<ArgumentException>(() => sessions.CreateLocalCredential(origin));
        }
    }

    [Fact]
    public void MalformedCodesAndTokensFailClosed()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        string code = sessions.CreatePairingChallenge().Code;
        Assert.True(IsBase64Url(code, 22));
        foreach (string malformed in new[] { code[..^1], code + "A", code + "=", "+" + code[1..] })
        {
            Assert.False(sessions.TryPair(malformed, Hosted, out _), malformed);
        }

        Assert.True(sessions.TryPair(code, Hosted, out CompanionCredential? credential));
        Assert.NotNull(credential);
        string token = credential.Token;
        Assert.True(IsBase64Url(token, 43));
        char replacement = token[^1] == 'A' ? 'B' : 'A';
        foreach (string malformed in new[] { "", token[..^1], token + "A", " " + token, token[..^1] + "=", "/" + token[1..], token[..^1] + replacement })
        {
            Assert.False(sessions.TryAuthenticate(malformed, Hosted, out Guid sessionId), malformed);
            Assert.Equal(Guid.Empty, sessionId);
            Assert.Null(sessions.Renew(malformed, Hosted));
        }

        Assert.True(sessions.TryAuthenticate(token, Hosted, out _));
    }

    [Fact]
    public void TextRepresentationsOmitSecrets()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        PairingChallenge challenge = sessions.CreatePairingChallenge();
        Assert.True(IsBase64Url(challenge.Code, 22));
        Assert.DoesNotContain(challenge.Code, challenge.ToString(), StringComparison.Ordinal);

        Assert.True(sessions.TryPair(challenge.Code, Hosted, out CompanionCredential? credential));
        Assert.NotNull(credential);
        Assert.True(IsBase64Url(credential.Token, 43));
        Assert.DoesNotContain(credential.Token, credential.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void SessionLeaseFollowsRenewalWithoutReusingToken()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential original = Pair(sessions, Hosted);
        Assert.True(sessions.TryGetSessionLease(original.SessionId, out DateTimeOffset lease));
        Assert.Equal(Start.AddMinutes(30), lease);
        Assert.False(sessions.TryGetSessionLease(Guid.NewGuid(), out DateTimeOffset unknown));
        Assert.Equal(default(DateTimeOffset), unknown);

        time.Advance(TimeSpan.FromMinutes(25));
        CompanionCredential? renewed = sessions.Renew(original.Token, Hosted);
        Assert.NotNull(renewed);
        Assert.Equal(Start.AddMinutes(55), renewed.ExpiresAtUtc);
        Assert.False(sessions.TryAuthenticate(original.Token, Hosted, out _));
        Assert.True(sessions.TryGetSessionLease(original.SessionId, out lease));
        Assert.Equal(Start.AddMinutes(55), lease);

        time.Advance(TimeSpan.FromMinutes(30) - TimeSpan.FromTicks(1));
        Assert.True(sessions.TryGetSessionLease(original.SessionId, out lease));
        Assert.Equal(Start.AddMinutes(55), lease);
        time.Advance(TimeSpan.FromTicks(1));
        Assert.False(sessions.TryGetSessionLease(original.SessionId, out lease));
        Assert.Equal(default(DateTimeOffset), lease);
    }

    [Fact]
    public void RevokesOnlyAuthenticatedSessionFamily()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential original = Pair(sessions, Hosted);
        CompanionCredential other = Pair(sessions, Hosted);
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        Assert.True(sessions.TryGetSessionLease(original.SessionId, out _));
        CompanionCredential? current = sessions.Renew(original.Token, Hosted);
        Assert.NotNull(current);
        PairingChallenge pending = sessions.CreatePairingChallenge();

        Assert.False(sessions.Revoke(current.Token, Preview));
        Assert.False(sessions.Revoke(current.Token, "https://app.example.evil.test"));
        // The prior token may disconnect only inside the 10-second rotation grace; past it, rejection must hold.
        time.Advance(TimeSpan.FromSeconds(10));
        Assert.False(sessions.Revoke(original.Token, Hosted));
        Assert.True(sessions.TryGetSessionLease(original.SessionId, out _));
        Assert.True(sessions.TryAuthenticate(current.Token, Hosted, out _));

        Assert.True(sessions.Revoke(current.Token, Hosted));
        Assert.False(sessions.TryGetSessionLease(original.SessionId, out DateTimeOffset revoked));
        Assert.Equal(default(DateTimeOffset), revoked);
        Assert.False(sessions.TryAuthenticate(current.Token, Hosted, out _));
        Assert.Null(sessions.Renew(current.Token, Hosted));
        Assert.False(sessions.Revoke(current.Token, Hosted));
        Assert.True(sessions.TryAuthenticate(other.Token, Hosted, out Guid otherId));
        Assert.Equal(other.SessionId, otherId);
        Assert.True(sessions.TryGetSessionLease(other.SessionId, out _));
        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.True(sessions.TryPair(pending.Code, Preview, out _));

        time.Advance(TimeSpan.FromMinutes(30));
        Assert.False(sessions.Revoke(other.Token, Hosted));
    }

    [Fact]
    public void AllRevocationInvalidatesEstablishedLeaseAndPendingChallenge()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential paired = Pair(sessions, Hosted);
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        PairingChallenge pending = sessions.CreatePairingChallenge();
        Assert.True(sessions.TryGetSessionLease(paired.SessionId, out _));
        Assert.True(sessions.TryGetSessionLease(local.SessionId, out _));

        sessions.RevokeAll();
        Assert.False(sessions.TryGetSessionLease(paired.SessionId, out DateTimeOffset revoked));
        Assert.Equal(default(DateTimeOffset), revoked);
        Assert.False(sessions.TryGetSessionLease(local.SessionId, out _));
        Assert.False(sessions.TryPair(pending.Code, Hosted, out CompanionCredential? stale));
        Assert.Null(stale);
    }

    [Fact]
    public void RevocationDoesNotResetPairingFailureHistory()
    {
        ManualTimeProvider originTime = new();
        CompanionSessionManager perOrigin = new(Policy(), originTime);
        CompanionCredential paired = Pair(perOrigin, Hosted);
        FailAttempts(perOrigin, Hosted, 5);
        perOrigin.RevokeAll();
        Assert.False(perOrigin.TryAuthenticate(paired.Token, Hosted, out _));
        AssertBlockedForFailureWindow(perOrigin, originTime, Hosted);

        ManualTimeProvider sharedTime = new();
        CompanionSessionManager shared = new(new BrowserOriginPolicy(FiveOrigins), sharedTime);
        foreach (string origin in FiveOrigins)
        {
            FailAttempts(shared, origin, 4);
        }

        shared.RevokeAll();
        AssertBlockedForFailureWindow(shared, sharedTime, FiveOrigins[4]);
    }

    [Fact]
    public void LocalAndPairedCredentialsShareSessionCap()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        time.Advance(TimeSpan.FromMinutes(1));
        Pair(sessions, Hosted);
        Pair(sessions, Preview);
        Pair(sessions, ViteDev);
        Assert.False(sessions.TryPair(sessions.CreatePairingChallenge().Code, Hosted, out CompanionCredential? overflow));
        Assert.Null(overflow);
        Assert.Throws<InvalidOperationException>(() => sessions.CreateLocalCredential(Bundled));
        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out _));

        time.Advance(TimeSpan.FromMinutes(29));
        Assert.False(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.True(sessions.TryPair(sessions.CreatePairingChallenge().Code, Hosted, out _));
        Assert.Throws<InvalidOperationException>(() => sessions.CreateLocalCredential(Bundled));

        sessions.RevokeAll();
        CompanionCredential restored = sessions.CreateLocalCredential(Bundled);
        Assert.True(sessions.TryAuthenticate(restored.Token, Bundled, out _));
    }

    [Fact]
    public void CanonicalOriginVariantsShareCredentialAndFailureBudget()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential paired = Pair(sessions, HostedVariants[0]);
        Assert.True(sessions.TryAuthenticate(paired.Token, Hosted, out Guid sessionId));
        Assert.Equal(paired.SessionId, sessionId);
        CompanionCredential? renewed = sessions.Renew(paired.Token, Hosted);
        Assert.NotNull(renewed);
        Assert.Equal(paired.SessionId, renewed.SessionId);
        foreach (string variant in HostedVariants)
        {
            Assert.True(sessions.TryAuthenticate(renewed.Token, variant, out _), variant);
        }

        Assert.False(sessions.TryAuthenticate(renewed.Token, Preview, out _));
        for (int attempt = 0; attempt < 5; attempt++)
        {
            FailAttempts(sessions, HostedVariants[attempt % HostedVariants.Length], 1);
        }

        AssertBlockedForFailureWindow(sessions, time, HostedVariants[2]);
    }

    [Fact]
    public void EncodedAliasOfSameBytesIsRejected()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential credential = Pair(sessions, Hosted);
        int index = Base64UrlAlphabet.IndexOf(credential.Token[^1], StringComparison.Ordinal);
        Assert.Equal(0, index % 4);
        string alias = credential.Token[..^1] + Base64UrlAlphabet[index | 1];
        Assert.NotEqual(credential.Token, alias);
        Assert.Equal(DecodeBase64Url(credential.Token), DecodeBase64Url(alias));

        Assert.False(sessions.TryAuthenticate(alias, Hosted, out Guid aliasId));
        Assert.Equal(Guid.Empty, aliasId);
        Assert.Null(sessions.Renew(alias, Hosted));
        Assert.True(sessions.TryAuthenticate(credential.Token, Hosted, out Guid sessionId));
        Assert.Equal(credential.SessionId, sessionId);
    }

    [Fact]
    public void RepeatedLocalReplacementDoesNotLeakSessionSlots()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential current = sessions.ReplaceLocalCredential(Bundled, null);
        for (int reload = 0; reload < 6; reload++)
        {
            time.Advance(TimeSpan.FromMinutes(1));
            CompanionCredential replaced = sessions.ReplaceLocalCredential(Bundled, current.SessionId);
            Assert.NotEqual(current.Token, replaced.Token);
            Assert.Equal(time.GetUtcNow().AddMinutes(30), replaced.ExpiresAtUtc);
            Assert.False(sessions.TryAuthenticate(current.Token, Bundled, out _));
            Assert.True(sessions.TryAuthenticate(replaced.Token, Bundled, out Guid sessionId));
            Assert.Equal(replaced.SessionId, sessionId);
            current = replaced;
        }

        Pair(sessions, Hosted);
        Pair(sessions, Preview);
        Pair(sessions, ViteDev);
        Assert.False(sessions.TryPair(sessions.CreatePairingChallenge().Code, Hosted, out _));
        Assert.True(sessions.TryAuthenticate(current.Token, Bundled, out _));
    }

    [Fact]
    public void ReplacesLocalSessionAfterBrowserRenewal()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential original = sessions.CreateLocalCredential(Bundled);
        time.Advance(TimeSpan.FromMinutes(25));
        CompanionCredential? renewed = sessions.Renew(original.Token, Bundled);
        Assert.NotNull(renewed);
        Assert.Equal(original.SessionId, renewed.SessionId);
        CompanionCredential hosted = Pair(sessions, Hosted);
        Pair(sessions, Preview);
        Pair(sessions, ViteDev);

        CompanionCredential replaced = sessions.ReplaceLocalCredential(Bundled, original.SessionId);
        Assert.False(sessions.TryAuthenticate(renewed.Token, Bundled, out _));
        Assert.Null(sessions.Renew(renewed.Token, Bundled));
        Assert.True(sessions.TryAuthenticate(replaced.Token, Bundled, out Guid sessionId));
        Assert.Equal(replaced.SessionId, sessionId);
        Assert.True(sessions.TryAuthenticate(hosted.Token, Hosted, out _));
        Assert.False(sessions.TryPair(sessions.CreatePairingChallenge().Code, Hosted, out _));
    }

    [Fact]
    public void LocalReplacementKeepsHostedAndOtherSessions()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential hosted = Pair(sessions, Hosted);
        CompanionCredential otherLocal = sessions.CreateLocalCredential(Bundled);
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        CompanionCredential preview = Pair(sessions, Preview);

        CompanionCredential replaced = sessions.ReplaceLocalCredential(Bundled, local.SessionId);
        Assert.False(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(replaced.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(hosted.Token, Hosted, out Guid hostedId));
        Assert.Equal(hosted.SessionId, hostedId);
        Assert.True(sessions.TryGetSessionLease(hosted.SessionId, out _));
        Assert.True(sessions.TryAuthenticate(preview.Token, Preview, out _));
        Assert.True(sessions.TryAuthenticate(otherLocal.Token, Bundled, out Guid otherId));
        Assert.Equal(otherLocal.SessionId, otherId);
    }

    [Fact]
    public void ReplacementRejectsUnallowedOriginAndNeverRemovesHostedSession()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential hosted = Pair(sessions, Hosted);
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        foreach (string origin in NonLocalCredentialOrigins)
        {
            Assert.Throws<ArgumentException>(() => sessions.ReplaceLocalCredential(origin, local.SessionId));
            Assert.Throws<ArgumentException>(() => sessions.ReplaceLocalCredential(origin, hosted.SessionId));
        }

        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(hosted.Token, Hosted, out _));

        Pair(sessions, Preview);
        CompanionCredential fresh = sessions.ReplaceLocalCredential(Bundled, hosted.SessionId);
        Assert.True(sessions.TryAuthenticate(fresh.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(hosted.Token, Hosted, out _));
        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.Throws<InvalidOperationException>(() => sessions.ReplaceLocalCredential(Bundled, hosted.SessionId));
        Assert.True(sessions.TryAuthenticate(hosted.Token, Hosted, out _));
        Assert.True(sessions.TryGetSessionLease(hosted.SessionId, out _));
    }

    [Fact]
    public void UnknownSessionAtCapFailsWithoutDeleting()
    {
        CompanionSessionManager sessions = new(Policy(), new ManualTimeProvider());
        CompanionCredential local = sessions.CreateLocalCredential(Bundled);
        CompanionCredential hosted = Pair(sessions, Hosted);
        CompanionCredential preview = Pair(sessions, Preview);
        CompanionCredential vite = Pair(sessions, ViteDev);

        Assert.Throws<InvalidOperationException>(() => sessions.ReplaceLocalCredential(Bundled, Guid.NewGuid()));
        Assert.Throws<InvalidOperationException>(() => sessions.ReplaceLocalCredential(Bundled, Guid.Empty));
        Assert.Throws<InvalidOperationException>(() => sessions.ReplaceLocalCredential(Bundled, null));
        Assert.True(sessions.TryAuthenticate(local.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(hosted.Token, Hosted, out _));
        Assert.True(sessions.TryAuthenticate(preview.Token, Preview, out _));
        Assert.True(sessions.TryAuthenticate(vite.Token, ViteDev, out _));
    }

    [Fact]
    public void ExpiredLocalSessionIsRecreatedAndThenReplaceable()
    {
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(Policy(), time);
        CompanionCredential stale = sessions.CreateLocalCredential(Bundled);
        time.Advance(TimeSpan.FromMinutes(10));
        CompanionCredential live = sessions.CreateLocalCredential(Bundled);
        time.Advance(TimeSpan.FromMinutes(20));
        Assert.False(sessions.TryAuthenticate(stale.Token, Bundled, out _));

        CompanionCredential recreated = sessions.ReplaceLocalCredential(Bundled, stale.SessionId);
        Assert.Equal(time.GetUtcNow().AddMinutes(30), recreated.ExpiresAtUtc);
        Assert.True(sessions.TryAuthenticate(recreated.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(live.Token, Bundled, out _));

        Pair(sessions, Hosted);
        Pair(sessions, Preview);
        CompanionCredential reloaded = sessions.ReplaceLocalCredential(Bundled, recreated.SessionId);
        Assert.False(sessions.TryAuthenticate(recreated.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(reloaded.Token, Bundled, out _));
        Assert.True(sessions.TryAuthenticate(live.Token, Bundled, out _));
    }

    private static BrowserOriginPolicy Policy() => new(ConfiguredOrigins);

    private static CompanionCredential Pair(CompanionSessionManager sessions, string origin)
    {
        PairingChallenge challenge = sessions.CreatePairingChallenge();
        Assert.True(sessions.TryPair(challenge.Code, origin, out CompanionCredential? credential));
        Assert.NotNull(credential);
        return credential;
    }

    private static void FailAttempts(CompanionSessionManager sessions, string origin, int count)
    {
        for (int attempt = 0; attempt < count; attempt++)
        {
            Assert.False(sessions.TryPair(WrongCode, origin, out _));
        }
    }

    private static bool IsBase64Url(string value, int length) =>
        value.Length == length && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    private static byte[] DecodeBase64Url(string value) =>
        Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/').PadRight((value.Length + 3) / 4 * 4, '='));

    private static void AssertBlockedForFailureWindow(CompanionSessionManager sessions, ManualTimeProvider time, string origin)
    {
        PairingChallenge fresh = sessions.CreatePairingChallenge();
        Assert.False(sessions.TryPair(fresh.Code, origin, out _));
        time.Advance(TimeSpan.FromMinutes(1) - TimeSpan.FromTicks(1));
        Assert.False(sessions.TryPair(fresh.Code, origin, out _));
        time.Advance(TimeSpan.FromTicks(1));
        Assert.True(sessions.TryPair(fresh.Code, origin, out _));
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow = Start;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan delta) => _utcNow += delta;
    }
}
