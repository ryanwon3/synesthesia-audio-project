# Spotify Synesthesia Engineering Guide

## Product intent

Build a Windows 11 desktop application that externalizes the user's personal
music-to-color perception as a continuously evolving abstract environment. The
renderer must not become a conventional waveform, spectrum, equalizer, or music
analytics dashboard.

## Architecture boundaries

- `audio-engine` owns Windows process-loopback capture, real-time DSP, external
  service integrations, profile persistence, and the localhost WebSocket server.
- `desktop` owns the WPF/WebView2 shell and application lifecycle composition.
- `visualizer` owns the Vite, TypeScript, Three.js, WebGL, and calibration UI.
- `tools/TestTonePlayer` is a diagnostic audio source. It must stay independent
  from capture and production rendering code.
- `profiles` contains user-owned synesthesia configuration in a later milestone.
- `data` contains local caches and databases and is never committed.

The WPF desktop shell hosts the production Vite bundle through WebView2. Browser
rendering code remains independent from WPF and consumes only the documented
localhost protocol.

## Execution lanes

Keep the runtime split into three lanes:

1. Real-time: Spotify PCM -> DSP -> normalized AudioFrame -> WebSocket.
2. Background: Spotify metadata, Last.fm, lyrics, OpenAI, and SQLite.
3. Render: AudioFrame + contextual profiles + prior visual state -> Three.js.

External I/O, database access, logging, and allocations with unpredictable cost
must never run on the capture or DSP callback thread.

## Dependency rules

- The renderer consumes a normalized VisualState; it never consumes raw service
  responses or manipulates backend integrations.
- Spotify identity and Spotify process capture are separate subsystems.
- All external services are optional enrichment. Local audio must continue when
  they fail or the network is unavailable.
- Secrets stay in the backend's protected local store and never enter frontend
  bundles, logs, fixtures, diagnostics, or committed files. A Spotify client ID
  is non-secret configuration and is entered through the local setup dialog.
- Prefer strongly typed records and small interfaces at subsystem boundaries.
- Keep configuration out of hard-coded rendering and DSP logic.

## Synesthesia ownership

Pitch-class color mappings belong to the user. Personal pitch colors remain the
default and must be preserved. Chroma may select and blend those colors.
The user's requested, explicitly selected Mood palette mode may map pitches
across locally configured mood gradients without overwriting personal colors.
AI returns bounded mood/texture categories, never colors or renderer code.
Metadata and lyric semantics may influence brightness, warmth, softness,
contrast, persistence, and similar qualities in either mode.

Personal song overrides are stored separately from generated analysis and take
priority without destroying the original result.

## Verification discipline

For every meaningful change:

1. Build every affected project.
2. Run focused tests and the full relevant test suite.
3. Perform the manual hardware, audio, or visual check that automation cannot.
4. Report changed files, tests run, manual checks, and unverified behavior.

Do not claim Spotify isolation, audible output, timing, or visual quality without
performing the corresponding real-world check. Do not advance to a later roadmap
phase while its prerequisite is broken.
