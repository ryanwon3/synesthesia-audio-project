using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using SpotifySynesthesia.AudioEngine.Profiles;

namespace SpotifySynesthesia.AudioEngine.Lyrics;

public sealed partial class LrcLibLyricsProvider(HttpClient http) : ILyricsProvider
{
    public async Task<LyricsDocument?> GetAsync(SongProfileIdentity identity, CancellationToken cancellationToken)
    {
        string? artist = identity.Artists.Count > 0 ? identity.Artists[0].Name : null;
        if (string.IsNullOrWhiteSpace(identity.Title) || string.IsNullOrWhiteSpace(artist) || identity.DurationMs is null)
            return null;
        string query = $"track_name={Uri.EscapeDataString(identity.Title)}&artist_name={Uri.EscapeDataString(artist)}" +
            $"&album_name={Uri.EscapeDataString(identity.Album?.Name ?? "")}&duration={identity.DurationMs.Value / 1000}";
        using HttpRequestMessage request = new(HttpMethod.Get, "https://lrclib.net/api/get?" + query);
        request.Headers.UserAgent.ParseAdd("SpotifySynesthesia/1.0");
        using HttpResponseMessage response = await http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        if (!response.IsSuccessStatusCode)
            throw new EnrichmentException("Lyrics service unavailable", (int)response.StatusCode is 429 or >= 500,
                RetryDelay(response));
        string json = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (json.Length > 100_000) throw new EnrichmentException("Lyrics response too large");
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        if (Normalize(root.GetProperty("trackName").GetString()) != Normalize(identity.Title) ||
            Normalize(root.GetProperty("artistName").GetString()) != Normalize(artist) ||
            Math.Abs(root.GetProperty("duration").GetDouble() * 1000 - identity.DurationMs.Value) > 2000)
            return null;
        string? returnedAlbum = ReadString(root, "albumName");
        if (!string.IsNullOrWhiteSpace(identity.Album?.Name) && !string.IsNullOrWhiteSpace(returnedAlbum) &&
            Normalize(returnedAlbum) != Normalize(identity.Album.Name)) return null;
        bool instrumental = root.TryGetProperty("instrumental", out var flag) && flag.ValueKind == JsonValueKind.True;
        var lines = ParseLines(ReadString(root, "syncedLyrics"), ReadString(root, "plainLyrics"), identity.DurationMs.Value);
        return new LyricsDocument("LRCLIB", root.GetProperty("id").ToString(), instrumental, lines);
    }

    public static IReadOnlyList<LyricLine> ParseLines(string? synced, string? plain, long durationMs)
    {
        List<LyricLine> lines = [];
        long offset = 0;
        if (!string.IsNullOrEmpty(synced))
        {
            Match offsetMatch = OffsetRegex().Match(synced);
            if (offsetMatch.Success && !long.TryParse(offsetMatch.Groups[1].Value, out offset)) offset = 0;
            foreach (string raw in synced.Split('\n'))
            {
                MatchCollection stamps = TimestampRegex().Matches(raw);
                string text = TimestampRegex().Replace(raw, "").Trim();
                // Empty timed lines are retained as section boundaries, never sent as instructions.
                foreach (Match stamp in stamps)
                {
                    long ms = (long)((double.Parse(stamp.Groups[1].Value, CultureInfo.InvariantCulture) * 60 +
                        double.Parse(stamp.Groups[2].Value, CultureInfo.InvariantCulture)) * 1000) + offset;
                    if (ms >= 0 && ms < durationMs) lines.Add(new(text, ms));
                }
            }
        }
        if (lines.Any(line => line.Text.Length > 0))
            return lines.OrderBy(line => line.StartMs).DistinctBy(line => (line.StartMs, line.Text)).Take(600).ToArray();
        return (plain ?? "").Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0)
            .Take(600).Select(line => new LyricLine(line, null)).ToArray();
    }
    internal static TimeSpan? RetryDelay(HttpResponseMessage response) => response.Headers.RetryAfter?.Delta ??
        (response.Headers.RetryAfter?.Date is { } date ? TimeSpan.FromSeconds(Math.Max(1, (date - DateTimeOffset.UtcNow).TotalSeconds)) : null);
    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string Normalize(string? value) => string.Concat((value ?? "").Normalize().ToLowerInvariant().Where(char.IsLetterOrDigit));
    [GeneratedRegex(@"\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]")]
    private static partial Regex TimestampRegex();
    [GeneratedRegex(@"\[offset:([+-]?\d+)\]", RegexOptions.IgnoreCase)]
    private static partial Regex OffsetRegex();
}
