# MVP Verification

Verified on Windows 11 on August 12, 2026.

## Automated

- Complete solution builds in Debug and Release with zero warnings and errors.
- 17 TestTonePlayer tests cover finite bounded PCM, sine frequency, white-noise
  variance, burst timing, stereo routing, transitions, and controller state.
- 16 audio-engine tests cover normalized DSP features, chroma, stereo behavior,
  typed WebSocket delivery, reconnect, health, clean stop, and protected static
  content delivery.
- 2 visualizer tests cover bounded `VisualState` output and user-owned pitch-color
  selection.
- The Vite production build completes successfully with zero npm vulnerabilities.

## Live audio path

- A 440 Hz TestTonePlayer process produced 143,520 captured frames over 2.99
  seconds with RMS 0.1055, peak 0.15, and estimated frequency about 435.8 Hz.
- While an unrelated 1000 Hz TestTonePlayer played, the target capture remained
  about 435.5 Hz.
- When only the target was stopped, its capture became all zeroes while the
  unrelated process continued playing. This verifies process isolation.
- The live DSP frame reported RMS 0.1061, dominant pitch A, confidence 0.959,
  and approximately 0.19 ms capture-to-DSP processing.
- A local WebSocket client received protocol version 1 frames end to end.

## Visual and desktop

- Desktop canvas checked at 1440x900 and narrow canvas at 390x844.
- WebGL rendered a nonblank evolving scene without framework or browser errors.
- No horizontal overflow or control overlap was observed at either viewport.
- All 12 pitch colors and 12 response sliders were available on desktop and
  narrow layouts; the narrow panel scrolls vertically.
- Changing A from its default to green immediately changed a live 440 Hz scene
  and persisted to local storage; Reset removed the saved override.
- Diagnostics measured about 30 AudioFrame messages per second and exposed the
  expected A chroma values.
- The Release WPF/WebView2 app served its embedded bundle, found seven running
  Spotify processes, connected its WebView, and published frames at 30 Hz.
- Normal window close stopped the localhost server and left no WebView2 child
  process from the app.

## Still manual

- Spotify was running but paused during the final native-app screenshot, so the
  auto-selected Spotify stream was silent. Play Spotify and confirm the debug
  values and painting react to a real song.
- For the final real-world isolation check, play Spotify and an unrelated browser
  video together and confirm only Spotify changes the debug values.
- Long-duration playback, sleep/resume, output-device changes, and a Spotify
  update/restart should receive an extended soak test before a signed release.
- Spotify metadata, Last.fm, lyrics, OpenAI, SQLite, and song calibration are not
  part of this audio-first MVP and have not been claimed as implemented.

## Capture recovery foundation — October 7, 2026

This entry records the isolated `codex/hosted-synesthesia` implementation, not a
hosted deployment or approval of the new renderer. Earlier results above are
historical and are not substituted for these checks.

### Current automated evidence

Changed files (in addition to the approved design/plan documents):

