using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Database;

public sealed class SqliteSongProfileRepository : ISongProfileRepository
{
    public const int CurrentDatabaseVersion = 1;
    public const int CurrentSongProfileSchemaVersion = 2;

    private readonly string _connectionString;
    private readonly TimeProvider _timeProvider;

    public SqliteSongProfileRepository(string? databasePath = null, TimeProvider? timeProvider = null)
    {
        DatabasePath = Path.GetFullPath(databasePath ?? SpotifyLocalPaths.SongProfileDatabasePath);
        _timeProvider = timeProvider ?? TimeProvider.System;
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
        }.ToString();
    }

    public string DatabasePath { get; }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(DatabasePath)!);
        await using SqliteConnection connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteTransaction transaction = (SqliteTransaction)await connection
            .BeginTransactionAsync(cancellationToken)
            .ConfigureAwait(false);
        int version = await GetUserVersionAsync(connection, transaction, cancellationToken).ConfigureAwait(false);

        if (version > CurrentDatabaseVersion)
        {
            throw new InvalidOperationException(
                $"Song profile database version {version} is newer than supported version {CurrentDatabaseVersion}.");
        }

        if (version == 0)
        {
            await using SqliteCommand create = connection.CreateCommand();
            create.Transaction = transaction;
            create.CommandText = """
                CREATE TABLE IF NOT EXISTS song_profiles (
                    spotify_track_id TEXT PRIMARY KEY NOT NULL,
                    spotify_uri TEXT NULL,
                    isrc TEXT NULL,
                    title TEXT NULL,
                    artists_json TEXT NOT NULL,
                    spotify_album_id TEXT NULL,
                    album_name TEXT NULL,
                    artwork_url TEXT NULL,
                    release_date TEXT NULL,
                    release_date_precision TEXT NULL,
                    duration_ms INTEGER NULL,
                    explicit INTEGER NULL,
                    metadata_json TEXT NULL,
                    musical_analysis_json TEXT NULL,
                    lyric_analysis_json TEXT NULL,
                    semantic_analysis_json TEXT NULL,
                    personal_overrides_json TEXT NULL,
                    song_profile_schema_version INTEGER NOT NULL,
                    created_at_utc TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                );
                PRAGMA user_version = 1;
                """;
            await create.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<SongProfileLoadResult> GetOrCreateAndRefreshIdentityAsync(
        CurrentTrack track,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(track);
        if (string.IsNullOrWhiteSpace(track.SpotifyTrackId))
        {
            throw new ArgumentException("A stable Spotify track ID is required.", nameof(track));
        }

        await using SqliteConnection connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteTransaction transaction = (SqliteTransaction)await connection
            .BeginTransactionAsync(cancellationToken)
            .ConfigureAwait(false);
        DateTimeOffset now = _timeProvider.GetUtcNow();
        string artistsJson = JsonSerializer.Serialize(track.Artists, SongProfileJson.Options);

        await using SqliteCommand insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            INSERT INTO song_profiles (
                spotify_track_id, spotify_uri, isrc, title, artists_json,
                spotify_album_id, album_name, artwork_url, release_date, release_date_precision,
                duration_ms, explicit, song_profile_schema_version, created_at_utc, updated_at_utc)
            VALUES (
                $trackId, $uri, $isrc, $title, $artists,
                $albumId, $albumName, $artworkUrl, $releaseDate, $releasePrecision,
                $durationMs, $explicit, $profileVersion, $createdAt, $updatedAt)
            ON CONFLICT(spotify_track_id) DO NOTHING;
            """;
        AddIdentityParameters(insert, track, artistsJson);
        insert.Parameters.AddWithValue("$profileVersion", CurrentSongProfileSchemaVersion);
        insert.Parameters.AddWithValue("$createdAt", FormatTimestamp(now));
        insert.Parameters.AddWithValue("$updatedAt", FormatTimestamp(now));
        bool inserted = await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) == 1;

        if (!inserted)
        {
            await using SqliteCommand update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = """
                UPDATE song_profiles
                SET spotify_uri = $uri,
                    isrc = $isrc,
                    title = $title,
                    artists_json = $artists,
                    spotify_album_id = $albumId,
                    album_name = $albumName,
                    artwork_url = $artworkUrl,
                    release_date = $releaseDate,
                    release_date_precision = $releasePrecision,
                    duration_ms = $durationMs,
                    explicit = $explicit,
                    song_profile_schema_version = $profileVersion,
                    updated_at_utc = $updatedAt
                WHERE spotify_track_id = $trackId;
                """;
            AddIdentityParameters(update, track, artistsJson);
            update.Parameters.AddWithValue("$profileVersion", CurrentSongProfileSchemaVersion);
            update.Parameters.AddWithValue("$updatedAt", FormatTimestamp(now));
            await update.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }

        SongProfile profile = await ReadProfileAsync(
            connection,
            transaction,
            track.SpotifyTrackId,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return new SongProfileLoadResult(profile, inserted ? SongProfileSource.New : SongProfileSource.Cached);
    }

    public async Task<SongProfile> UpdateLastFmEnrichmentAsync(
        string spotifyTrackId,
        LastFmEnrichment enrichment,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(spotifyTrackId))
        {
            throw new ArgumentException("A stable Spotify track ID is required.", nameof(spotifyTrackId));
        }

        ArgumentNullException.ThrowIfNull(enrichment);
        if (enrichment.Status is not LastFmStatus.Succeeded and not LastFmStatus.NoMatch)
        {
            throw new ArgumentException("Only cacheable Last.fm results can be persisted.", nameof(enrichment));
        }

        await using SqliteConnection connection = await OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteTransaction transaction = (SqliteTransaction)await connection
            .BeginTransactionAsync(cancellationToken)
            .ConfigureAwait(false);
        JsonElement? existingMetadata = await ReadMetadataAsync(
            connection,
            transaction,
            spotifyTrackId,
            cancellationToken).ConfigureAwait(false);
        JsonElement merged = SongProfileMetadata.MergeLastFm(existingMetadata, enrichment);
        DateTimeOffset now = _timeProvider.GetUtcNow();

        await using SqliteCommand update = connection.CreateCommand();
        update.Transaction = transaction;
        update.CommandText = """
            UPDATE song_profiles
            SET metadata_json = $metadata,
                song_profile_schema_version = $profileVersion,
                updated_at_utc = $updatedAt
            WHERE spotify_track_id = $trackId;
            """;
        update.Parameters.AddWithValue("$metadata", merged.GetRawText());
        update.Parameters.AddWithValue("$profileVersion", CurrentSongProfileSchemaVersion);
        update.Parameters.AddWithValue("$updatedAt", FormatTimestamp(now));
        update.Parameters.AddWithValue("$trackId", spotifyTrackId);
        if (await update.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) != 1)
        {
            throw new InvalidOperationException("The SongProfile no longer exists.");
        }

        SongProfile profile = await ReadProfileAsync(
            connection,
            transaction,
            spotifyTrackId,
            cancellationToken).ConfigureAwait(false);
        await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        return profile;
    }

    private async Task<SqliteConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        SqliteConnection connection = new(_connectionString);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteCommand pragmas = connection.CreateCommand();
        pragmas.CommandText = "PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;";
        await pragmas.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        return connection;
    }

    private static async Task<int> GetUserVersionAsync(
        SqliteConnection connection,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "PRAGMA user_version;";
        object? value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        return Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }

    private static async Task<JsonElement?> ReadMetadataAsync(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string trackId,
        CancellationToken cancellationToken)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT metadata_json FROM song_profiles WHERE spotify_track_id = $trackId;";
        command.Parameters.AddWithValue("$trackId", trackId);
        object? value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        if (value is null)
        {
            throw new InvalidOperationException("The SongProfile was not found.");
        }

        if (value is DBNull)
        {
            return null;
        }

        using JsonDocument document = JsonDocument.Parse((string)value);
        return document.RootElement.Clone();
    }

    private static async Task<SongProfile> ReadProfileAsync(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string trackId,
        CancellationToken cancellationToken)
    {
        await using SqliteCommand select = connection.CreateCommand();
        select.Transaction = transaction;
        select.CommandText = "SELECT * FROM song_profiles WHERE spotify_track_id = $trackId;";
        select.Parameters.AddWithValue("$trackId", trackId);
        await using SqliteDataReader reader = await select.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("The SongProfile was not found after an atomic get-or-create operation.");
        }

        IReadOnlyList<SpotifyArtistIdentity> artists = JsonSerializer.Deserialize<List<SpotifyArtistIdentity>>(
            reader.GetString(reader.GetOrdinal("artists_json")),
            SongProfileJson.Options) ?? [];
        SpotifyAlbumIdentity? album = ReadAlbum(reader);

        return new SongProfile(
            new SongProfileIdentity(
                trackId,
                GetNullableString(reader, "spotify_uri"),
                GetNullableString(reader, "isrc"),
                GetNullableString(reader, "title"),
                artists,
                album,
                GetNullableInt64(reader, "duration_ms"),
                GetNullableBoolean(reader, "explicit")),
            new ReservedSongProfileData(
                ParseNullableJson(reader, "metadata_json"),
                ParseNullableJson(reader, "musical_analysis_json"),
                ParseNullableJson(reader, "lyric_analysis_json"),
                ParseNullableJson(reader, "semantic_analysis_json"),
                ParseNullableJson(reader, "personal_overrides_json")),
            new SongProfileCacheMetadata(
                DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("created_at_utc")), CultureInfo.InvariantCulture),
                DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("updated_at_utc")), CultureInfo.InvariantCulture),
                reader.GetInt32(reader.GetOrdinal("song_profile_schema_version"))));
    }

    private static SpotifyAlbumIdentity? ReadAlbum(SqliteDataReader reader)
    {
        string? id = GetNullableString(reader, "spotify_album_id");
        string? name = GetNullableString(reader, "album_name");
        string? artwork = GetNullableString(reader, "artwork_url");
        string? releaseDate = GetNullableString(reader, "release_date");
        string? precision = GetNullableString(reader, "release_date_precision");
        return id is null && name is null && artwork is null && releaseDate is null && precision is null
            ? null
            : new SpotifyAlbumIdentity(id, name, artwork, releaseDate, precision);
    }

    private static void AddIdentityParameters(
        SqliteCommand command,
        CurrentTrack track,
        string artistsJson)
    {
        command.Parameters.AddWithValue("$trackId", track.SpotifyTrackId);
        command.Parameters.AddWithValue("$uri", DbValue(track.SpotifyUri));
        command.Parameters.AddWithValue("$isrc", DbValue(track.Isrc));
        command.Parameters.AddWithValue("$title", DbValue(track.Title));
        command.Parameters.AddWithValue("$artists", artistsJson);
        command.Parameters.AddWithValue("$albumId", DbValue(track.Album?.SpotifyAlbumId));
        command.Parameters.AddWithValue("$albumName", DbValue(track.Album?.Name));
        command.Parameters.AddWithValue("$artworkUrl", DbValue(track.Album?.ArtworkUrl));
        command.Parameters.AddWithValue("$releaseDate", DbValue(track.Album?.ReleaseDate));
        command.Parameters.AddWithValue("$releasePrecision", DbValue(track.Album?.ReleaseDatePrecision));
        command.Parameters.AddWithValue("$durationMs", track.DurationMs is null ? DBNull.Value : track.DurationMs.Value);
        command.Parameters.AddWithValue("$explicit", track.Explicit is null ? DBNull.Value : track.Explicit.Value ? 1 : 0);
    }

    private static object DbValue(string? value) => value is null ? DBNull.Value : value;

    private static string? GetNullableString(SqliteDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static long? GetNullableInt64(SqliteDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal);
    }

    private static bool? GetNullableBoolean(SqliteDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal) != 0;
    }

    private static JsonElement? ParseNullableJson(SqliteDataReader reader, string name)
    {
        string? json = GetNullableString(reader, name);
        if (json is null)
        {
            return null;
        }

        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static string FormatTimestamp(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
}

internal static class SongProfileJson
{
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    private static JsonSerializerOptions CreateOptions()
    {
        JsonSerializerOptions options = new(JsonSerializerDefaults.Web);
        options.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }
}
