# Hosted Background Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the existing visualizer and optional account-specific enrichment on Vercel without asking end users for service keys.

**Architecture:** A root Vercel project serves `visualizer/dist` and small API functions whose implementation lives in `cloud/src`. Better Auth manages Spotify OAuth and database-backed sessions. One Marketplace-managed Neon Postgres resource holds auth, generated analysis/cache, request leases, and atomic usage limits; live PCM/DSP stays local.

**Tech Stack:** Node.js 24, TypeScript, Vercel functions, Better Auth, `pg`, Neon Postgres, existing Vite frontend, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-hosted-synesthesia-design.md`; shared constraints/execution rules in `2026-10-07-hosted-synesthesia-rollout.md`.

## Global Constraints

- Raw audio is not uploaded to Vercel.
- Chargeable cloud enrichment requires authorization, per-user and global limits, bounded provider requests, caching, and an owner-controlled usage ceiling.
- Never share one user's Spotify token with other users.
- Personal pitch colors remain the default. Mood palettes remain explicitly opt-in.
- Cloud profile synchronization is deferred until needed and must be explicitly opted into.
- No frontend API keys or `VITE_` secrets; no secret values in logs, diagnostics, fixtures, patches, or Claude inputs.
- Provision the actual database before database-dependent product code. If an account, terms, plan, or owner credential is missing, report that checkpoint; do not substitute a fake production backend.
- Do not create a public unrestricted Spotify rollout or buy a paid tier. Initial pilot uses the owner's configured Spotify allowlist and usage limits.

## Review Focus

- Missing server configuration at build or runtime: Task 1 builds safely and reports a redacted unavailable capability.
- Browser requests for provider tokens or another user's account: Task 2 denies them while trusted server access remains account-scoped.
- Simultaneous enrichment/retries across function instances: Task 3 atomically bounds reservations and duplicate jobs in Postgres.
- Old song results arriving after a track switch, or expired login during playback: Task 4 discards stale context without interrupting local frames.
- Prompt-like provider content, malformed JSON, or provider failure: Task 3 validates bounded categories, supplies safe fallback, and never executes returned text.

---

## File boundaries

- Root `package.json`, `package-lock.json`, and `vercel.json`: server dependencies, cloud scripts, Vite build/output, explicit function routing. Keep `visualizer/package-lock.json` and its existing standalone build.
- Root `api/auth/[...path].ts`, `api/song-context.ts`, `api/enrichment.ts`, `api/disconnect.ts`, `api/capabilities.ts`: thin handlers only.
- `cloud/src/config.ts`, `db.ts`, `auth.ts`, `auth-policy.ts`: lazy server configuration, bounded database pool, library-managed auth, exact-origin/route policy.
- `cloud/src/spotify.ts`, `lastfm.ts`, `lyrics.ts`, `analysis.ts`, `song-context.ts`, `usage-budget.ts`: small bounded integrations and orchestration.
- `cloud/migrations/`, `cloud/tests/`, `cloud/tsconfig.json`, `cloud/vitest.config.ts`: reviewed migrations, tests, and server type/build isolation.
- `shared/SongIdentity.ts`, `shared/SongTraits.ts`, `shared/CloudSongContext.ts`: secret-free normalized types and validators used by both cloud and browser; no server imports.
- `visualizer/src/song/HostedSongContextClient.ts`, `HostedSongContextClient.test.ts`, `CloudContextAdapter.ts`, and `visualizer/src/connection/CloudAccountClient.ts`: hosted clients, normalization, and account controls.

Representative assertion contracts for the named tests below:

```ts
expect(readCloudConfig({})).toMatchObject({ok: false});
expect(isCloudSongContext({protocolVersion: 1, status: "playing"})).toBe(false);
const limits = {userDaily: 2, globalDaily: 3};
const budget = new UsageBudget(testPool, limits, () => new Date("2026-10-07T12:00:00Z"));
const outcomes = await Promise.all(Array.from({length: 20}, (_, i) =>
  budget.tryReserve("test-user", "test-track", `test-request-${i}`)));
