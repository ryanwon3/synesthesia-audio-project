# Secure Companion and Profile Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local Spotify capture recoverable, pair the renderer securely, and preserve personal settings during hosting migration.

**Architecture:** Keep capture/DSP and the loopback server in audio-engine; desktop composes the companion and the offline bundle. A small in-memory session manager authenticates connections, while a browser profile store backs up and validates preferences without cloud synchronization.

**Tech Stack:** .NET 10/C#/xUnit, WPF/WebView2, TypeScript/Vitest, browser storage, existing localhost port 8765.

**Spec:** `docs/superpowers/specs/2026-10-07-hosted-synesthesia-design.md`; shared rollout constraints in `2026-10-07-hosted-synesthesia-rollout.md`.

## Global Constraints

- Raw audio is not uploaded to Vercel.
- Personal pitch colors remain the default. Mood palettes remain explicitly opt-in.
- External I/O, database access, and unbounded work remain outside capture/DSP callbacks.
- Do not ask users to disable browser security.
- Claude authors patches; Codex applies/reviews/tests them. No automatic commits; preserve unrelated files and credential stores.
- AudioFrame payload/version remains unchanged; document a separate connection-authentication protocol.
- No paid cloud services, provider SDKs, or cloud resources are needed for this plan.

October 8 ownership update: the user authorized temporary Codex implementation
while Claude Pro is capped, followed by a one-time 6:40 a.m. Eastern subscription
check/resume. Preserve at least 50% of the shared five-hour Codex allowance;
stop coding/review at 45% used for headroom. No automatic commits/deployments,
billing/account switches, or opening the Windows app are authorized.

## Review Focus

- Stop raised during capture startup or for a stale PID: covered by the existing capture plan's named monitor tests.
- Foreign/absent/null origins or a lookalike hostname: Task 2 rejects browser access before upgrade.
- Pairing replay, expiration, or a slow/oversized first message: Tasks 2–3 reject before publishing audio.
- Browser storage throwing during replacement/reset: Task 4 reports failure and leaves the prior profile recoverable.
- Companion restart or shutdown while connections are active: Task 3 revokes credentials and releases sockets/port.

---

## File boundaries

Capture changes and tests are already mapped in `2026-10-07-capture-recovery.md`.
New server security is split into `Server/BrowserOriginPolicy.cs`,
`Server/CompanionSessionManager.cs`, and `Server/CompanionConnectionProtocol.cs`
inside `audio-engine/src/SpotifySynesthesia.AudioEngine`.
Modify `Server/AudioFrameWebSocketServer.cs` and its options to enforce those
boundaries. Browser pairing belongs in `visualizer/src/connection/`; safe
profile persistence belongs in `visualizer/src/profiles/`.

Representative assertion contracts for the named tests below (fixtures remain
local to their test files):

```csharp
var policy = new BrowserOriginPolicy(["https://app.example"]);
Assert.True(policy.IsAllowed("https://app.example"));
Assert.False(policy.IsAllowed("https://app.example.evil.test"));
Assert.False(policy.IsAllowed(null));
var sessions = new CompanionSessionManager(policy);
var challenge = sessions.CreatePairingChallenge();
Assert.True(sessions.TryPair(challenge.Code, "https://app.example", out var credential));
Assert.False(sessions.TryPair(challenge.Code, "https://app.example", out _));
Assert.False(sessions.TryAuthenticate(credential!.Token, "https://elsewhere.example", out _));
sessions.RevokeAll();
Assert.False(sessions.TryAuthenticate(credential.Token, "https://app.example", out _));
```

```ts
const original = defaultSynesthesiaProfile();
expect(parseProfileImport(exportProfile(original))).toEqual({ok: true, profile: original});
const malformed = {...original, response: {...original.response, movement: NaN}};
expect(parseProfileImport(JSON.stringify(malformed)).ok).toBe(false);
```

### Task 1: Capture recovery and updated ownership guide

