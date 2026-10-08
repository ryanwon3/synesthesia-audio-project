using System.Buffers;
using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace SpotifySynesthesia.AudioEngine.Server;

public sealed record PairingChallenge(string Code, DateTimeOffset ExpiresAtUtc)
{
    public override string ToString() => string.Create(
        CultureInfo.InvariantCulture,
        $"{nameof(PairingChallenge)} {{ {nameof(Code)} = [redacted], {nameof(ExpiresAtUtc)} = {ExpiresAtUtc:O} }}");
}

public sealed record CompanionCredential(string Token, Guid SessionId, DateTimeOffset ExpiresAtUtc)
{
    public override string ToString() => string.Create(
        CultureInfo.InvariantCulture,
        $"{nameof(CompanionCredential)} {{ {nameof(Token)} = [redacted], {nameof(SessionId)} = {SessionId}, {nameof(ExpiresAtUtc)} = {ExpiresAtUtc:O} }}");
}

public sealed class CompanionSessionManager
{
    private const int ChallengeBytes = 16;
    private const int ChallengeLength = 22;
    private const int TokenBytes = 32;
    private const int TokenLength = 43;
    private const int MaxLiveSessions = 4;
    private const int MaxFailuresPerOrigin = 5;
    private const int MaxFailuresGlobal = 20;

    private static readonly TimeSpan ChallengeLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan AbsoluteLifetime = TimeSpan.FromHours(8);
    // Two initial-message deadlines: long enough for a disconnect racing a lost renewal reply, never a reuse window.
    private static readonly TimeSpan PriorTokenGrace = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(1);
    private static readonly SearchValues<char> Base64UrlCharacters =
        SearchValues.Create("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");

    private readonly Lock _gate = new();
    private readonly BrowserOriginPolicy _origins;
    private readonly TimeProvider _timeProvider;
    private readonly List<Session> _sessions = new(MaxLiveSessions);
    private readonly Dictionary<CanonicalOrigin, FailureCounter> _originFailures;
    private readonly FailureCounter _globalFailures = new();
    private byte[]? _challengeHash;
    private DateTimeOffset _challengeExpiresAtUtc;

    public CompanionSessionManager(BrowserOriginPolicy origins, TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(origins);
        _origins = origins;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _originFailures = new Dictionary<CanonicalOrigin, FailureCounter>(origins.Count);
    }