expect(outcomes.filter(value => value === "reserved")).toHaveLength(2);
// Repeat with distinct users and separate Pool instances: global reservations <=3.
```

`testPool` is a disposable real Postgres fixture in the named integration file,
not a production connection or mocked atomicity proof. Direct budget tests may
use synthetic request keys; HTTP route tests require UUIDs.

### Task 1: Provision storage and establish a deployable contract

**Files:** Create root package/configuration, `cloud/src/config.ts`, `db.ts`, `cloud/tests/config.test.ts`, `cloud/migrations/001-enrichment.sql`, the shared contract files, `api/capabilities.ts`, and `visualizer/src/profiles/PublicDefaultProfile.ts`; modify `visualizer/src/profiles/SynesthesiaProfile.ts`, the corresponding pure type declarations in `visualizer/src/song/SongContext.ts` and `SongVisualProfile.ts`, `.gitignore`, `Build.ps1`, and `README.md`.

**Interfaces:**

- `readCloudConfig(env: NodeJS.ProcessEnv): CloudConfigResult` returns `{ok: true, config: CloudConfig}` or `{ok: false, missing: string[]}`. CloudConfig holds validated public origin, required auth/database configuration, optional provider capabilities, and usage settings; error results contain names only. Never serialize the internal config, which necessarily holds server secrets, to a browser.
- `getDatabase(): Pool` lazily initializes `pg` with at most 3 connections/instance, 5-second connection timeout, and TLS verification.
- `CloudSongContextV1` has `protocolVersion: 1`, `status: "playing" | "paused" | "none" | "signedOut" | "forbidden" | "unavailable" | "rateLimited"`, `observedAtUtc`, `nextRetryUtc: string | null`, `track: CurrentTrack | null`, `trackTags/artistTags: LastFmTag[]`, `analysis: SongVisualProfile | null`, and `capabilities: {lyrics: boolean; ai: boolean}`. Move the existing pure `CurrentTrack`/artist/album types and `MoodTraits`/`SongVisualProfile`/mood/effect literals into shared files and re-export them for legacy imports.
- `isCloudSongContext(value: unknown): value is CloudSongContextV1` validates every nested field, finite bounds, known categories, <=16 nonoverlapping sections, bounded strings/tags, and valid timestamps. Define the existing `LastFmTag` shape in shared/CloudSongContext.ts and re-export it from the legacy frontend module. No database paths, raw lyrics, arbitrary `reserved` records, tokens, or provider error bodies belong in this DTO.
- `publicDefaultProfile(): SynesthesiaProfile` in PublicDefaultProfile.ts supplies a neutral calibration template, never imported private user colors. Start all 12 pitch colors at `#808080`, normalized response controls at 0.5, attack at 40 ms, release at 300 ms, and personal mode; these defaults apply only when no profile was stored/imported. Mark the missing personal palette visibly and keep the verified migration backup available.

- [ ] Read current CLI help, run read-only Marketplace category/storage discovery, and inspect the intended team/project link. Recommend Marketplace Neon per the storage skill. The prior account check found team `compass`; verify the current target rather than inventing or overwriting a project.
- [ ] At this plan's execution checkpoint, establish the scoped Vercel pilot project and provision Neon through its Marketplace integration on a no-paid-upgrade path. Record resource/project IDs and environment associations, not credentials. Use separate preview/production branches/resources; if setup requires the human's account/terms/plan choice, stop provisioning and ask for that specific action.
- [ ] Write failing `buildDoesNotReadSecretsOrConnect`, `missingConfigReportsNamesOnly`, and `rejectsMalformedCloudContext` tests. Include partial tracks, NaN/infinity, invalid dates, oversized tags/strings, unknown moods/effects, overlapping/out-of-range sections, and extra credential fields.
- [ ] Run `npm run test:cloud -- config.test.ts`; the first run may fail because its package/script does not exist. Add the minimal root scripts/test setup with this deliverable, then confirm the behavior assertions fail before their implementation.
- [ ] Implement root scripts `build`, `typecheck:cloud`, `test:cloud`, and `migrate:cloud`. `build` type-checks cloud and builds the existing visualizer; output is `visualizer/dist`. Use a repository-root Vercel project, with auth catch-all/API routing tested before the SPA fallback; avoid a Next.js/React rewrite.
- [ ] Add required server configuration `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_ALLOWED_USER_IDS`. Optional configuration: `LASTFM_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_ENRICHMENT_ENABLED`, `AI_USER_DAILY_LIMIT`, and `AI_GLOBAL_DAILY_LIMIT`. Secret variables are project Secrets; public identity/origin/flags are Config. AI remains disabled until explicitly configured; never pull production secret values into this workspace.
- [ ] Implement the shared validators and lazy configuration/database boundary. `GET /api/capabilities` returns only `{spotify: boolean, lyrics: boolean, ai: boolean}` and uses `Cache-Control: no-store`; no key names/values, exception text, or database host/path are returned to end users. After the foundation palette-export checkpoint succeeds, replace the private JSON frontend import with PublicDefaultProfile, leaving existing local/imported values untouched; test that private JSON is absent from public browser assets.
- [ ] Create parameterized migration tables for normalized per-user current-context cache, generated analysis keyed by track/model/prompt-version/lyrics-hash, enrichment leases/idempotency, and usage counters. Auth tables are generated/reviewed in Task 2, not invented here. Migrations must use only the intended environment and must not run during ordinary Vite builds.
- [ ] Run cloud config/contract tests, `npm run typecheck:cloud`, frontend tests/build, and a Vercel preview route/build check against the real provisioned database. Codex reviews environment separation, serialization, and API routing. Proposed commit: `feat(cloud): establish hosted service contracts`.