**Files:** All exact files in the capture-recovery leaf plan; modify `AGENTS.md`, `README.md`, and `docs/mvp-verification.md`. Include `desktop/SpotifySynesthesia.Desktop/MainWindow.xaml.cs` only for observing terminal capture failures and preserving cleanup during shutdown.

**Interfaces:** Consumes existing process capture. Produces the leaf plan's `IAudioCaptureSession`, `ProcessCaptureMonitor.RunAsync(bool, CancellationToken)`, and `ProcessTargetLocator.IsAlive(int)`; no DSP/protocol changes.

**Reviewed lifecycle correction:** Include `Capture/ProcessLoopbackCapture.cs`, a small internal `Capture/CaptureSessionLifecycle.cs`, `CaptureSessionLifecycleTests.cs`, and test assembly visibility in the audio-engine project. Start the audio client before creating the worker; guarantee resource cleanup even if audio stop throws. The helper must be used by production, preserve the first COM error, and expose no test-only methods. Do not introduce a broad NAudio abstraction or change DSP callbacks.

- [x] Amend only the guide statements affected by the approved design: add cloud service ownership and server-only centrally configured keys; retain local capture/DSP, optional enrichment, palette ownership, and verification rules.
- [x] Implement capture-plan Tasks 1–3 in their existing test-first order, requesting one Claude-authored patch batch at a time. Review each batch independently.
- [x] Add `StartFailureDoesNotRetryAfterCancellation`: inject a startup exception and canceled retry; assert no further start and no retained event subscription. Decide retryability from known capture failures, not a blanket catch that hides programming errors.
- [x] Run `dotnet test tests/SpotifySynesthesia.AudioEngine.Tests/SpotifySynesthesia.AudioEngine.Tests.csproj --filter FullyQualifiedName~ProcessCaptureMonitorTests`; require all monitor cases passing.
- [x] Build audio-engine, Host, and desktop using the leaf plan's exact commands; record real-audio/lifecycle checks separately. Do not enter the hosted-capture milestone if the prerequisite fails.
- [x] Codex review: capture callback only signals; cancellation wins over retries; fixed-PID behavior and shutdown remain correct. Proposed commit: `fix(capture): recover local sessions safely`.

Source and automated verification complete. Non-silent Spotify capture and
browser-audio exclusion were observed on October 8; device/sleep/restart/visual
and desktop-close acceptance remain open in Task 5. No commit was made.

### Task 2: Exact origins and bounded local sessions

**Files:** Create the three server-security files above and `tests/SpotifySynesthesia.AudioEngine.Tests/CompanionSessionManagerTests.cs`; modify `AudioFrameWebSocketServerOptions.cs`; create `docs/companion-connection-protocol.md`.

**Interfaces:**

- `BrowserOriginPolicy(IEnumerable<string> allowedOrigins)`; `bool IsAllowed(string? origin)`. Missing/null origins are not browser authorization.
- `CompanionSessionManager(BrowserOriginPolicy origins, TimeProvider? timeProvider = null)`; `PairingChallenge CreatePairingChallenge()`; `CompanionCredential CreateLocalCredential(string origin)`; `bool TryPair(string code, string origin, out CompanionCredential? credential)`; `bool TryAuthenticate(string token, string origin, out Guid sessionId)`; `CompanionCredential? Renew(string token, string origin)`; `void RevokeAll()`.
- Records: `PairingChallenge(string Code, DateTimeOffset ExpiresAtUtc)`; `CompanionCredential(string Token, Guid SessionId, DateTimeOffset ExpiresAtUtc)`.
- Protocol v1 messages: `pair {code}`, `authenticate {token}`, `renew {token}`, `paired/authenticated {expiresAtUtc}`, and generic `authenticationFailed`. Credentials never appear in URLs.

