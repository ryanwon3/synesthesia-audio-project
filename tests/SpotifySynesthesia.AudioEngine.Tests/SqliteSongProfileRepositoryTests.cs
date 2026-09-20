using System.Globalization;
using Microsoft.Data.Sqlite;
using SpotifySynesthesia.AudioEngine.Database;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class SqliteSongProfileRepositoryTests
{
    [Fact]
    public async Task CreatesThenLoadsAUniqueCachedProfile()
    {
        string path = CreateDatabasePath();
        try
        {
            SqliteSongProfileRepository repository = new(path);
            await repository.InitializeAsync(TestContext.Current.CancellationToken);

            SongProfileLoadResult created = await repository.GetOrCreateAndRefreshIdentityAsync(
                CreateTrack("track-1", "Original title"),
                TestContext.Current.CancellationToken);
            SqliteSongProfileRepository reopened = new(path);
            await reopened.InitializeAsync(TestContext.Current.CancellationToken);
            SongProfileLoadResult cached = await reopened.GetOrCreateAndRefreshIdentityAsync(
                CreateTrack("track-1", "Original title"),
                TestContext.Current.CancellationToken);

            Assert.Equal(SongProfileSource.New, created.Source);
            Assert.Equal(SongProfileSource.Cached, cached.Source);
            Assert.Equal(created.Profile.Identity.SpotifyTrackId, cached.Profile.Identity.SpotifyTrackId);
            Assert.Equal(1, await CountRowsAsync(path));
            Assert.Equal(SqliteSongProfileRepository.CurrentDatabaseVersion, await ReadUserVersionAsync(path));
            Assert.Equal(
                SqliteSongProfileRepository.CurrentSongProfileSchemaVersion,
                cached.Profile.CacheMetadata.SongProfileSchemaVersion);
        }
        finally
        {
            DeleteDatabase(path);
        }
    }

    [Fact]
    public async Task RefreshesSpotifyIdentityAndPreservesReservedJson()
    {
        string path = CreateDatabasePath();
        try
        {
            SqliteSongProfileRepository repository = new(path);
            await repository.InitializeAsync(TestContext.Current.CancellationToken);
            await repository.GetOrCreateAndRefreshIdentityAsync(
                CreateTrack("track-1", "Old title"),
                TestContext.Current.CancellationToken);
            await SeedReservedJsonAsync(path);

            SongProfileLoadResult refreshed = await repository.GetOrCreateAndRefreshIdentityAsync(
                CreateTrack("track-1", "New title") with
                {
                    Isrc = "NEWISRC",
                    Album = new SpotifyAlbumIdentity("new-album", "New album", "new-art", "2026", "year"),
                },
                TestContext.Current.CancellationToken);

            Assert.Equal(SongProfileSource.Cached, refreshed.Source);
            Assert.Equal("New title", refreshed.Profile.Identity.Title);
            Assert.Equal("NEWISRC", refreshed.Profile.Identity.Isrc);
            Assert.Equal("new-album", refreshed.Profile.Identity.Album?.SpotifyAlbumId);
            Assert.Equal("lastfm", refreshed.Profile.Reserved.Metadata?.GetProperty("source").GetString());
            Assert.Equal(0.75, refreshed.Profile.Reserved.MusicalAnalysis?.GetProperty("energy").GetDouble());
            Assert.Equal("blue", refreshed.Profile.Reserved.LyricAnalysis?.GetProperty("imagery").GetString());
            Assert.Equal("v-test", refreshed.Profile.Reserved.SemanticAnalysis?.GetProperty("version").GetString());
            Assert.Equal(0.4, refreshed.Profile.Reserved.PersonalOverrides?.GetProperty("warmth").GetDouble());
            Assert.Equal(1, await CountRowsAsync(path));

            IReadOnlyDictionary<string, string?> raw = await ReadReservedJsonAsync(path);
            Assert.Equal("{\"source\":\"lastfm\"}", raw["metadata_json"]);
            Assert.Equal("{\"energy\":0.75}", raw["musical_analysis_json"]);
            Assert.Equal("{\"imagery\":\"blue\"}", raw["lyric_analysis_json"]);
            Assert.Equal("{\"version\":\"v-test\"}", raw["semantic_analysis_json"]);
            Assert.Equal("{\"warmth\":0.4}", raw["personal_overrides_json"]);
        }
        finally
        {
            DeleteDatabase(path);
        }
    }

    [Fact]
    public async Task ConcurrentDuplicateIdsCreateOneRow()
    {
        string path = CreateDatabasePath();
        try
        {
            SqliteSongProfileRepository repository = new(path);
            await repository.InitializeAsync(TestContext.Current.CancellationToken);
            Task<SongProfileLoadResult>[] writes = Enumerable.Range(0, 4)
                .Select(index => repository.GetOrCreateAndRefreshIdentityAsync(
                    CreateTrack("same-id", $"Title {index}"),
                    TestContext.Current.CancellationToken))
                .ToArray();

            SongProfileLoadResult[] results = await Task.WhenAll(writes);

            Assert.Single(results, result => result.Source == SongProfileSource.New);
            Assert.Equal(1, await CountRowsAsync(path));
        }
        finally
        {
            DeleteDatabase(path);
        }
    }

    [Fact]
    public async Task LastFmUpdateUsesMetadataEnvelopeAndPreservesEveryOtherReservedColumn()
    {
        string path = CreateDatabasePath();
        try
        {
            SqliteSongProfileRepository repository = new(path);
            await repository.InitializeAsync(TestContext.Current.CancellationToken);
            await repository.GetOrCreateAndRefreshIdentityAsync(
                CreateTrack("track-1", "Title"),
                TestContext.Current.CancellationToken);
            await SeedReservedJsonAsync(path);
            LastFmEnrichment enrichment = new(
                LastFmEnrichment.ProviderSource,
                LastFmStatus.Succeeded,
                [new LastFmTag("dreamy", 1)],
                [new LastFmTag("dream pop", null)],
                "Title",
                "Artist",
                null,
                null,
                LastFmMatchQuality.Exact,
                "artist",
                "title",
                DateTimeOffset.Parse("2026-08-12T12:30:00Z", CultureInfo.InvariantCulture),
                LastFmEnrichment.CurrentSchemaVersion);

            SongProfile updated = await repository.UpdateLastFmEnrichmentAsync(
                "track-1",
                enrichment,
                TestContext.Current.CancellationToken);

            Assert.Equal("Title", updated.Identity.Title);
            Assert.Equal(LastFmStatus.Succeeded, SongProfileMetadata.GetLastFm(updated)?.Status);
            Assert.Equal(SqliteSongProfileRepository.CurrentSongProfileSchemaVersion, updated.CacheMetadata.SongProfileSchemaVersion);
            Assert.Equal(1, await CountRowsAsync(path));
            IReadOnlyDictionary<string, string?> raw = await ReadReservedJsonAsync(path);
            Assert.Contains("\"source\":\"lastfm\"", raw["metadata_json"], StringComparison.Ordinal);
            Assert.Contains("\"lastFm\"", raw["metadata_json"], StringComparison.Ordinal);
            Assert.Equal("{\"energy\":0.75}", raw["musical_analysis_json"]);
            Assert.Equal("{\"imagery\":\"blue\"}", raw["lyric_analysis_json"]);
            Assert.Equal("{\"version\":\"v-test\"}", raw["semantic_analysis_json"]);
            Assert.Equal("{\"warmth\":0.4}", raw["personal_overrides_json"]);
            Assert.Equal(SqliteSongProfileRepository.CurrentDatabaseVersion, await ReadUserVersionAsync(path));
        }
        finally
        {
            DeleteDatabase(path);
        }
    }

    private static CurrentTrack CreateTrack(string id, string title) => new(
        id,
        $"spotify:track:{id}",
        "USABC1234567",
        title,
        [new SpotifyArtistIdentity("artist-id", "Artist")],
        new SpotifyAlbumIdentity("album-id", "Album", "art", "2026-01-02", "day"),
        180_000,
        false,
        1_000,
        true,
        DateTimeOffset.Parse("2026-08-12T12:00:00Z", CultureInfo.InvariantCulture));

    private static string CreateDatabasePath() => Path.Combine(
        Path.GetTempPath(),
        $"spotify-synesthesia-tests-{Guid.NewGuid():N}",
        "profiles.db");

    private static async Task<int> CountRowsAsync(string path)
    {
        await using SqliteConnection connection = new($"Data Source={path}");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM song_profiles;";
        return Convert.ToInt32(
            await command.ExecuteScalarAsync(TestContext.Current.CancellationToken),
            CultureInfo.InvariantCulture);
    }

    private static async Task<int> ReadUserVersionAsync(string path)
    {
        await using SqliteConnection connection = new($"Data Source={path}");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version;";
        return Convert.ToInt32(
            await command.ExecuteScalarAsync(TestContext.Current.CancellationToken),
            CultureInfo.InvariantCulture);
    }

    private static async Task SeedReservedJsonAsync(string path)
    {
        await using SqliteConnection connection = new($"Data Source={path}");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            UPDATE song_profiles SET
                metadata_json = '{"source":"lastfm"}',
                musical_analysis_json = '{"energy":0.75}',
                lyric_analysis_json = '{"imagery":"blue"}',
                semantic_analysis_json = '{"version":"v-test"}',
                personal_overrides_json = '{"warmth":0.4}'
            WHERE spotify_track_id = 'track-1';
            """;
        await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
    }

    private static async Task<IReadOnlyDictionary<string, string?>> ReadReservedJsonAsync(string path)
    {
        await using SqliteConnection connection = new($"Data Source={path}");
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT metadata_json, musical_analysis_json, lyric_analysis_json,
                   semantic_analysis_json, personal_overrides_json
            FROM song_profiles WHERE spotify_track_id = 'track-1';
            """;
        await using SqliteDataReader reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
        Assert.True(await reader.ReadAsync(TestContext.Current.CancellationToken));
        return Enumerable.Range(0, reader.FieldCount).ToDictionary(
            reader.GetName,
            ordinal => reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal),
            StringComparer.Ordinal);
    }

    private static void DeleteDatabase(string path)
    {
        SqliteConnection.ClearAllPools();
        string? directory = Path.GetDirectoryName(path);
        if (directory is not null && Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