### Task 2: Library-managed Spotify login with server-only tokens

**Files:** Create `cloud/src/auth.ts`, `auth-policy.ts`, `cloud/tests/auth.test.ts`, `cloud/tests/auth.integration.test.ts`, auth migration output, `api/auth/[...path].ts`, and `api/disconnect.ts`; create `docs/hosted-setup.md`.

**Interfaces:** `getAuth(): ReturnType<typeof betterAuth>` lazily creates the configured library instance. `requireUser(headers: Headers): Promise<{userId: string}>`; `getSpotifyToken(headers: Headers, userId: string): Promise<string>` selects an account owned by that validated user and calls the library's server API; no caller supplies a trusted user/account ID. `disconnectSpotify(userId: string): Promise<void>` clears provider credentials and revokes that user's sessions.

- [ ] Read documentation matching the installed Better Auth release; use its plain-JavaScript client/server handler, Spotify provider, and `pg` database support. Configure exact production/stable-preview origins, database-backed state/rate limits, `account.encryptOAuthTokens: true`, no provider-account cookie, no automatic account linking, and database-checked sessions. Do not disable CSRF/origin checks or implement manual JWT/password auth.
- [ ] Write failing tests `invalidStateCreatesNoSession`, `foreignAccountCannotSupplyToken`, `publicTokenRoutesAreForbidden`, `tokenColumnsAreEncrypted`, and `logoutAndDisconnectRevokeAccess`. The encryption test reads only synthetic test credentials in a disposable test database, never real owner credentials.
- [ ] Run `npm run test:cloud -- auth.test.ts`; expect the new auth boundary tests to fail before implementing it.
- [ ] Generate and review auth migrations from the actual library configuration; include database-backed rate-limit tables. Apply only to the test/preview resource first and prove a fresh environment can migrate without manually altering tables.
- [ ] Mount the auth library at `/api/auth/*` with its state/PKCE protections and Spotify scopes required for provider identity and `/me/player/currently-playing`. Retain the provider's required identity scopes and add `user-read-currently-playing`; do not request playback modification or library/playlist writes. Verify the actual authorization request includes S256 PKCE and only necessary scopes. Register the exact HTTPS `/api/auth/callback/spotify` URL in the owner's Spotify app; allowlist pilot users. A missing owner setup step is a reported blocker, not a reason to solicit end-user client IDs.
- [ ] Permit only needed browser auth routes: sign-in/social, Spotify callback, get-session, sign-out, and health/ok. The route wrapper denies browser access to get-access-token, refresh-token, account-info, arbitrary providers, and unexpected auth paths. Trusted server `auth.api` calls remain available internally; account selection uses the validated user's own Better Auth account record ID, not providerId alone.
- [ ] Gate pilot sign-in/enrichment on configured Spotify user IDs derived from the verified provider identity. Do not trust a browser-supplied email/ID. Sessions use Secure/HttpOnly/SameSite cookies in production; account-token storage is encrypted. Avoid session-cookie caching that defeats prompt revocation.
- [ ] Implement same-origin authenticated `POST /api/disconnect`: clear access/refresh credentials for that user's Spotify account while retaining its verified identity record for future reauthorization, revoke sessions, and expire the browser session. Do not clear another user's record or delete local audio/profile settings.
- [ ] Run auth unit/integration tests and cloud type check; manually perform one real pilot login, denial/reconnect/logout, and inspect response/bundle redaction without printing tokens. Record OAuth consent and app quota constraints. Codex reviews account isolation, HTTP route denial, and callback behavior. Proposed commit: `feat(cloud): add isolated Spotify account sessions`.