- `AGENTS.md`, `README.md`, and this verification record.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/IAudioCaptureSession.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessCaptureMonitor.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/CaptureSessionLifecycle.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessLoopbackCapture.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessTargetLocator.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/AudioEngineRuntime.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/SpotifySynesthesia.AudioEngine.csproj`.
- `audio-engine/host/SpotifySynesthesia.AudioEngine.Host/Program.cs`.
- `desktop/SpotifySynesthesia.Desktop/SpotifyCaptureMonitor.cs`.
- `desktop/SpotifySynesthesia.Desktop/MainWindow.xaml.cs`.
- `tests/SpotifySynesthesia.AudioEngine.Tests/ProcessCaptureMonitorTests.cs`.
- `tests/SpotifySynesthesia.AudioEngine.Tests/CaptureSessionLifecycleTests.cs`.

- `./Build.ps1 -Configuration Debug`: frontend and every solution project built;
  exit 0, zero .NET warnings and errors.
- `./Build.ps1 -Configuration Release`: same result, exit 0.
- `dotnet test SpotifySynesthesia.sln -c Release --no-build --no-restore`:
  audio-engine 155 passed; TestTonePlayer 17 passed; zero failures/skips, exit 0.
- `npm --prefix visualizer test`: 15 passed across four files, exit 0.
- Twenty-one new behavioral cases cover capture recovery/cancellation/process
  exit and startup/stop resource-lifetime policy. Each batch was observed failing
  for missing behavior before its implementation; the final full suite passed.
- `git diff --check`: exit 0. Source/test patches were authored by authenticated
  Claude Code, with its first-pass self-review; Codex applied them, ran commands,
  and performed an independent capture-boundary review.
- Baseline dependency audit still has three pre-existing findings: high
  `source-map-js` below 1.2.2 and moderate Vitest / `@vitest/mocker` below 4.1.11.
  These were not silently upgraded with the capture patch and remain a hosting
  security checkpoint. The older zero-vulnerability result is not current.

### Current hardware observation

A three-second ProcessCaptureProbe run against the oldest currently running
Spotify process (PID 25316 at test time) completed in 3.042 seconds, exiting 0.
It transitioned Activating → Capturing → Stopping → Stopped, received 300 packets
and 144,000 stereo frames at 48 kHz, and produced 90 normalized analysis frames.
All captured samples were silent (RMS 0; HasSignal false). The `any` expectation
only establishes activation, processing, and clean stop for that silent stream.
It does not establish that a playing song was captured or isolated.

### Still unverified for this implementation

- Non-silent Spotify song response and actual Spotify-versus-browser isolation.
- Output-device switch and sleep/resume recovery on real Windows audio hardware.
- Spotify exit/restart attachment and the diagnostic Host's fixed-PID real-target
  exit/shutdown behavior (unit tests cover control flow, not actual audio).
- Desktop terminal-fault status visibility and normal-close server/WebView2
  cleanup in the updated application.
- Hosted HTTPS companion pairing, cloud integrations, profile migration, and
  bronze-wave/rain/glass visual timing and synesthetic fit: not implemented yet.

The original checkout, user pitch profile, credential stores, and unrelated
`outputs/` files were not modified. No commits, pushes, or deployments were made.

Final source review identified WebView2 thread-affinity during shutdown; Claude's
correction disposes the visual control on its owner thread before asynchronous
backend cleanup. Both complete builds and all 187 tests were rerun afterward
and passed. This source/build evidence does not replace the desktop-close check.

One minor, deferred API limitation remains: a custom subscriber that throws from
the capture's `StateChanged` notification after worker creation can disrupt
startup cleanup. The production runtime, desktop, and Host do not subscribe to
that notification. General subscriber exception isolation was not added to this
milestone; it should be covered before extending that public notification API.

## Playing-song capture check — October 8, 2026

After the user confirmed a song was playing in Spotify desktop, the Release
ProcessCaptureProbe ran against Spotify PID 25316 for five seconds with
`--expect signal`. It exited 0 and reported non-silent capture:

- 499 packets, 239,520 audio frames at 48 kHz stereo (4.99 seconds of audio).
- 238,016 non-silent frames; non-silent ratio approximately 99.37%.
- RMS 0.08082; peak 0.26623; no reported discontinuities.
- 149 normalized analysis frames, with nonzero bass/mid/treble energy,
  pitch/chroma, attack, and stereo features.
- Lifecycle: Activating → Capturing → Stopping → Stopped; wall time 5.045 seconds.

This verifies non-silent Spotify capture and real DSP output for this check.
It does not verify competing-app isolation, renderer timing/appearance, device
switches, sleep/resume, Spotify restart, or desktop shutdown. No playback changes,
API credentials, cloud requests, or raw-audio uploads were involved in the probe.

## Spotify-versus-browser isolation check — October 8, 2026

The user confirmed browser audio was playing while Spotify was paused. The same
Release ProcessCaptureProbe targeted Spotify PID 25316 for five seconds with
`--expect silence`. It exited 0 and reported:

- 499 packets, 239,520 stereo audio frames at 48 kHz (4.99 seconds of audio).
- Zero non-silent frames; RMS 0; peak 0; HasSignal false.
- 149 normalized analysis frames; no reported discontinuities.
- Lifecycle: Activating → Capturing → Stopping → Stopped; wall time 5.018 seconds.

Together with the earlier playing-song check, this establishes non-silent
Spotify capture and exclusion of the concurrently playing browser audio for
this tested configuration. Browser playback was confirmed by the user, not
independently measured by the probe. It does not establish universal isolation,
audible output, visual synchronization/appearance, device switching, sleep/resume,
Spotify restart, or desktop-close behavior. Those acceptance checks remain open.

## Pairing/session foundation — October 8, 2026

This is foundation Task 2 in the same isolated worktree, not a deployment or a
claim that socket authentication is enforced. Claude authored the source/tests
and first-pass self-review; Codex applied patches and ran the checks below.

Changed files:

- `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/BrowserOriginPolicy.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/CompanionSessionManager.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/CompanionConnectionProtocol.cs`.
- `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/AudioFrameWebSocketServerOptions.cs`.
- `tests/SpotifySynesthesia.AudioEngine.Tests/CompanionSessionManagerTests.cs`.
- `tests/SpotifySynesthesia.AudioEngine.Tests/CompanionServerOptionsTests.cs`.
- `docs/companion-connection-protocol.md` and this record.

Observed test-first sequence: the session/policy batch compiled cleanly and
failed all 30 cases on missing behavior; the implementation passed all 30.
The separate options batch compiled cleanly and failed seven of eight cases
on absent configuration behavior; its implementation passed all eight.
No existing test was weakened to achieve these results.

- Complete Debug and Release `Build.ps1`: exit 0; frontend and all solution
  projects built, zero .NET warnings/errors.
- Full Release solution tests: audio-engine 193 passed; TestTonePlayer 17 passed;
  zero failures or skips, exit 0.
- Full frontend suite: 15 passed across four files, exit 0. Total: 225 passed.

The manager uses bounded origin parsing, an immutable exact allowlist,
cryptographic random one-time challenges and credentials, SHA-256 hashes of
their exact text, and fixed-time hash comparison. Credentials are tied to a
canonical allowed origin and expire after a 30-minute lease or eight-hour
absolute session lifetime. Failed pairing attempts and live sessions are
bounded. Record text formatting redacts secrets.

The live server still does not enforce the new authentication protocol. Both
stream gates, the bounded first-message exchange, revocation/expiry socket
closure, browser pairing, and trusted WebView bootstrap belong to Task 3 and
remain unimplemented/unverified. Current browser HTTPS-to-loopback permissions
need real accept/deny checks; native WebSocket tests are not substitutes.
Capture/DSP, user profiles, provider credentials, and the original checkout
were not changed by this security batch. No commits, pushes, or deployments.

## Enforced companion connections and UI composition — October 8, 2026

This Task 3 source/automated checkpoint supersedes the preceding Task 2 note
that live authentication was not yet enforced. Both streams and the pairing
route now enforce the documented connection protocol. It is not a claim of
Vercel deployment, real-browser compatibility, or desktop end-to-end acceptance.

Changed-file groups for this checkpoint:

- Backend: `Server/AudioFrameWebSocketServer.cs`, its options and session
  manager, and the diagnostic Host's `Program.cs`. Exact-origin authorization,
  bounded initial exchanges, authenticated payload/command gates, renewal,
  disconnect, socket capacity, expiry, and shutdown are enforced.
- Desktop: `MainWindow.xaml`, `MainWindow.xaml.cs`, and new
  `CompanionSettings.cs`. Pairing-code controls, revocation, a validated optional
  public hosted origin, trusted WebView bootstrap, and navigation restrictions
  are composed without starting an OS service or storing provider keys in HTML.
- Browser: `visualizer/src/connection/CompanionProtocol.ts`,
  `CompanionClient.ts`, `CompanionBootstrap.ts`, `CompanionPanel.ts`, both stream
  clients, `main.ts`, `index.html`, and `styles.css`. Credentials stay in memory;
  authentication precedes data; retries and control exchanges are bounded;
  revocation resets both streams. Unrestricted socket query overrides were
  removed. The paired/pairing UI does not issue duplicate pairing requests.
- Tests: expanded session/server cases; new `CompanionSettingsTests.cs`,
  `CompanionDisconnectRaceTests.cs`, `StreamClientLifetimeTests.cs`, and
  `CompanionServerLifecycleTests.cs`; three connection test files under
  `visualizer/src/connection/`. The existing test project links the neutral
  production settings helper without launching WPF. TestTonePlayer remains
  independent.
- Documentation and dev tooling: connection contract, companion plan, README,
  this evidence record, and the pinned DOM-test development dependency in
  `visualizer/package.json`/lockfile. No runtime UI framework was added.

Claude authored the major source/test patches and first-pass self-review.
Codex applied them, observed failing tests before behavior changes, ran checks,
and obtained independent source reviews. Important review findings were fixed:

- A disconnect racing renewal now accepts one prior token for same-origin
  revocation only, for less than 10 seconds; it cannot authenticate or renew.
- A stalled stream send has a one-second cancellation deadline and a bounded
  transport-abort path; cooperative authentication closure keeps one writer.
- A new desktop bootstrap resets the old family/streams before adopting its
  replacement credential. Ordinary renewal keeps its existing session family.

Observed test-first evidence includes the initial server batch (16 failures,
11 passes before implementation; all 27 afterward), browser batch (29 failures,
one pass before implementation; all 30 afterward), desktop helper batch
(44 failures, 81 passes before implementation; all 125 afterward), and the
security correction batch (nine failures, five passes before implementation;
all 14 afterward). The security batch includes a real local-route race test
and tests against the production stream client with controlled transports.

After Claude Pro reported its session limit, Codex authored only two narrow
review/test-first corrections: the repeated-bootstrap regression (one failure,
30 passes before the one-line controller change) and guards for invalid or
duplicate dialog submissions (three failures, two passes before the UI change).
These are explicitly Codex-authored, not attributed to Claude. No API billing,
account/model switch, automatic resume, or larger phase ownership switch was
made. Claude's reported reset was 6:40 a.m. America/New_York on October 8.

Final verification on the corrected source:

- Complete Debug and Release `Build.ps1`: exit 0; frontend and every solution
  project built, zero .NET warnings/errors.
- Full Release `dotnet test SpotifySynesthesia.sln -c Release --no-build
  --no-restore`: exit 0; audio-engine 328 passed and TestTonePlayer 17 passed;
  zero failures or skips. Audio-engine duration was nine seconds.
- Full frontend suite: 62 passed across seven files, zero failures, exit 0.
  Combined final test count: 407 passed.
- Three additional real-socket lifecycle cases passed: capacity at 32 admitted
  sockets with slot release after abort, bounded pending-auth shutdown/restart
  with old credentials/challenge rejected, and idle expiry on both streams.
- Invalid diagnostic Host origin configuration returned native exit code 2
  before capture startup. Independent source re-review found no remaining
  Critical/Important defect in the checked connection/composition boundary.

The three pre-existing dependency audit findings remain: high severity for
`source-map-js <1.2.2`, and moderate findings for Vitest / its mocker below
4.1.11. Dependency remediation is still required before public hosting; no
forced audit upgrade was bundled into these capture/connection changes.

Manual acceptance is explicitly open. The user requested **keeping the Windows
app closed**, and it was not opened. Real WebView pairing/reload/close, clipboard
interaction, Chrome/Edge HTTPS-to-loopback permission acceptance and denial,
offline bundled rendering, device switching, sleep/resume, Spotify restart,
and visual timing/appearance are unverified. .NET sockets, fake WebSockets,
and DOM tests do not establish those real-world behaviors. The separate live
Spotify capture/isolation results above remain valid for their tested setup.

Personal profile backup/export/import, centrally hosted services/API keys,
Vercel deployment, and bronze-wave/rain/glass spatial effects are not implemented
by this checkpoint. Personal pitch colors and `profiles/synesthesia.json` were
preserved. Changes remain uncommitted in the isolated
`codex/hosted-synesthesia` worktree; the original checkout, credential stores,
and unrelated outputs remain untouched. No pushes or deployments were made.

## Profile preservation source checkpoint — October 8, 2026

This subsequent Task 4 checkpoint supersedes the preceding note that profile
backup/export/import was not implemented. The user authorized Codex to take over
temporarily while Claude Pro is capped. Codex authored the profile changes and
test-first corrections; an independent read-only reviewer inspected preservation
and integration boundaries. No private profile export was inspected or sent to
Claude, and the personal bundled profile is unchanged.

Changed source: `SynesthesiaProfile.ts`, new `ProfileStore.ts` and
`ProfileTransfer.ts`, calibration UI, `main.ts`, and a small wrapping rule in
`styles.css`. New synthetic profile/store/transfer/calibration fixtures and tests
exercise the real implementation. Migration guidance and the profiles README
document local-only transfer and the remaining public-template publishing gate.

Observed behavioral RED/GREEN: initial profile batch 51 failures/23 passes,
then all 74 passing; calibration batch 14 failures, then all passing. Review
identified repeated slider edits rotating away the only malformed backup.
Ten new retention/failure/reload cases failed before the correction. The store
now preserves one bounded damaged original separately, blocks unsafe replacement,
and retains an interrupted restore target. Two additional self-review regressions
for cloning before storage writes and exporting a validated stable snapshot also
failed before correction. Tests were not weakened.

Final corrected-source checks:

- Full frontend suite: 162 passed across ten files, zero failures; 425 ms tests.
- Strict TypeScript/Vite build and complete Debug/Release `Build.ps1`: exit 0;
  every affected project built, zero .NET warnings/errors.
- Fresh full Release solution tests: audio-engine 328 and TestTonePlayer 17
  passed, zero failures/skips, exit 0; combined **507 tests passed**.
- `git diff --check` and the unchanged-private-profile diff check both exited 0.

The Windows app stayed closed. Real file download/selection/confirmation,
cross-origin transfer and saved/default palette fidelity remain unverified;
DOM tests are not substitutes. Concurrent same-origin documents retain existing
last-writer behavior, not new synchronization guarantees. Damaged originals are
retained, not automatically repaired or discarded. See
[profile migration](profile-migration.md) for recovery and acceptance steps.

Prior capture/isolation evidence remains separate. Device/sleep/restart,
desktop shutdown/reload, actual Chrome/Edge loopback permissions, offline visual
fallback, audio timing, and visual accuracy remain open. Cloud services, actual
deployment, and the 3D scene are not established by this checkpoint. Changes
remain uncommitted in the managed worktree; no deployment, paid resource,
credential inspection, or raw-audio upload occurred.
