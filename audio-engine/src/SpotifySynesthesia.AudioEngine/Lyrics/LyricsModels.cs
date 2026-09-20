using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.Profiles;

namespace SpotifySynesthesia.AudioEngine.Lyrics;

public sealed record LyricLine(string Text, long? StartMs);
public sealed record LyricsDocument(string Source, string ProviderId, bool Instrumental, IReadOnlyList<LyricLine> Lines)
{
    public string Hash => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(Lines))));
    public bool Timed => Lines.Count > 0 && Lines.All(line => line.StartMs.HasValue);
}
public interface ILyricsProvider
{
    Task<LyricsDocument?> GetAsync(SongProfileIdentity identity, CancellationToken cancellationToken);
}

public sealed record MoodTraits(string Mood, double Energy, double Tension, double Softness, string Imagery,
    string BassEffect, string MidEffect, string TrebleEffect);
public sealed record VisualSection(long StartMs, long EndMs, MoodTraits Traits);
public sealed record SongVisualProfile(MoodTraits WholeSong, IReadOnlyList<VisualSection> Sections);
public sealed record LyricAnalysisCache(string CacheKey, string Model, int PromptVersion, int SchemaVersion,
    LyricsDocument Lyrics, SongVisualProfile Visual, DateTimeOffset CreatedAtUtc);
public sealed record LyricsAnalysisState(string Status, string? Source = null, bool Timed = false,
    bool Cached = false, string? Error = null, SongVisualProfile? Profile = null);
public sealed record LyricsAnalysisSettings(bool Automatic = true, string Model = "gpt-5-mini");
public sealed class EnrichmentException(string category, bool retryable = false, TimeSpan? retryAfter = null)
    : Exception(category)
{
    public string Category { get; } = category;
    public bool Retryable { get; } = retryable;
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