- [x] Write failing tests `RejectsOriginLookalikesAndNull`, `RejectsExpiredOrReplayedChallenge`, `BindsCredentialToExactOrigin`, `RevokesOnRestart`, and `BoundsAttemptsAndSessions`. Assert exact allowlist matching, single-use challenges, and no cross-origin credential reuse.
- [x] Run `dotnet test tests/SpotifySynesthesia.AudioEngine.Tests/SpotifySynesthesia.AudioEngine.Tests.csproj --filter FullyQualifiedName~CompanionSessionManagerTests`; observe behavioral failure with inert compiling seams before implementation (execution-ledger refinement).
- [x] Implement canonical scheme/host/port comparison. Accept configured HTTPS origins for owner-supplied public deployments and explicitly configured loopback HTTP development origins; reject userinfo, paths, query/fragment, wildcard rules, and non-HTTP schemes in configuration. Include the exact bundled origin for the configured port. Do not perform DNS/address-space classification in authorization.
- [x] Implement cryptographic random challenges (16 random bytes, base64url), 5-minute single-use validity, 32-byte connection credentials, 30-minute leases, and an 8-hour absolute session lifetime. Renewal rotates credentials while retaining the session ID; explicit disconnect/restart revokes sessions, but a transient socket close does not revoke the remaining lease. Bound failed pairing to 5 attempts/minute/origin and 20 total/minute, with at most 4 live paired sessions. Inject time for deterministic tests; never log codes/tokens. CreateLocalCredential is internal composition only, checks an allowed literal loopback HTTP origin, and is never exposed as a public route.
- [x] Add options for the exact origin collection and explicit native diagnostic policy. Production defaults require authentication for native clients too; do not equate an absent Origin header with trust.
- [x] Run focused tests and the audio-engine build; require passing cases and no warnings. Codex reviews random generation, fixed-time comparisons, bounded state, and expiry. Proposed commit: `feat(companion): add scoped pairing sessions`.

Complete Debug/Release builds, Release solution suites, and frontend tests passed
October 8 (225 tests). Independent policy/session review found no blocking issue.
That 225-test checkpoint preceded server enforcement. Task 3 now implements
the server/browser primitives and desktop composition; its review corrections
and automated checks passed. Real-browser and desktop acceptance remain open.

### Task 3: Enforce authentication and connect the companion UI

**Files:** Modify `AudioFrameWebSocketServer.cs`, `tests/SpotifySynesthesia.AudioEngine.Tests/AudioFrameWebSocketServerTests.cs`, `desktop/SpotifySynesthesia.Desktop/MainWindow.xaml` and `.xaml.cs`, `audio-engine/host/SpotifySynesthesia.AudioEngine.Host/Program.cs`, `visualizer/src/audio/AudioFrameClient.ts`, `visualizer/src/song/SongContextClient.ts`, `visualizer/src/main.ts`, `visualizer/package.json`, and its lockfile. Create `visualizer/src/connection/CompanionClient.ts`, `CompanionClient.test.ts`, `CompanionPanel.ts`, and `desktop/SpotifySynesthesia.Desktop/CompanionSettings.cs`.

**Interfaces:** `CompanionClient.pair(code: string): Promise<void>`, `credential(): string | null`, `disconnect(): void`, `onStatus(listener: (status: "unpaired" | "pairing" | "paired" | "unavailable") => void): () => void`. Extend both socket constructors with `getCredential: () => string | null`; frame/snapshot listener signatures stay unchanged. `CompanionSettings` holds only an optional public hosted origin and companion-mode flag.