### Task 3: Optional, cached, bounded enrichment

**Files:** Create the six provider/orchestration/budget modules listed above, `cloud/tests/providers.test.ts`, `usage-budget.integration.test.ts`, `song-context.test.ts`, `api/song-context.ts`, and `api/enrichment.ts`; extend `001-enrichment.sql` via a new versioned migration if already applied.

**Interfaces:**

- `readCurrentPlayback(token: string, signal: AbortSignal): Promise<CurrentTrack | null>`; `getTags(track: CurrentTrack, signal: AbortSignal): Promise<{trackTags: LastFmTag[]; artistTags: LastFmTag[]}>`.
- `getMatchedLyrics(track: CurrentTrack, signal: AbortSignal): Promise<{text: string; source: string; hash: string} | null>`; `analyzeLyrics(track: CurrentTrack, lyrics: string, signal: AbortSignal): Promise<SongVisualProfile>`.
- `getSongContext(headers: Headers, signal: AbortSignal): Promise<CloudSongContextV1>`; `requestEnrichment(headers: Headers, request: {trackId: string; requestId: string}, signal: AbortSignal): Promise<{status: "ready" | "pending" | "disabled" | "limited"}>`.
- `UsageBudget(database: Pool, limits: {userDaily: number; globalDaily: number}, now?: () => Date)`; `tryReserve(userId: string, trackId: string, requestId: string): Promise<"reserved" | "duplicate" | "limited">`. Daily accounting uses UTC day keys; provider work begins only after a committed reservation and unique cache-key lease.

