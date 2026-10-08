# Spotify Synesthesia Engineering Guide

## Product intent

Build a Windows 11 desktop application that externalizes the user's personal
music-to-color perception as a continuously evolving abstract environment. The
renderer must not become a conventional waveform, spectrum, equalizer, or music
analytics dashboard.

## Architecture boundaries

- `audio-engine` owns Windows process-loopback capture, real-time DSP, local
  optional integrations and caches, profile persistence, and the localhost
  WebSocket server. It remains the offline Windows companion.
- `cloud` and root `api` own the approved hosted service lane: Spotify identity,
  optional background enrichment, server sessions, durable service caches, and
  centrally configured provider credentials. Raw captured audio is not uploaded.
- `desktop` owns the WPF/WebView2 shell and application lifecycle composition.
- `visualizer` owns the Vite, TypeScript, Three.js, WebGL, and calibration UI.
- `tools/TestTonePlayer` is a diagnostic audio source. It must stay independent
  from capture and production rendering code.
- `profiles` contains user-owned synesthesia configuration in a later milestone.
- `data` contains local caches and databases and is never committed.

The WPF desktop shell hosts the offline Vite bundle through WebView2. The hosted
version serves the same frontend on Vercel and pairs with the Windows companion
for local capture. Browser rendering code remains independent from WPF and
consumes only documented normalized audio/context and connection protocols.

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
- Shared provider secrets stay in the hosted backend's protected server-only
  configuration; existing optional desktop credentials remain in the protected
  local store. Neither enters frontend bundles, logs, fixtures, diagnostics, or
  committed files. A Spotify client ID is non-secret configuration. The hosted
  service is configured by its owner; end users sign in rather than enter keys.
- Companion credentials are short-lived, scoped to exact allowed origins, and
  kept in browser memory. Authenticate before sending any audio or song context.
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