- [x] Write failing server tests `PublishesNothingBeforeAuthentication`, `RejectsForeignOriginOnBothStreams`, `TimesOutInitialAuthentication`, and `RevocationClosesExistingSockets`. Assert no audio/context/command before successful auth; first message <=1024 bytes and deadline 5 seconds; expired sessions close with an auth-specific status.
- [x] Write failing browser tests `AuthenticatesBeforeReportingConnected`, `IgnoresOldSocketMessages`, `RequiresPairingAfterRevocation`, and `RenewsWithoutStoringToken`. Assert credentials are memory-only, stale socket messages are ignored, and unauthenticated retries do not loop forever.
- [x] Use a test-local fake WebSocket and fake timers; add a pinned `happy-dom` development dependency for DOM-dependent tests and mark only those files with the matching Vitest environment. Do not introduce a runtime UI framework or replace browser playback checks with DOM simulation.
- [x] Run the focused .NET server tests and `npm --prefix visualizer test -- CompanionClient.test.ts`; expect failures before implementing the new behavior.
- [x] Implement `/pair` as a loopback WebSocket with the same exact origin gate. Its bounded first message exchanges the one-time code for a credential and closes; `/audio` and `/song-context` require the authentication message before publishing/commands. Derive origin exclusively from the validated upgrade header, never a JSON body field. Renewal must update the shared session lease without accepting expired credentials; old tokens cannot open new sockets. Revoke sessions on explicit disconnect and companion shutdown, and schedule renewal at 25 minutes in the browser.
- [x] For the bundled WebView, deliver a separate short-lived credential using `PostWebMessageAsJson` only after exact trusted-source validation; listen for the matching v1 bootstrap message in `main.ts`. Restrict unexpected WebView navigation. Do not inject credentials into scripts for every possible document or expose shared API keys to the page.
- [x] Add visible companion controls to copy/rotate a pairing code, show capture/pairing status, open the configured hosted origin, and return to the bundled offline renderer. Validate the public origin; do not accept arbitrary navigation from a frontend query. Keep the window/lifecycle available; do not silently register startup or an OS service.
- [x] Hosted pages get an explicit “Connect Windows companion” dialog. Socket addresses must resolve to the known loopback endpoint; remove unrestricted `ws`/`songWs` query overrides from production. A development-only override must reject remote hosts and credential-bearing URLs. Test deny/missing-companion behavior and state reset on socket revocation.
- [x] Update diagnostic/native clients affected by required auth to use an explicit local-only test policy or a supplied ephemeral credential. Test policy is never the shipping default. Leave TestTonePlayer independent.
- [x] Run the full .NET server/session suites, frontend tests/build, Host build, and WPF build. Codex reviews both socket paths and callback/health routes for bypasses. Complete Debug/Release builds and 407 tests passed October 8; review corrections and focused re-review passed. No commit was made.
- [ ] Perform actual browser-loopback checks without disabled-security flags; report unsupported/denied behavior and bundled fallback honestly. Check real desktop pairing, reload, and shutdown. The user requested keeping the app closed for now; these checks are unverified. Proposed commit after acceptance: `feat(companion): secure browser and desktop connections`.

Task 3 source/automated checkpoint is ready; manual acceptance is not complete.
Claude authored the major implementations, tests, and first-pass self-review.
After its Pro session limit, Codex made only two narrow test-first corrections:
reset streams before adopting a new bootstrap family, and guard duplicate or
invalid pairing-dialog submissions. No larger implementation ownership switch,
API billing/account change, automatic resume, commit, or deployment occurred.
This is the historical Task 3 checkpoint. Task 4's subsequent Codex-authored
profile safety source checkpoint is recorded below; cloud publication and
spatial visual acceptance are not established by either checkpoint.

### Task 4: Profile backup, validation, export, and import

**Files:** Modify `visualizer/src/profiles/SynesthesiaProfile.ts`, `visualizer/src/ui/CalibrationPanel.ts`, `visualizer/src/main.ts`, `profiles/README.md`; create `visualizer/src/profiles/ProfileStore.ts`, `ProfileStore.test.ts`, `ProfileTransfer.ts`, and `docs/profile-migration.md`.

**Interfaces:** `ProfileStore(storage: Storage)`; `load(): ProfileLoadResult`; `replace(profile: SynesthesiaProfile): ProfileWriteResult`; `reset(): ProfileWriteResult`; `restoreBackup(): ProfileWriteResult`. `ProfileLoadResult` carries `{profile, warning: string | null}`. `ProfileWriteResult` is `{ok: true, profile}` or `{ok: false, message: string}`. `exportProfile(profile: SynesthesiaProfile): string`; `parseProfileImport(text: string): ProfileImportResult`, where ProfileImportResult has the same success/error union as ProfileWriteResult.