- [ ] Write failing tests `providerFailureLeavesValidContext`, `neverFetchesCallerUrlOrPrompt`, `rejectsInjectedOrUnboundedAnalysis`, `oldTrackDoesNotOverwriteCurrentTrack`, and `retryAfterIsRespected`. Use provider HTTP fixtures with synthetic content, not real keys/lyrics.
- [ ] Write real Postgres integration tests `parallelReservationsRespectUserAndGlobalLimits`, `sameRequestIsChargedOnce`, and `sameCacheKeyHasOneProviderOwner`: 20 simultaneous calls with test limits user=2/global=3 must reserve no more than either limit. Separate Pool instances prove limits are not process-local.
- [ ] Run the focused tests; require the behavior assertions to fail before implementation. Keep test databases separate from production; never mock the final proof of atomicity.
- [ ] Implement provider adapters using fixed provider endpoints, encoded query parameters, finite timeouts, response-size limits, and known schemas. Reuse the existing C# matching/normalization/cache-policy behavior as the reference and port its relevant tests, not Windows capture or protected-store code. Cache context for 5 seconds/user to coalesce playback polling; respect Spotify/provider Retry-After and map forbidden/unsupported/no-playback without fabricating a track.
- [ ] Implement optional Last.fm/LRCLIB lookup and generated-analysis cache. No OpenAI request occurs on capture/frame callbacks or on every metadata poll. Enrichment is initiated once per requested song/cache key, with total request deadline 20 seconds and no indefinite in-function background loop.
- [ ] Require authenticated same-origin POST, JSON <=1024 bytes, validated track ID/current-track match, and UUID requestId. Body never contains arbitrary prompts, provider URLs, models, raw audio, or user identity. Browser request-rate limits use durable counters; start with 24 context requests/minute/user and 6 enrichment attempts/minute/user.
- [ ] Implement atomic per-user/global daily AI reservations in a transaction that locks counter rows in a stable order, plus unique idempotency/job lease keys. Default daily request ceilings when AI is enabled: 10/user and 50/global. Failed/uncertain provider attempts conservatively consume their reservation; retries need another available reservation. Cache hits make no paid request. An expired lease may be reclaimed only with a new reservation. Do not describe request counts as a guaranteed monetary billing cap; the owner also configures provider spending controls.
- [ ] Keep the model server-configured. Bound the complete prompt to 16000 UTF-8 bytes and output to 5000 tokens (the existing analyzer's output ceiling); require the existing mood/effect enums, finite 0–1 traits, imagery from `none/water/air/light/earth/fire`, and <=16 sorted/nonoverlapping sections within song duration. Treat lyrics/tags as data, never instructions. Reject colors, shader/code instructions, URLs, secrets, unknown keys, and malformed output; use safe tag/neutral fallback. Retain model-compatible reasoning settings from the existing adapter and test truncated/empty responses rather than assuming every model returns a complete profile.
- [ ] Return only CloudSongContextV1, never raw lyrics or provider errors. Keep generated analysis separate from all personal overrides. Validate cached records before returning them, and do not allow a late job to change another active track.
- [ ] Run all cloud unit/integration tests and type check; test missing keys, outages, malformed content, rate/usage limits, and two separate users. Codex reviews the SQL race proof, SSRF/prompt boundary, and redaction. Proposed commit: `feat(cloud): bound and cache optional enrichment`.

### Task 4: Hosted frontend and desktop/offline composition

**Files:** Create the hosted browser client/adapter/account files listed above and `cloud/tests/routes.test.ts`; modify `visualizer/src/main.ts`, `index.html`, `ui/DebugOverlay.ts`, desktop `MainWindow.xaml.cs`, `README.md`, and `docs/hosted-setup.md`.

**Interfaces:** `HostedSongContextClient` supplies `start`, `stop`, `onSnapshot`, and `onStatus` with the existing SongContextClient listener signatures; `requestAnalysis(trackId: string): Promise<void>`. `toLocalSongContext(dto: CloudSongContextV1): SongContextSnapshot` maps only validated fields and uses a non-filesystem cloud status label for legacy diagnostics. `CloudAccountClient.connect(): Promise<void>`, `signOut(): Promise<void>`, and `disconnect(): Promise<void>` wrap only permitted auth operations.

- [ ] Write failing `401DoesNotStopAudio`, `ignoresOldPollAfterTrackChange`, `stopAbortsOutstandingRequests`, `hostedUiHasNoKeyEntry`, and `desktopOfflineDoesNotStartCloudRequests` tests. Assert local audio clients are independent and the last validated context ages out honestly.
- [ ] Run `npm --prefix visualizer test -- HostedSongContextClient.test.ts`; expect failures before implementation.
- [ ] Implement same-origin 5-second polling outside the render loop, cancellation, exponential outage backoff up to 60 seconds, and provider Retry-After. Accept only the shared validator. Use neutral/cached context on failure; no renderer calls provider APIs directly.
- [ ] Select mode from trusted composition/origin: the hosted site uses CloudAccountClient/HostedSongContextClient plus the paired local audio stream; the bundled offline page uses local context and never assumes a public session cookie is shared with WebView2. Do not let query parameters replace the trusted cloud/API origin.
- [ ] Replace hosted client-ID/key-entry controls and WPF-only setup messages with Spotify connection and optional analyze/disconnect controls. Explain when matched lyrics are sent for AI analysis; default automatic paid analysis off. Show service-unavailable/account-required states without asking end users for keys. Companion mode does not start legacy local paid-provider runtimes; preserve old stores and any explicitly selected developer diagnostic mode.
- [ ] Cache only validated, nonsecret normalized context locally for offline fallback. Do not cache raw lyrics or OAuth tokens in browser storage. Clear account-specific context on sign-out/disconnect without clearing the user's personal colors or themes.
- [ ] Run full cloud/frontend tests/type checks and both Build.ps1 configurations. Deploy a scoped preview, verify auth paths are not swallowed by SPA fallback, perform real pairing/login and provider-failure checks, and scan the browser artifacts for server imports/credential exposure. Report missing owner setup and manual checks explicitly. Codex approves the reviewed pilot state before promotion. Proposed commit: `feat(hosted): connect browser UI to shared services`.

## Primary references and self-review

- [Vercel Vite/function layout](https://vercel.com/docs/frameworks/frontend/vite).
- [Marketplace Neon](https://vercel.com/marketplace/neon).
- [Better Auth Spotify provider](https://better-auth.com/docs/authentication/spotify), [options/token encryption](https://better-auth.com/docs/reference/options), and [explicit account selection](https://better-auth.com/docs/concepts/oauth).

One database serves the pilot; no Redis, profile synchronization, or UI-framework migration is added. Provisioning/owner setup precedes real provider verification, while local rendering remains independent. All named routes/types have producers and consumers, and every Review Focus item has an owning test task. Public auth routing deliberately excludes provider-token endpoints even though the library can offer them.
