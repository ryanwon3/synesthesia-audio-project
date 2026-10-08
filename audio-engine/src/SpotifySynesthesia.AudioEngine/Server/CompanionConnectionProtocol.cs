using System.Text.Json.Serialization;

namespace SpotifySynesthesia.AudioEngine.Server;

// Data-only wire contract. AudioFrameWebSocketServer owns parsing and enforcement;
// these descriptors perform no capture, service I/O, or credential issuance.
public static class CompanionConnectionProtocol
{
    public const int CurrentVersion = 1;
    public const string PairingPath = "/pair";

    public const string PairMessageType = "pair";
    public const string AuthenticateMessageType = "authenticate";
    public const string RenewMessageType = "renew";
    public const string DisconnectMessageType = "disconnect";

    public const string PairedMessageType = "paired";
    public const string AuthenticatedMessageType = "authenticated";
    public const string RenewedMessageType = "renewed";
    public const string DisconnectedMessageType = "disconnected";
    public const string AuthenticationFailedMessageType = "authenticationFailed";

    public const int MaxInitialMessageBytes = 1024;
    public const int AuthenticationCloseCode = 4401;

    public static TimeSpan InitialAuthenticationTimeout { get; } = TimeSpan.FromSeconds(5);
}

// Plain classes rather than records so the default ToString never prints codes or tokens.
public sealed class CompanionConnectionRequest
{
    public int ProtocolVersion { get; init; }

    public string? Type { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Code { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Token { get; init; }
}

public sealed class CompanionConnectionResponse
{
    public int ProtocolVersion { get; init; } = CompanionConnectionProtocol.CurrentVersion;

    public string? Type { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Token { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public DateTimeOffset? ExpiresAtUtc { get; init; }
}
