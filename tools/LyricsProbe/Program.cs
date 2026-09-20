using SpotifySynesthesia.AudioEngine.Lyrics;
using SpotifySynesthesia.AudioEngine.OpenAi;
using SpotifySynesthesia.AudioEngine.Profiles;

// Explicit diagnostic: one public lyrics lookup; optional one bounded paid analysis.
// Never logs raw lyrics, service bodies, request URLs, credentials, or exception messages.
using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(120));
using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
    { Timeout = TimeSpan.FromSeconds(100), MaxResponseContentBufferSize = 300_000 };
try
{
    SongProfileIdentity identity = new("verification-only", null, null, "Paranoid Android",
        [new(null, "Radiohead")], new(null, "OK Computer", null, null, null), 383000, false);
    var lyrics = await new LrcLibLyricsProvider(http).GetAsync(identity, shutdown.Token);
    Console.WriteLine($"LRCLIB: matched={lyrics is not null}; timed={lyrics?.Timed}; lines={lyrics?.Lines.Count}; instrumental={lyrics?.Instrumental}");
    if (lyrics is null || !args.Contains("--analyze", StringComparer.Ordinal)) return;
    var key = await new DpapiOpenAiApiKeyStore().LoadAsync(shutdown.Token);
    if (key is null) { Console.WriteLine("OpenAI key is not configured."); return; }
    var visual = await new OpenAiLyricsAnalyzer(http).AnalyzeAsync(key, "gpt-5-mini", identity, lyrics, ["alternative rock"], shutdown.Token);
    Console.WriteLine($"OpenAI: valid analysis; mood={visual.WholeSong.Mood}; timed sections={visual.Sections.Count}");
}
catch (EnrichmentException error) { Console.WriteLine($"Diagnostic status: {error.Category}"); Environment.ExitCode = 1; }
catch (Exception error) when (error is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException or IOException or InvalidOperationException)
{ Console.WriteLine($"Diagnostic could not finish: {error.GetType().Name}"); Environment.ExitCode = 1; }
