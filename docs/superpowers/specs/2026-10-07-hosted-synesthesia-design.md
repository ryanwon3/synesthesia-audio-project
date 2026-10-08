# Hosted Synesthesia and Spatial Visuals — Proposed Design

Date: 2026-10-07

Status: design approved by the user on 2026-10-07. The user selected a hosted
app with a Windows companion and approved the bronze-wave/rain/glass direction.
Implementation plans are the next review checkpoint. No product code, cloud
resources, or production deployment were changed while preparing the design.

## Intended outcome

Make the application easy to use without entering service API keys, and make
the musical causes of the visual effects more recognizable while preserving
the user's personal music-to-color perception. The result remains an evolving
abstract environment, not a waveform, equalizer, spectrum, or analytics screen.

The user requested three changes:

1. A centrally configured service backend and a Vercel-hosted application.
2. Clearer distinctions between musical contributions and their visual effects.
3. Potentially true 3D using Three.js, guided by the user's synesthesia.

The user explicitly selected a Windows companion for Spotify desktop capture.
Claude Code is the primary implementer. Codex owns planning, independent code
review, verification, and the final report.

## Personal visual reference

For **“back to friends” by sombr**, the user described:

- Guitar: subtle bronze waves; the main guitar is warm, horizontal waves.
- Bass: raindrops against a black background.
- Main melody: translucent glass tiles falling.

This is the first calibration reference, not a universal mapping for every song.
The initial proposal is a dark spatial environment with distinct wave, rain,
and glass layers. Increasing clarity should preserve the subtle warmth of the
bronze guitar layer rather than simply making every effect bright or intense.

## What exists today

The Vite/TypeScript frontend already depends on Three.js. Its `EvolvingPainting`
renderer uses an orthographic camera and fullscreen shader planes with feedback
textures. It is a 2D procedural painting, not a scene of objects with perspective,
occlusion, and meaningful depth.

All three audio layers use substantially shared noise fields and compositing.
Song context can give a contextual effect more weight than a band's anchor.
These are plausible contributors to the reported subtle, blended appearance;
they have been inspected in source, not verified by watching live playback.

The analyzer provides bass/mid/treble energy, band attacks and chroma, global
onset/flux/centroid, and stereo balance/width. It does **not** separate guitar,
vocals, bass instruments, or lead melody into independent stems.

Existing capture recovery work is still an unimplemented plan. The local
`/audio` WebSocket currently lacks the origin restriction applied to
`/song-context`. These are prerequisites for a reliable, securely hosted flow.

## Architecture

Keep three execution lanes and the current subsystem boundaries wherever they
still fit:

1. **Local real-time lane:** Spotify PCM → Windows capture → DSP → normalized
   `AudioFrame` → authenticated loopback connection → renderer on the same PC.
2. **Cloud background lane:** authenticated song-context requests → Vercel
   functions → optional provider integrations and durable hosted storage.
3. **Render lane:** `AudioFrame` + personal configuration + normalized contextual
   traits + prior state → normalized `VisualState` → Three.js.

Raw audio is not uploaded to Vercel. Network latency and cloud failures must not
control live attacks, geometry motion, or pitch-color selection.

### Cloud responsibilities

- Serve the existing Vite frontend; do not rewrite it into another UI framework
  solely for hosting.
- Add a small TypeScript service layer exposed through Vercel functions.
- Configure shared OpenAI/Last.fm credentials and any necessary Spotify
  application credentials once, as server-only project Secrets. End users do
  not enter provider API keys or a Spotify client ID.
- Provide Spotify OAuth, per-user server-side sessions and token isolation,
  bounded song-context/enrichment routes, caching, rate limits, and quotas.
- Use durable hosted storage for cloud sessions, encrypted provider tokens,
  generated analysis, and usage accounting. Do not treat a function's local
  SQLite file or process memory as durable/shared storage.
- Return validated mood/texture categories and normalized context, never
  provider secrets, renderer code, or AI-selected personal colors.

Choose and connect the hosted storage resource during implementation planning,
after checking the Vercel Marketplace and the intended account/project. Start
with a small pilot; do not provision a paid tier or assume public Spotify access
without resolving those deployment choices.

