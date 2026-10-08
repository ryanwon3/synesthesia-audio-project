# Hosted backend setup and release gates

## Current state — October 8, 2026

The protected [pilot](https://synesthesia-pilot-compass-8108.vercel.app) is a
**static-only deployment**. Its synthetic preview and local-companion connection
are separate from the backend source added in the managed worktree. The updated
visual bundle and capability-gated hosted account controls are deployed. Backend
handlers are not deployed, so Spotify account login and hosted Last.fm tag
retrieval are unavailable on the static pilot. Its undeployed API paths return404.

Backend source now implements account/session boundaries, Spotify current-song
polling, cached Last.fm tags, optional matched-lyrics analysis, durable request
and analysis limits, and authenticated disconnect. The hosted renderer receives
only validated song context, never service tokens, lyrics, raw provider responses,
or audio. Windows capture/DSP and normalized live audio remain local.

The owner configures provider credentials once on the server. End users sign in
and pair their companion; they must not enter provider API keys. The native
legacy service settings are a separate, preserved path, not a hosting prerequisite.

## Owner-only configuration

Use the existing **compass-8108 / synesthesia-pilot** project. Confirm that exact
target before changing anything. Keep Vercel authentication protection enabled
for this private pilot. The previously approved Neon resource is Preview-only;
do not give Preview deployments production database access.

Enter secret values privately in the project's environment settings. Do not paste
them into chat, put them in command arguments, copy them into the renderer, or
pull/print local environment files. Do not use a `VITE_` prefix for server secrets.
Never inspect or reuse the desktop's protected credential store.

| Server setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Approved environment's PostgreSQL connection; server-only secret. The application enforces verified TLS and ignores URL options that weaken it. |
| `BETTER_AUTH_SECRET` | Owner-generated secret, at least 32 characters, used for auth/token protection. |
| `BETTER_AUTH_URL` | Exact bare HTTPS origin of the intended backend deployment. No path, wildcard, query, or credentials. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Owner's Spotify application configuration; the secret stays server-side. |
| `SPOTIFY_ALLOWED_USER_IDS` | Nonempty comma-separated list of Spotify user IDs permitted by the current private-pilot implementation. This is the provider profile `id`, not the app's Client ID, email or display name. |
| `LASTFM_API_KEY` | Optional server-only Last.fm key; absence/failure leaves Spotify metadata and local audio available. |
| `AI_ENRICHMENT_ENABLED` | Leave `false` or unset for the minimum pilot. A key alone never enables paid analysis. |

Only after separate approval to use paid analysis, configure `OPENAI_API_KEY`,
`OPENAI_MODEL`, `AI_USER_DAILY_LIMIT`, and `AI_GLOBAL_DAILY_LIMIT`. The default
limits are 10 analyses per user/day and 50 globally/day; these are call-count
limits, not a dollar-cost guarantee. No AI request was made during this source
batch. No gateway, billing, account, or provider switch is required or authorized.

Register the exact `${BETTER_AUTH_URL}/api/auth/callback/spotify` redirect in the
owner's Spotify application. Verify the actual authorization request's required
identity/current-playing scopes and S256 PKCE before release. Source configuration
does not establish that a real login, token refresh, or revocation works.

### Finding the Spotify settings

In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
select the existing app matching the Client ID and open its settings to access
the Client Secret. Copy the secret directly into Vercel's Preview environment,
never into chat. See [Spotify's app documentation](https://developer.spotify.com/documentation/web-api/concepts/apps).
For the current pilot's user-ID setting, open the Spotify profile and use
Share -> Copy Link. Take only the ID after `/user/`, excluding query parameters.
It is not the profile's display name. Multiple permitted IDs are comma-separated.
Spotify's separate development-mode allowlist is in Settings -> Users Management
(also labeled Users and Access); it uses the invited user's name and Spotify
email. The owner must meet Spotify's current Premium requirement. See
[quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

Spotify's current documentation now recommends immutable `account_id` rather
than `id` for account linking. The pinned provider/current pilot currently uses
`id` for allowlisting and stored provider identity. Before enabling hosted login,
review that mapping against the current API and prove it with synthetic contract
tests and actual approved OAuth verification. Do not substitute an `account_id`
into this setting without the matching implementation change. See
[Spotify identities](https://developer.spotify.com/documentation/web-api/concepts/spotify-uris-ids).

## Database gates — not yet executed

Auth schema comes from the pinned Better Auth configuration, not hand-invented
auth tables. Review the generated migration plan, including database rate-limit
tables, and prove it in a fresh disposable environment first. Source migrations
`001-enrichment.sql` and `002-lastfm-tags.sql` add context, reservations/leases,
analysis caches, request limits, tag caches and the shared Last.fm cooldown.

`npm run migrate:cloud -- --apply-preview` also requires
`SYNESTHESIA_MIGRATION_TARGET=preview`. These guards do not confer permission:
**do not run it against the owner's resource until migration approval and the
disposable/auth verification gates are satisfied.** It is never run by a build.
The standalone migration script does not automatically load a local env file.

Seven real PostgreSQL tests are deliberately skipped by default. They require a
separately created, disposable database at `127.0.0.1`, named
`synesthesia_test_<8–32 lowercase hex characters>`, and both
`SYNESTHESIA_TEST_DATABASE_DISPOSABLE=yes` and
`SYNESTHESIA_TEST_DATABASE_URL`. Never supply the application's `DATABASE_URL`.
The tests create/drop only their own unique synthetic schema. They cover two-pool
reservation/lease races, disconnect resurrection, expiry and shared tag cooldown.
They have not run here and are not evidence of real database atomicity.

## Build separation and release sequence

1. Run the complete cloud/frontend suites and cloud type check. Run both Windows
   configurations and their relevant tests. If the app holds the normal Release
   executable open, use a separate verification output; do not force-kill it.
2. Build the hosted renderer with `npm run build:hosted`. Root `vercel.json`
   selects `visualizer/dist-hosted`; ordinary Windows builds continue to select
   the native bundle. Hosted public defaults are neutral/uncalibrated, not the
   actual private palette. Imported colors remain local and take precedence.
3. Complete approved owner configuration and fresh disposable database/auth
   verification. Review any remaining dependency/security publication findings.
   Apply approved migrations to the intended Preview resource only.
4. Only with authorization for the reviewed backend deployment, deploy a scoped
   protected Preview. Verify `/api/auth/*`, `/api/song-context`, `/api/enrichment`,
   `/api/disconnect`, and `/api/capabilities` are functions, not SPA fallback HTML.
   Check cookie security, cross-user isolation, refresh/disconnect, provider errors,
   cache/limit races and no-store/redacted responses. Keep AI off initially.
5. Perform deferred browser pairing, real music/GPU/visual and personal-profile
   export/import/compare acceptance. Then decide whether to promote that tested
   backend. Do not treat passing unit tests as release authorization.

Last.fm tags are bounded contextual hints, not instrument detection. Track tags
have greater weight than artist tags. Acoustic/folk tags warm/soften the scene;
ambient/dream-pop adds haze; electronic tags sharpen shimmer; metal/industrial
adds distortion; jazz/soul adds warmth/fluidity. Audio remains responsible for
wave energy, low-attack rain, harmonic-change glass and high-energy shimmer.
Personal pitch colors remain the default. The top-level Mood palette choice is
session-only and never overwrites them. Startup remains painting; 3D is experimental.

Actual shader compilation, live timing, Spotify isolation and personal perceptual
accuracy remain unverified in this batch. See [spatial verification](spatial-verification.md)
and [the deployed pilot instructions](mvp-pilot.md) for the evidence history.
