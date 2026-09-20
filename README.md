# Spotify Synesthesia

A Windows 11 desktop application that captures Spotify's process audio and turns
it into a continuous, abstract Three.js painting guided by a personal 12-note
color profile. The usable local-audio MVP is complete: it runs without accounts,
API keys, or internet services. Spotify Web API identity is an optional parallel
service and the visualization keeps running when it is disconnected.

## Run the app

1. Open the Spotify desktop app.
2. Play music in Spotify.
3. Double-click `Start-SpotifySynesthesia.cmd`.

The desktop shell is single-instance. Launching it again restores and focuses
the existing window instead of starting a second local server on port 8765.

The desktop app finds the oldest Spotify process, captures that process tree,
and reconnects after Spotify restarts. Other applications are excluded by the
Windows process-loopback API. Open the sliders button to edit pitch colors and
response settings; changes apply immediately and persist locally. Press `D` or
use the bug button to show diagnostics.

To add current-song identity, use the link button and enter the client ID from a
personal Spotify developer app. See `docs/spotify-metadata.md` for the exact app,
redirect, authorization, and playback verification steps. No client secret is
used or accepted.

Last.fm track and artist tags can be enabled from the hidden diagnostics panel.
Choose `Configure` in its Last.fm section and enter a Last.fm API key in the
native desktop dialog. Recognized track tags shape the visual mood; artist tags
provide a weaker fallback. Unrecognized personal tags are ignored.

An OpenAI API key can be added from the `AI lyrics analysis` section in the same
diagnostics panel. Automatic analysis retrieves conservatively matched lyrics
from LRCLIB after 10 seconds of continuous playback and sends them to OpenAI.
This uses API credits. Cached results are reused, and timed lyrics can change
the visual mood by section. The native settings dialog controls automation and
model choice. See `docs/openai-settings.md` for storage and removal details.

The calibration panel now has independent bass/mid/treble intensity controls and
two color modes. **Personal pitch colors** remains the default and preserves your
existing associations. Opt into **Mood palette · pitch selects shade** for local
mood gradients (for example blue/purple for sad music), with a distinct shade
for each pitch in each layer. AI never supplies colors or shader code.
See `docs/song-aware-visuals.md` for behavior and verification details.

## Prerequisites

- Windows 11 with the WebView2 Runtime (included with normal Windows 11 installs)
- .NET 10 SDK, pinned by `global.json`, when building from source
- Node.js 24 LTS when rebuilding the visualizer

This workspace also accepts the verified portable Node runtime under `.tools`.
No credentials are required for local audio visualization. Spotify identity
requires a personal Spotify developer app and an eligible, allowlisted account.

From a fresh clone, run `./Build.ps1 -Configuration Release` in PowerShell; the
script installs the locked frontend packages with `npm ci`, restores the .NET
packages, and builds the visualizer and desktop solution. Then open Spotify,
start playback, and run `./Start-SpotifySynesthesia.cmd` (or
`./Start-SpotifySynesthesia.ps1`) to launch the application.

## How the APIs are called

The backend uses .NET `HttpClient` to authorize Spotify with OAuth Authorization
Code + PKCE, request the `user-read-currently-playing` scope, and deserialize the
current-track JSON response into typed C# records. It calls Last.fm over HTTPS
with `method`, `artist`, `track`, `api_key`, and `format=json` query parameters,
and reads LRCLIB JSON using the current track identity. For optional lyric
analysis, it posts the selected model, lyrics, mood instructions, and a strict
JSON Schema to the OpenAI Responses API with `store=false`; the response is
validated and converted into bounded mood, energy, texture, and timed-section
records rather than colors or executable rendering code. The normalized audio
and song-context records are serialized as JSON and delivered to the TypeScript
renderer over typed localhost WebSocket endpoints.

## Optional API credentials

