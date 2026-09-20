using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.LastFm;

// Read-only provider diagnostic. Never print request URLs, credentials, raw bodies,
// or exception messages. Requests are restricted to the official Last.fm endpoint.
try
{
    string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SpotifySynesthesia", "auth", "lastfm-api-key.dat");
    byte[] payload = ProtectedData.Unprotect(await File.ReadAllBytesAsync(path),
        Encoding.UTF8.GetBytes("SpotifySynesthesia.LastFmApiKey.v1"), DataProtectionScope.CurrentUser);
    string key;
    try { key = Encoding.UTF8.GetString(payload); }
    finally { CryptographicOperations.ZeroMemory(payload); }
    using HttpClient http = new(new HttpClientHandler { AllowAutoRedirect = false });
    http.Timeout = TimeSpan.FromSeconds(15);
    foreach ((string artist, string title) in new[]
    {
        ("Sasha Alex Sloan", "Older"), ("JENNIE", "Less than a Lover"), ("Radiohead", "Paranoid Android"),
    })
    {
        Console.WriteLine($"Song: {artist} / {title}");
        using JsonDocument info = await Fetch("track.getInfo", ("artist", artist), ("track", title));
        if (!info.RootElement.TryGetProperty("track", out JsonElement track)) { continue; }
        string? mbid = track.TryGetProperty("mbid", out JsonElement id) ? id.GetString() : null;
        using JsonDocument tags = await Fetch("track.getTopTags", ("artist", artist), ("track", title));
        if (!string.IsNullOrWhiteSpace(mbid))
        {
            using JsonDocument mbidTags = await Fetch("track.getTopTags", ("mbid", mbid));
        }
        using JsonDocument artistTags = await Fetch("artist.getTopTags", ("artist", artist));
        LastFmApiClient client = new(http);
        LastFmApiResult<LastFmTrackInfo> parsed = await client.GetTrackInfoAsync(key, artist, title, TimeSpan.FromSeconds(15));
        Console.WriteLine($"Parsed info: {parsed.Kind} / {parsed.ErrorCategory}");
        if (parsed.Value is { } matched)
        {
            var parsedTags = await client.GetTrackTopTagsAsync(key, matched, TimeSpan.FromSeconds(15));
            Console.WriteLine($"Parsed track tags: {parsedTags.Kind} / {parsedTags.ErrorCategory}; count={parsedTags.Value?.Count}");
        }
    }

    async Task<JsonDocument> Fetch(string method, params (string Name, string Value)[] values)
    {
        string query = string.Join("&", new[] { ("method", method), ("api_key", key), ("format", "json"), ("autocorrect", "1") }
            .Concat(values).Select(pair => $"{Uri.EscapeDataString(pair.Item1)}={Uri.EscapeDataString(pair.Item2)}"));
        using var response = await http.GetAsync(new UriBuilder("https://ws.audioscrobbler.com/2.0/") { Query = query }.Uri);
        using Stream stream = await response.Content.ReadAsStreamAsync();
        JsonDocument doc = await JsonDocument.ParseAsync(stream);
        Console.WriteLine($"{method} ({(values.Any(v => v.Name == "mbid") ? "mbid" : "names")}): HTTP {(int)response.StatusCode}");
        Describe(doc.RootElement, "root", 0);
        return doc;
    }

    static void Describe(JsonElement value, string path, int depth)
    {
        if (depth > 4) { return; }
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name == "error" && property.Value.TryGetInt32(out int code))
                    Console.WriteLine($"provider error={code.ToString(CultureInfo.InvariantCulture)}");
                if (property.Name is "track" or "toptags" or "tag" or "tags")
                {
                    Console.WriteLine($"{path}.{property.Name}: {property.Value.ValueKind}" +
                        (property.Value.ValueKind == JsonValueKind.Array ? $" count={property.Value.GetArrayLength()}" : ""));
                    Describe(property.Value, path + "." + property.Name, depth + 1);
                }
            }
        }
    }
}
catch (Exception exception)
{
    Console.Error.WriteLine($"Diagnostic failed ({exception.GetType().Name}); details suppressed to protect credentials.");
    Environment.ExitCode = 1;
}
