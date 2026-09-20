using System.Text.Json;
using System.Text.Json.Serialization;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Server;

public static class SongContextProtocol
{
    public const int CurrentVersion = 1;
    public const string Path = "/song-context";
    public const string MessageType = "songContext";
    public const string ConfigureAndConnectCommand = "configureAndConnectSpotify";
}

public enum SqliteStatus
{
    Initializing,
    Ready,
    Error,
}

public sealed record SongContextSnapshot(
    SpotifyMetadataStatus MetadataStatus,
    SpotifyAuthenticationStatus AuthenticationStatus,
    string? AuthenticationDetail,
    bool SpotifyConfigured,
    DateTimeOffset? AuthorizationGrantedAtUtc,
    DateTimeOffset? RefreshCredentialExpiresAtUtc,
    CurrentTrack? CurrentTrack,
    bool Stale,
    DateTimeOffset? LastSuccessfulUpdateUtc,
    DateTimeOffset? NextRetryUtc,
    SongProfile? ActiveProfile,
    SongProfileSource? ProfileSource,
    SqliteStatus SqliteStatus,
    string DatabasePath,
    double? CurrentPollingIntervalMilliseconds,
    LastFmContextState? LastFm = null,
    bool OpenAiConfigured = false,
    Lyrics.LyricsAnalysisState? LyricsAnalysis = null,
    Lyrics.LyricsAnalysisSettings? LyricsSettings = null);

public sealed record SongContextMessage(
    int ProtocolVersion,
    string Type,
    SongContextSnapshot Payload)
{
    public static SongContextMessage Create(SongContextSnapshot snapshot) => new(
        SongContextProtocol.CurrentVersion,
        SongContextProtocol.MessageType,
        snapshot);
}

public sealed record SongContextCommand(
    int ProtocolVersion,
    string Type,
    string? ClientId)
{
    public bool IsValid =>
        ProtocolVersion == SongContextProtocol.CurrentVersion &&
        string.Equals(Type, SongContextProtocol.ConfigureAndConnectCommand, StringComparison.Ordinal);
}

public static class SongContextJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        JsonSerializerOptions options = new(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }
}
