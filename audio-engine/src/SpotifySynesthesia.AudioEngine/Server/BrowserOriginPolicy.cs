using System.Buffers;
using System.Collections.Frozen;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace SpotifySynesthesia.AudioEngine.Server;

public sealed class BrowserOriginPolicy
{
    private const int MaxOriginLength = 300;
    private const int MaxHostNameLength = 253;
    private const int MaxLabelLength = 63;
    private const string HttpsPrefix = "https://";
    private const string HttpPrefix = "http://";

    private static readonly SearchValues<char> AuthorityCharacters =
        SearchValues.Create("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-.:[]");
    private static readonly SearchValues<char> HostNameCharacters =
        SearchValues.Create("abcdefghijklmnopqrstuvwxyz0123456789-");
    private static readonly SearchValues<char> Ipv6Characters =
        SearchValues.Create("ABCDEFabcdef0123456789:.");

    private readonly FrozenSet<CanonicalOrigin> _allowedOrigins;

    public BrowserOriginPolicy(IEnumerable<string> allowedOrigins)
    {
        ArgumentNullException.ThrowIfNull(allowedOrigins);
        HashSet<CanonicalOrigin> origins = [];
        foreach (string configured in allowedOrigins)
        {
            if (!TryParse(configured, out CanonicalOrigin origin) ||
                (origin.Scheme == CanonicalOrigin.Http && !origin.IsLoopback))
            {
                throw new ArgumentException(
                    "Allowed origins must be exact HTTPS origins or explicit loopback HTTP origins without paths, credentials, queries, fragments, or wildcards.",
                    nameof(allowedOrigins));
            }

            origins.Add(origin);
        }

        _allowedOrigins = origins.ToFrozenSet();
    }

    internal int Count => _allowedOrigins.Count;

    public bool IsAllowed(string? origin) => TryGetAllowedOrigin(origin, out _);

    internal bool TryGetAllowedOrigin(string? origin, out CanonicalOrigin canonical)
    {
        if (TryParse(origin, out canonical) && _allowedOrigins.Contains(canonical))
        {
            return true;
        }

        canonical = default;
        return false;
    }

    // Parses the serialized origin text itself; System.Uri is never used so normalization cannot hide bad forms.
    private static bool TryParse(string? value, out CanonicalOrigin origin)
    {
        origin = default;
        if (value is null || value.Length > MaxOriginLength)
        {
            return false;
        }

        string scheme;
        int port;
        ReadOnlySpan<char> authority;
        if (value.StartsWith(HttpsPrefix, StringComparison.OrdinalIgnoreCase))
        {
            scheme = CanonicalOrigin.Https;
            port = 443;
            authority = value.AsSpan(HttpsPrefix.Length);
        }
        else if (value.StartsWith(HttpPrefix, StringComparison.OrdinalIgnoreCase))
        {
            scheme = CanonicalOrigin.Http;
            port = 80;
            authority = value.AsSpan(HttpPrefix.Length);
        }
        else
        {
            return false;
        }

        if (authority.IsEmpty || authority.ContainsAnyExcept(AuthorityCharacters))
        {
            return false;
        }

        ReadOnlySpan<char> host = authority;
        int separator = authority[0] == '[' ? authority.IndexOf(']') + 1 : authority.IndexOf(':');
        if (separator == 0)
        {
            return false;
        }

        if (separator > 0 && separator < authority.Length)
        {
            if (authority[separator] != ':' || !TryParsePort(authority[(separator + 1)..], out port))
            {
                return false;
            }

            host = authority[..separator];
        }

        if (!TryCanonicalizeHost(host, out string canonicalHost, out bool isIpLiteral))
        {
            return false;
        }

        origin = new CanonicalOrigin(scheme, canonicalHost, port, isIpLiteral);
        return true;
    }

    private static bool TryParsePort(ReadOnlySpan<char> text, out int port)
    {
        port = 0;
        return text.Length is >= 1 and <= 5 &&
            text[0] != '0' &&
            !text.ContainsAnyExceptInRange('0', '9') &&
            int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out port) &&
            port <= 65535;
    }

    private static bool TryCanonicalizeHost(ReadOnlySpan<char> host, out string canonical, out bool isIpLiteral)
    {
        canonical = string.Empty;
        isIpLiteral = false;
        if (host.Length >= 2 && host[0] == '[' && host[^1] == ']')
        {
            ReadOnlySpan<char> literal = host[1..^1];
            if (literal.IsEmpty ||
                literal.ContainsAnyExcept(Ipv6Characters) ||
                !IPAddress.TryParse(literal, out IPAddress? address) ||
                address.AddressFamily != AddressFamily.InterNetworkV6)
            {
                return false;
            }

            canonical = string.Concat("[", address.ToString(), "]");
            isIpLiteral = true;
            return true;
        }

        if (host.IsEmpty || host.Length > MaxHostNameLength || host.ContainsAny('[', ']'))
        {
            return false;
        }

        Span<char> lower = stackalloc char[host.Length];
        Ascii.ToLower(host, lower, out _);
        ReadOnlySpan<char> lastLabel = lower[(lower.LastIndexOf('.') + 1)..];

        // A numeric final label is an IPv4 address to browsers; only strict dotted-quad form is accepted.
        isIpLiteral = !lastLabel.IsEmpty && char.IsAsciiDigit(lastLabel[0]);
        if (isIpLiteral ? !IsStrictIpv4(lower) : !IsHostName(lower))
        {
            return false;
        }

        canonical = new string(lower);
        return true;
    }

    private static bool IsHostName(ReadOnlySpan<char> host)
    {
        while (true)
        {
            int dot = host.IndexOf('.');
            ReadOnlySpan<char> label = dot < 0 ? host : host[..dot];
            if (label.IsEmpty ||
                label.Length > MaxLabelLength ||
                label[0] == '-' ||
                label[^1] == '-' ||
                label.ContainsAnyExcept(HostNameCharacters))
            {
                return false;
            }

            if (dot < 0)
            {
                return true;
            }

            host = host[(dot + 1)..];
        }
    }

    private static bool IsStrictIpv4(ReadOnlySpan<char> host)
    {
        for (int octet = 0; octet < 4; octet++)
        {
            int dot = host.IndexOf('.');
            if ((dot < 0) != (octet == 3))
            {
                return false;
            }

            ReadOnlySpan<char> part = dot < 0 ? host : host[..dot];
            if (part.Length is < 1 or > 3 ||
                (part.Length > 1 && part[0] == '0') ||
                part.ContainsAnyExceptInRange('0', '9') ||
                int.Parse(part, NumberStyles.None, CultureInfo.InvariantCulture) > 255)
            {
                return false;
            }

            if (dot >= 0)
            {
                host = host[(dot + 1)..];
            }
        }

        return true;
    }
}

internal readonly record struct CanonicalOrigin(string Scheme, string Host, int Port, bool IsIpLiteral)
{
    internal const string Http = "http";
    internal const string Https = "https";

    internal bool IsLiteralLoopback =>
        IsIpLiteral && (Host == "[::1]" || Host.StartsWith("127.", StringComparison.Ordinal));

    internal bool IsLoopback => IsLiteralLoopback || Host == "localhost";

    internal bool IsLiteralLoopbackHttp => Scheme == Http && IsLiteralLoopback;
}