- [x] Write failing tests `RoundTripsEveryPitchAndResponseValue`, `RejectsPartialOrNonFiniteProfile`, `PreservesMalformedStoredBytes`, `BackupFailurePreventsReplacement`, and `CancellationDoesNotResetProfile`. Assert all 12 colors survive; missing response keys, nonfinite values, >64 KiB files, and invalid ranges are rejected without replacing the active profile.
- [x] Run the focused profile suites; observe behavioral failures with inert compiling seams before implementation. Additional transfer and actual-calibration DOM tests cover the size-before-read and confirmation/stale-operation boundaries.
- [x] Keep existing v1 profile/key compatibility and add a backup key. Save the old raw bytes before replacement/reset; on backup/storage failure leave old active bytes untouched and surface an actionable message. Validate the full required response shape and the current UI ranges (0–1 responses, attack 10–300 ms, release 100–1500 ms); tolerate existing valid optional fields, not arbitrary unbounded data.
- [x] Implement user-triggered JSON download/import and backup restore. Confirm reset and import replacement; cancellation makes no change. Distinguish temporary in-memory fallback from successful persistence. Do not upload profiles or automatically read another origin's storage.
- [ ] Keep `profiles/synesthesia.json` untouched in this milestone. Before the cloud plan removes its frontend import, export and back up the actual current palette/response, including the current default when localStorage is empty. Do not switch to public defaults or publish the hosted bundle until that migration checkpoint succeeds; the cloud plan introduces the separate public template.
- [ ] Run all profile tests, full frontend suite, and `npm --prefix visualizer run build`; manually export the desktop profile, import into a different origin, compare colors/settings, and verify cancel/reset/backup recovery. Codex reviews the preservation and failure paths. Proposed commit: `feat(profiles): preserve personal settings during migration`.

Source/automated portion passed October 8: 162 frontend tests, strict build,
both complete Debug/Release builds, 345 .NET tests, and independent source review
with its important damaged-backup finding fixed test-first (507 combined tests).
Recovery adds bounded `.recovery` and `.damaged` records so interrupted restores
and repeated slider edits cannot discard the only retained original. Details and
the remaining real-transfer/palette gate are in `docs/profile-migration.md`.
`profiles/synesthesia.json` is unchanged. Task 4's combined manual checkbox stays
open; no commit was made.

### Task 5: Foundation acceptance record

**Files:** Modify `docs/mvp-verification.md`, `docs/companion-connection-protocol.md`, and `docs/profile-migration.md` only after checks.

**Interfaces:** Consumes Tasks 1–4. Produces evidence for the cloud/spatial plans; not a claim of hosted deployment or visual accuracy.

- [x] Run both complete Build.ps1 configurations, Release .NET tests, and full frontend tests. Latest Task 4 source checkpoint: 507 passing tests, zero .NET build warnings/errors.
- [ ] Record actual Spotify capture/isolation/recovery/shutdown and current Chrome/Edge pairing. Verify an unrelated origin cannot receive frames, a revoked credential stops delivery, and the bundled renderer works with the network disconnected.
- [ ] Record profile transfer/backup/cancellation manually; confirm no credentials or private exports were committed or sent to Claude.
- [ ] Codex reviews the whole diff and verification output. Mark each manual check performed, failed, or unverified. Do not advance a dependent phase over a failed prerequisite.

## Self-review

The capture leaf plan supplies the exact shared monitor interfaces. This plan adds authentication without changing AudioFrame payloads, makes both streams enforce the same policy, and keeps local/offline behavior independent of cloud auth. Named tests cover all five review-focus failure classes. The profile store supplies the safe replacement boundary consumed by the later spatial-settings task.
