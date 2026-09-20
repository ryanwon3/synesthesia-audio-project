using SpotifySynesthesia.AudioEngine.Infrastructure;

namespace SpotifySynesthesia.AudioEngine.Spotify;

public static class SpotifyLocalPaths
{
    public static string SettingsPath => LocalAppPaths.SettingsPath;

    public static string AuthorizationPath => LocalAppPaths.SpotifyAuthorizationPath;

    public static string SongProfileDatabasePath => LocalAppPaths.SongProfileDatabasePath;
}
