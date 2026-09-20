# OpenAI API-key setup

Open the hidden diagnostics panel with `D` or the bug button. In `AI lyrics
analysis`, choose `Configure`, paste an OpenAI API key, and choose `Save`.

The native desktop dialog sends the key directly to the backend. The browser UI
receives only an `openAiConfigured` boolean. The key is protected with Windows
DPAPI for the current Windows account and stored at:

`%LOCALAPPDATA%\SpotifySynesthesia\auth\openai-api-key.dat`

The existing key is never displayed. Choose `Configure` and then `Remove` to
delete it. The key is not stored in the visualizer bundle, song-profile database,
protocol messages, diagnostics, fixtures, or logs.

The same dialog has an automatic-analysis checkbox and model selector. Leave
the key field blank to keep the current key while changing these preferences.
Automatic analysis defaults on and begins only after a song has been playing
continuously for ten seconds and matched lyrics are available. It sends the
matched lyrics and recognized song context to OpenAI and uses API credits.

The default model is `gpt-5-mini`. Results are cached locally in SQLite and
reused on replay. Diagnostics shows the lyric source, whole-song versus timed
sections, cache state and sanitized failure status. **Reanalyze this song** asks
for confirmation before making another paid request. Missing/instrumental lyrics,
API errors, and disabled automation never stop the local audio visualization.

Settings are stored separately at `%LOCALAPPDATA%\SpotifySynesthesia\lyrics-settings.json`.
The lyrics/analysis cache is in the `lyrics_visual_cache` table of the existing
song database; it contains neither API credentials nor personal color overrides.
See `song-aware-visuals.md` for matching, bounds, privacy, and fallback behavior.