The core audio visualizer works without any API account. For song identity,
create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
register `http://127.0.0.1:8765/spotify/callback`, copy only its client ID, and
enter that ID through the app's link button; this PKCE flow does not use a client
secret. For tag enrichment, obtain a key from the
[Last.fm API account page](https://www.last.fm/api/account/create) and enter it
under diagnostics (`D`) > Last.fm > Configure. For lyric analysis, create a key
on the [OpenAI API keys page](https://platform.openai.com/api-keys) and enter it
under diagnostics > AI lyrics analysis > Configure; OpenAI requests consume API
credits. Never commit credentials to `.env` or source files: the desktop app
stores the Last.fm and OpenAI keys locally with Windows DPAPI, and `.gitignore`
excludes local credential, database, and log files.

## Build and test

Build the visualizer and complete solution:

```powershell
.\Build.ps1 -Configuration Release
```

Run every automated suite:

```powershell
dotnet test SpotifySynesthesia.sln --configuration Release --no-build --no-restore
cd visualizer
npm test
```

Run the diagnostic tone source:

```powershell
dotnet run --project tools/TestTonePlayer/SpotifySynesthesia.TestTonePlayer.csproj
```

The tone player defaults to 15% and is capped at 50%.

## Architecture

- `desktop/SpotifySynesthesia.Desktop` is the WPF/WebView2 application shell. It
  composes the backend, serves the bundled frontend on loopback, and monitors
  Spotify restarts.
- `audio-engine/src/SpotifySynesthesia.AudioEngine` owns process-specific capture,
  real-time DSP, Spotify PKCE/current-playback services, Last.fm enrichment,
  SQLite SongProfiles, and the two independent localhost transports.
- `visualizer` owns typed WebSocket reconnection, the `VisualContextEngine`, the
  personal profile store, calibration UI, and the feedback-buffer WebGL painting.
- `tools/TestTonePlayer` emits controlled audio for capture and DSP verification.
- `tools/ProcessCaptureProbe` reports live capture statistics for a target PID.
- `profiles/synesthesia.json` contains the default user-controlled pitch mapping.
- `tests` covers signal generation, playback state, DSP, Spotify identity and
  authorization, SQLite persistence, transport, and static frontend delivery.

The real-time lane remains `Spotify PCM -> DSP -> AudioFrame -> /audio -> renderer`.
The independent context lane is `Spotify Web API -> CurrentTrack -> TrackChanged
-> SongProfile -> /song-context -> diagnostics`. Context work never enters the
capture callback or renderer mapping.

## Current status

Completed MVP phases:

1. Repository and engineering boundaries.
2. TestTonePlayer with five signals and channel routing.
3. Process-tree loopback capture and two-source isolation verification.
4. Automatic Spotify process discovery and restart monitoring.
5. RMS and FFT analysis.
6. Bands, centroid, flux, onset, chroma, balance, and width.
7. Typed localhost WebSocket with reconnect and stale-frame dropping.
8. Three.js frontend and hidden diagnostics.
9. Abstract shader scene with temporal accumulation and afterimages.
10. Personal SynesthesiaProfile and live persistent calibration.
11. Renderer-neutral VisualContextEngine.
12. WPF/WebView2 desktop packaging and clean shutdown.
13. Spotify PKCE, current-track identity, stable TrackChanged events, refreshable
    SQLite SongProfiles, and independent song context.
14. Last.fm track/artist tags, conservative matching, persistent caching, and
    normalized enrichment state.
15. Protected OpenAI API-key setup, LRCLIB retrieval, structured cached analysis,
    section timing, and re-analysis controls.
16. Independent audio bands, bass attack ripples, contextual effect families,
    opt-in mood-to-pitch palettes, and layer calibration.

The current renderer is intentionally audio-first and degrades to a quiet,
slowly evolving field when Spotify is silent or enrichment is unavailable.

## Remaining roadmap

1. A song-specific personal override editor (the normalized profile override
   contract already takes precedence without replacing generated analysis).
2. Broader lyric-provider coverage, licensing review, and multi-song listening tests.
3. Installer, signed packaging, longer soak tests, and appearance tuning.

These services are optional enrichment. The local Spotify audio path remains the
required fallback and must continue when every external service fails.

## Verification

See `docs/mvp-verification.md` for measured results and remaining manual checks.
The WebSocket contract is documented in `docs/audio-frame-protocol.md`.
Spotify setup and manual checks are in `docs/spotify-metadata.md`; the independent
metadata transport is documented in `docs/song-context-protocol.md`. Last.fm
setup, caching, and recovery are documented in `docs/lastfm-metadata.md`.

The AI-assisted implementation notes and the key prompts that shaped this
project are summarized in [`prompt_log.md`](prompt_log.md).