### Windows responsibilities

- Retain Windows process-loopback capture and DSP in `audio-engine`.
- Reuse the existing host and lifecycle code for the first companion. Verify
  process-specific capture; do not substitute broader system-audio capture.
- Expose capture status, retry/recovery, and explicit pairing controls.
- Retain the WPF/WebView2 bundled renderer as the offline path. A newly opened
  Vercel page is not promised to load without a network connection.
- Local persistence may cache the user's preferences and previously received
  context; the companion does not need shared service API keys.

`tools/TestTonePlayer` remains independent diagnostic code. External I/O,
database access, and unbounded work remain outside capture/DSP callbacks.

## Pairing and account security

The hosted page must not simply connect to an unauthenticated localhost socket.

- Bind the companion only to loopback, not all interfaces.
- Allow exact configured production and local development origins. Do not allow
  every `*.vercel.app` origin or every website. Preview access must be explicitly
  configured and separated from production.
- Require explicit local pairing using a one-time, expiring random credential.
  Issue a short-lived connection credential scoped to that browser origin.
- Authenticate a bounded initial WebSocket message before publishing any frame
  or accepting a control command. Do not put credentials in socket URLs or logs.
- Rate-limit pairing attempts, revoke sessions on companion restart or user
  disconnect, and distinguish trusted native clients from browser clients.
- Treat browser local-network permission and mixed-content behavior as a real
  compatibility check, not as a solved issue. The first supported browser target
  is Windows Chrome/Edge; failure must produce useful instructions and retain
  the bundled desktop fallback. Do not ask users to disable browser security.

Cloud login and local pairing have separate purposes. Spotify authorization
permits account-specific metadata access; it does not provide local PCM audio.
Use OAuth state/PKCE validation, secure HttpOnly session cookies, appropriate
CSRF protections, encrypted per-user refresh-token storage, and logout/revocation.
Never share one user's Spotify token with other users.

Anonymous/local audio rendering may continue without optional enrichment.
Chargeable cloud enrichment requires authorization, per-user and global limits,
bounded provider requests, caching, and an owner-controlled usage ceiling.

## Visual design and causality

Prefer a lightweight **true 3D abstract scene** for the new mode, while keeping
the existing painting as a fallback and comparison option. Use a perspective
camera, actual geometry at different depths, and restrained camera motion.
Avoid a navigable game world, mandatory VR, heavy volumetric ray marching, or
large postprocessing chains in the first version.

The first personal theme has three visually distinct families:

| Visual family | Intended experience | First-version musical driver |
| --- | --- | --- |
| Warm bronze waves | Horizontal, continuous organic surfaces in a deeper layer; guitar-like warmth | Sustained mid-range energy and harmonic/pitch content |
| Rain impacts | Droplets or expanding spatial impact rings visible against black | Low-frequency attacks; bass energy controls their weight and extent |
| Falling glass tiles | Translucent thin objects with visible edges, depth, and occlusion | Confidence-gated pitch/chroma changes and harmonic activity; melodic approximation |

Guitar and melody often occupy the same frequencies. These drivers are
**feature-driven approximations, not isolated instrument detection**. The UI
must describe that honestly. Pitch-class chroma alone does not identify the
lead melody. Do not silently assign the melody to treble just to give every
effect a different band.

Use stable visual roles; metadata may adjust warmth, softness, persistence,
contrast, or texture slowly, but must not arbitrarily exchange rain, waves, and
glass between musical roles. Stereo cues affect placement/spread, and energy
affects amplitude/density. Attack timing remains driven by current audio.

Allow each family to be previewed/soloed in calibration so the user can hear and
see what drives it. Normal playback remains immersive, with controls hidden.
Make strengths, fall speed, wave scale, rain persistence, and depth adjustable.
Exact instrument isolation is outside this first implementation; if necessary,
it requires a separate design and measured latency/accuracy evaluation.

Do not blindly normalize FFT bands by bin count or replace bass/treble pitch
colors based on the consultation alone. Use controlled tone, attack, and mix
tests to establish the actual response before changing DSP calibration. Reuse
the existing protocol where possible; add only features justified by evidence.