    public PairingChallenge CreatePairingChallenge()
    {
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            RemoveExpired(now);
            ClearChallenge();
            string code = IssueSecret(ChallengeBytes, out byte[] hash);
            _challengeHash = hash;
            _challengeExpiresAtUtc = now + ChallengeLifetime;
            return new PairingChallenge(code, _challengeExpiresAtUtc);
        }
    }

    public CompanionCredential CreateLocalCredential(string origin)
    {
        ArgumentNullException.ThrowIfNull(origin);
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            RemoveExpired(now);
            if (!_origins.TryGetAllowedOrigin(origin, out CanonicalOrigin canonical) || !canonical.IsLiteralLoopbackHttp)
            {
                throw new ArgumentException(
                    "Local credentials require a configured literal loopback HTTP origin.",
                    nameof(origin));
            }

            if (_sessions.Count >= MaxLiveSessions)
            {
                throw new InvalidOperationException("The companion session limit has been reached.");
            }

            return CreateSession(canonical, now);
        }
    }

    // Desktop composition only; never routed from a wire message.
    public CompanionCredential ReplaceLocalCredential(string origin, Guid? previousSessionId)
    {
        ArgumentNullException.ThrowIfNull(origin);
        lock (_gate)
        {
            if (!_origins.TryGetAllowedOrigin(origin, out CanonicalOrigin canonical) || !canonical.IsLiteralLoopbackHttp)
            {
                throw new ArgumentException(
                    "Local credentials require a configured literal loopback HTTP origin.",
                    nameof(origin));
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            RemoveExpired(now);

            // Only the exact session issued for this origin is replaced; unknown or foreign IDs remove nothing.
            int previous = -1;
            if (previousSessionId is Guid sessionId)
            {
                for (int index = 0; index < _sessions.Count; index++)
                {
                    if (_sessions[index].Id == sessionId && _sessions[index].Origin == canonical)
                    {
                        previous = index;
                        break;
                    }
                }
            }

            if (previous < 0 && _sessions.Count >= MaxLiveSessions)
            {
                throw new InvalidOperationException("The companion session limit has been reached.");
            }

            if (previous >= 0)
            {
                _sessions[previous].ClearSecrets();
                _sessions.RemoveAt(previous);
            }

            return CreateSession(canonical, now);
        }
    }

    public bool TryPair(string code, string origin, out CompanionCredential? credential)
    {
        credential = null;
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            RemoveExpired(now);
            if (!_origins.TryGetAllowedOrigin(origin, out CanonicalOrigin canonical))
            {
                return false;
            }

            _originFailures.TryGetValue(canonical, out FailureCounter? originFailures);
            if (_globalFailures.IsExhausted(now, MaxFailuresGlobal) ||
                (originFailures is not null && originFailures.IsExhausted(now, MaxFailuresPerOrigin)))
            {
                return false;
            }

            if (!MatchesChallenge(code))
            {
                if (originFailures is null)
                {
                    originFailures = new FailureCounter();
                    _originFailures.Add(canonical, originFailures);
                }

                originFailures.Record(now);
                _globalFailures.Record(now);
                return false;
            }

            if (_sessions.Count >= MaxLiveSessions)
            {
                return false;
            }

            ClearChallenge();
            credential = CreateSession(canonical, now);
            return true;
        }
    }

    public bool TryAuthenticate(string token, string origin, out Guid sessionId)
    {
        sessionId = Guid.Empty;
        lock (_gate)
        {
            Session? session = FindSession(token, origin, _timeProvider.GetUtcNow());
            if (session is null)
            {
                return false;
            }

            sessionId = session.Id;
            return true;
        }
    }

    internal bool TryGetSessionLease(Guid sessionId, out DateTimeOffset expiresAtUtc)
    {
        expiresAtUtc = default;
        lock (_gate)
        {
            RemoveExpired(_timeProvider.GetUtcNow());
            foreach (Session session in _sessions)
            {
                if (session.Id == sessionId)
                {
                    expiresAtUtc = session.ExpiresAtUtc;
                    return true;
                }
            }

            return false;
        }
    }

    public CompanionCredential? Renew(string token, string origin)
    {
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            Session? session = FindSession(token, origin, now);
            if (session is null)
            {
                return null;
            }

            string renewed = IssueSecret(TokenBytes, out byte[] hash);
            // The replaced token may only disconnect, and only briefly, so a browser that lost this reply can still revoke.
            session.Rotate(hash, now + PriorTokenGrace);
            DateTimeOffset lease = now + LeaseDuration;
            DateTimeOffset absolute = session.CreatedAtUtc + AbsoluteLifetime;
            session.ExpiresAtUtc = lease < absolute ? lease : absolute;
            return new CompanionCredential(renewed, session.Id, session.ExpiresAtUtc);
        }
    }

    internal bool Revoke(string token, string origin)
    {
        lock (_gate)
        {
            Session? session = FindSession(token, origin, _timeProvider.GetUtcNow(), includePrior: true);
            if (session is null)
            {
                return false;
            }

            session.ClearSecrets();
            _sessions.Remove(session);
            return true;
        }
    }

    public void RevokeAll()
    {
        lock (_gate)
        {
            ClearChallenge();
            foreach (Session session in _sessions)
            {
                session.ClearSecrets();
            }

            _sessions.Clear();
        }
    }

    private CompanionCredential CreateSession(CanonicalOrigin origin, DateTimeOffset now)
    {
        string token = IssueSecret(TokenBytes, out byte[] hash);
        Session session = new(Guid.NewGuid(), origin, now, hash, now + LeaseDuration);
        _sessions.Add(session);
        return new CompanionCredential(token, session.Id, session.ExpiresAtUtc);
    }

    // Authentication and renewal match only the current token; disconnect may also match the immediately prior one.
    private Session? FindSession(string? token, string? origin, DateTimeOffset now, bool includePrior = false)
    {
        RemoveExpired(now);
        Span<byte> hash = stackalloc byte[SHA256.HashSizeInBytes];
        if (!_origins.TryGetAllowedOrigin(origin, out CanonicalOrigin canonical) ||
            !TryHashSecret(token, TokenLength, hash))
        {
            return null;
        }

        // Compare against every live hash so timing does not reveal which slot matched.
        Session? match = null;
        foreach (Session session in _sessions)
        {
            bool matches = CryptographicOperations.FixedTimeEquals(session.TokenHash, hash);
            if (includePrior && session.PriorTokenHash is { } prior)
            {
                matches |= CryptographicOperations.FixedTimeEquals(prior, hash);
            }

            if (matches)
            {
                match = session;
            }
        }

        return match is not null && match.Origin == canonical && now < match.ExpiresAtUtc ? match : null;
    }

    private bool MatchesChallenge(string? code)
    {
        Span<byte> hash = stackalloc byte[SHA256.HashSizeInBytes];
        return _challengeHash is not null &&
            TryHashSecret(code, ChallengeLength, hash) &&
            CryptographicOperations.FixedTimeEquals(_challengeHash, hash);
    }

    private void RemoveExpired(DateTimeOffset now)
    {
        if (_challengeHash is not null && now >= _challengeExpiresAtUtc)
        {
            ClearChallenge();
        }

        for (int index = _sessions.Count - 1; index >= 0; index--)
        {
            Session session = _sessions[index];
            if (now >= session.ExpiresAtUtc)
            {
                session.ClearSecrets();
                _sessions.RemoveAt(index);
            }
            else if (session.PriorTokenHash is not null && now >= session.PriorValidUntilUtc)
            {
                session.ClearPrior();
            }
        }
    }

    private void ClearChallenge()
    {
        if (_challengeHash is not null)
        {
            CryptographicOperations.ZeroMemory(_challengeHash);
        }

        _challengeHash = null;
        _challengeExpiresAtUtc = default;
    }

    private static string IssueSecret(int byteCount, out byte[] hash)
    {
        Span<byte> random = stackalloc byte[TokenBytes];
        random = random[..byteCount];
        RandomNumberGenerator.Fill(random);
        string secret = Base64Url.EncodeToString(random);
        CryptographicOperations.ZeroMemory(random);
        hash = new byte[SHA256.HashSizeInBytes];
        _ = TryHashSecret(secret, secret.Length, hash);
        return secret;
    }

    // Hashes the exact token text so non-canonical base64url aliases of the same bytes never match.
    private static bool TryHashSecret(string? value, int length, Span<byte> hash)
    {
        if (value is null || value.Length != length || length > TokenLength ||
            value.AsSpan().ContainsAnyExcept(Base64UrlCharacters))
        {
            return false;
        }

        Span<byte> ascii = stackalloc byte[TokenLength];
        ascii = ascii[..length];
        Encoding.ASCII.GetBytes(value.AsSpan(), ascii);
        SHA256.HashData(ascii, hash);
        CryptographicOperations.ZeroMemory(ascii);
        return true;
    }

    private sealed class Session(
        Guid id,
        CanonicalOrigin origin,
        DateTimeOffset createdAtUtc,
        byte[] tokenHash,
        DateTimeOffset expiresAtUtc)
    {
        public Guid Id { get; } = id;

        public CanonicalOrigin Origin { get; } = origin;

        public DateTimeOffset CreatedAtUtc { get; } = createdAtUtc;

        public byte[] TokenHash { get; private set; } = tokenHash;

        // At most one prior hash per session; it never authenticates or renews.
        public byte[]? PriorTokenHash { get; private set; }

        public DateTimeOffset PriorValidUntilUtc { get; private set; }

        public DateTimeOffset ExpiresAtUtc { get; set; } = expiresAtUtc;

        public void Rotate(byte[] hash, DateTimeOffset priorValidUntilUtc)
        {
            ClearPrior();
            PriorTokenHash = TokenHash;
            PriorValidUntilUtc = priorValidUntilUtc;
            TokenHash = hash;
        }

        public void ClearPrior()
        {
            if (PriorTokenHash is not null)
            {
                CryptographicOperations.ZeroMemory(PriorTokenHash);
            }

            PriorTokenHash = null;
            PriorValidUntilUtc = default;
        }

        public void ClearSecrets()
        {
            CryptographicOperations.ZeroMemory(TokenHash);
            ClearPrior();
        }
    }

    private sealed class FailureCounter
    {
        private DateTimeOffset _windowStartUtc;
        private int _failures;

        public bool IsExhausted(DateTimeOffset now, int limit)
        {
            Roll(now);
            return _failures >= limit;
        }

        public void Record(DateTimeOffset now)
        {
            Roll(now);
            _failures++;
        }

        private void Roll(DateTimeOffset now)
        {
            if (now - _windowStartUtc >= FailureWindow)
            {
                _windowStartUtc = now;
                _failures = 0;
            }
        }
    }
}
