namespace SpotifySynesthesia.AudioEngine.Infrastructure;

public static class LocalAppPaths
{
    private static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SpotifySynesthesia");

    public static string SettingsPath => Path.Combine(Root, "settings.json");

    public static string SpotifyAuthorizationPath => Path.Combine(Root, "auth", "spotify-authorization.dat");

    public static string LastFmApiKeyPath => Path.Combine(Root, "auth", "lastfm-api-key.dat");

    public static string OpenAiApiKeyPath => Path.Combine(Root, "auth", "openai-api-key.dat");

    public static string SongProfileDatabasePath => Path.Combine(Root, "data", "song-profiles.db");
}