## Personal configuration and migration

- Preserve all existing pitch-color values and response settings. Personal
  pitch colors remain the default. Mood palettes remain explicitly opt-in.
- Store the user's bronze-wave choice as an explicit personal song/theme
  override, separate from generated analysis; it must not overwrite the global
  pitch palette or silently apply to unrelated songs.
- Keep geometry/material/theme selection user-owned. AI may supply bounded
  texture and mood traits, not exact colors or arbitrary scene instructions.
- Add safe export/import and versioned migration before moving preferences
  between the desktop origin and the hosted origin. A website cannot read the
  old origin's local storage automatically.
- Back up the previous profile before replacement/reset; validate imports and
  migrations. Do not silently discard malformed settings or reset colors.
- Do not accidentally publish a private user's saved profile as everybody's
  bundled default. Cloud profile synchronization is deferred until needed and
  must be explicitly opted into.

## Alternatives considered

1. **Recommended: hybrid hosting plus a lightweight 3D scene.** Preserves local
   process capture and offline capability while enabling central service keys
   and the user's spatial glass/rain/wave reference. Requires a companion
   install and browser pairing.
2. **Hybrid hosting with a stronger 2D painting only.** Smaller renderer change
   and useful fallback, but cannot provide the same geometric depth and falling
   glass-object perception. Retained as a comparison, not the proposed main mode.
3. **Browser-only capture.** Removes the companion, but changes audio-source
   selection/isolation and requires browser capture prompts and DSP work. The
   user chose the companion, so this is not the implementation direction.

## Delivery sequence and verification

Split implementation into reviewable milestones rather than one large rewrite:

1. **Capture and profile safety:** implement/review recovery, secure loopback
   origin/pairing behavior, profile backup/export/import, and versioned contracts.
   Verify actual Spotify capture, isolation, exit/restart, and capture fault
   recovery before relying on that path for hosted use.
2. **Hosted background services and connection:** establish the Vercel project,
   server-only credentials, user auth, durable cache/token storage, quotas, and
   hosted companion connection. Test origin rejection, expired/replayed pairing,
   OAuth state failure, user isolation, missing keys, provider failure, and cloud
   downtime. Inspect built browser assets for credential exposure.
3. **Spatial theme:** add a renderer boundary and 3D implementation, stable
   family mappings, personal song override, calibration previews, and safe
   fallback. Test controlled bass-only, mid-only, treble-only, silence, attack,
   stereo, invalid-value, and stale-frame inputs. Feature-driven glass behavior
   must not be falsely labeled an isolated melody.
4. **Personal playback acceptance and release:** compare the proposed theme
   against “back to friends,” adjust it with the user, and verify performance,
   resizing, pause/resume, reduced motion, and resource cleanup on real hardware.
   Deploy a tested pilot; distinguish a preview deployment from a production
   release and a screenshot from verified audio behavior.

Build every affected project and run focused plus full relevant tests at each
milestone. Report changed files, tests, manual checks, and unverified behavior.
Do not claim timing, Spotify isolation, audible output, synesthetic accuracy, or
visual quality on the basis of unit tests or source inspection alone.

## Guide changes required by the approved direction

The current `AGENTS.md` assumes a desktop-only product and locally entered
credentials. During implementation, amend those statements deliberately to
describe `cloud` ownership of shared services and `audio-engine` ownership of
local capture/DSP. Preserve the realtime/background/render separation, optional
enrichment, personal palette ownership, and verification discipline. This draft
does not silently override the existing file.

## External constraints verified during design

- [Vercel supports the existing Vite frontend and standalone API functions](https://vercel.com/docs/frameworks/frontend/vite).
- [Vercel project Secrets are server configuration, not frontend credentials](https://vercel.com/docs/environment-variables).
- [Spotify development mode currently limits authenticated users to five and requires the app owner to have Premium](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- [Chrome documents restrictions and evolving coverage for websites reaching local services](https://developer.chrome.com/blog/local-network-access).

The connected Vercel account has a team named `compass`; a read-only search found
no project with `synesthesia` in its name. No cloud project was created. Current
browser compatibility, live audio behavior, and the rendered theme remain
unverified.
