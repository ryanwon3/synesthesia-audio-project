using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace SpotifySynesthesia.AudioEngine.Lyrics;

public interface ILyricsCache
{
    Task<LyricAnalysisCache?> GetAsync(string trackId, string model, CancellationToken cancellationToken);
    Task SaveAsync(string trackId, LyricAnalysisCache entry, CancellationToken cancellationToken);
}

// A separate table makes generated lyrics updates independent of Last.fm and personal overrides.
public sealed class SqliteLyricsCache(string databasePath) : ILyricsCache
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private async Task<SqliteConnection> OpenAsync(CancellationToken token)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(databasePath))!);
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = databasePath }.ToString());
        await connection.OpenAsync(token).ConfigureAwait(false);
        using var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS lyrics_visual_cache (
              track_id TEXT NOT NULL, model TEXT NOT NULL, cache_key TEXT NOT NULL,
              entry_json TEXT NOT NULL, PRIMARY KEY(track_id, model));
            """;
        await command.ExecuteNonQueryAsync(token).ConfigureAwait(false);
        return connection;
    }
    public async Task<LyricAnalysisCache?> GetAsync(string trackId, string model, CancellationToken cancellationToken)
    {
        using var connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT entry_json FROM lyrics_visual_cache WHERE track_id=$track AND model=$model";
        command.Parameters.AddWithValue("$track", trackId); command.Parameters.AddWithValue("$model", model);
        if (await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is not string json) return null;
        try
        {
            var entry = JsonSerializer.Deserialize<LyricAnalysisCache>(json, Json);
            return entry?.Lyrics?.Lines is not null && entry.PromptVersion == OpenAiLyricsAnalyzer.PromptVersion &&
                entry.SchemaVersion == OpenAiLyricsAnalyzer.SchemaVersion && OpenAiLyricsAnalyzer.IsValidProfile(entry.Visual) &&
                entry.CacheKey == Key(trackId, entry.Lyrics.Hash, model) ? entry : null;
        }
        catch (JsonException) { return null; }
    }
    public async Task SaveAsync(string trackId, LyricAnalysisCache entry, CancellationToken cancellationToken)
    {
        using var connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO lyrics_visual_cache(track_id,model,cache_key,entry_json) VALUES($track,$model,$key,$json)
            ON CONFLICT(track_id,model) DO UPDATE SET cache_key=$key, entry_json=$json;
            """;
        command.Parameters.AddWithValue("$track", trackId); command.Parameters.AddWithValue("$model", entry.Model);
        command.Parameters.AddWithValue("$key", entry.CacheKey); command.Parameters.AddWithValue("$json", JsonSerializer.Serialize(entry, Json));
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }
    public static string Key(string trackId, string hash, string model) =>
        $"{trackId}:{hash}:{model}:{OpenAiLyricsAnalyzer.PromptVersion}:{OpenAiLyricsAnalyzer.SchemaVersion}";
}
