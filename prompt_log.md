# Prompt Log

This is a concise record of the AI assistance used on the project, not a full
chat transcript. It intentionally contains no API keys, access tokens, personal
data, lyrics, or other secrets.

## Models and tools

- **Assistants:** OpenAI Codex and Anthropic Claude Code using the owner's
  subscription. Exact model/version information is recorded only when verified;
  this log does not infer it from an assistant's name or subscription tier.
- **Development tools:** PowerShell, the .NET CLI, NuGet, npm, Vite, TypeScript,
  Vitest, Three.js, Git, Claude Code's restricted patch workflow, and the Vercel
  CLI/connected project tools.
- **Verification tools:** solution and frontend builds, xUnit and Vitest test
  suites, repository/ignore inspection, and a pre-publication credential scan.

## Key prompts that shaped the implementation

The following are short summaries of the most important implementation prompts
and constraints:

1. Build a Windows 11 desktop experience that turns Spotify process audio into
   a continuously evolving abstract environment, never a conventional waveform,
   spectrum, equalizer, or analytics dashboard.
2. Keep three independent execution lanes: real-time capture/DSP, background
   metadata and persistence, and rendering from normalized visual state.
3. Preserve the user's personal 12-note color mapping as the default; allow a
   separately selected mood-palette mode, while AI returns only bounded
   mood/texture categories and never colors or renderer code.
4. Treat Spotify, Last.fm, lyrics, and OpenAI as optional enrichment so local
   audio visualization continues through network, account, or provider failures;
   keep every secret in protected backend-only storage.
5. For each meaningful change, build every affected project, run focused and
   relevant full tests, perform any necessary real-world audio/visual check, and
   clearly report anything that remains unverified.
6. Publish the complete source project in a new GitHub repository with a README
   that explains API calls, credential setup, installation, running, and this
   prompt log without exposing any key.
7. Host optional service integrations with centrally configured server keys,
   using Vercel for the frontend and a Windows companion for Spotify audio.
   Keep raw captured audio local; service failures must not stop visualization.
8. Make musical roles clearer through color and effect families. Explore an
   abstract 3D wave/rain/glass theme while keeping the original painting as the
   startup renderer and avoiding waveform/equalizer presentation.
9. Preserve personal pitch colors and stored calibration. Mood palettes and
   experimental theme choices must be explicit; metadata/AI never chooses
   personal colors or supplies renderer code. Audio features are approximations,
   not a claim of separated guitar, vocal or instrument stems.
10. Use Claude Code for most implementation and first-pass self-review, with
    Codex planning, applying patches, testing and reviewing high-risk boundaries.
    When Claude is quota-limited, allow a human-authorized temporary Codex
    implementation batch without switching billing, accounts or providers.
11. Allow only selected source and synthetic tests to be sent to Claude/Anthropic.
    Exclude API keys, credentials, actual personal profile JSON, local data,
    diagnostic outputs and captured audio. Use narrowly scoped read-only patch
    requests rather than unrestricted access to the whole computer.
12. Harden local companion pairing: exact allowed origins, one-use expiring
    codes, memory-only browser credentials, authentication before frames/context,
    and safe reload, disconnect and shutdown behavior.
13. Implement safe profile backup/import/export and optional spatial ownership
    without replacing stored user colors on malformed input or storage failure.
14. Prepare a no-charge protected pilot in the existing Vercel team and an
    approved Preview-only database. Let the owner review integration terms and
    enter secrets privately; do not inspect protected stores or pull secret files.
15. Prioritize a minimum usable deployed visual pilot, with an explicitly labeled
    synthetic preview. Publish neutral public defaults rather than the native
    personal palette. Defer user music, browser, visual and palette acceptance.
16. Complete backend source for authenticated current-song context, bounded
    Last.fm tags/cache, optional manual analysis and durable user/global budgets.
    Keep paid analysis off, validate ownership and return fixed redacted errors.
17. Add stronger mapped colors, audio-driven shimmer/distortion and slower
    Last.fm-tag atmosphere. Ensure tag-only silence does not invent attacks and
    reduced-motion preferences attenuate effects. Mood-to-Personal restoration
    must not retain a remembered Mood tint.
18. Start the live rollout with an exact allowlisted neutral static bundle.
    Verify delivered hashes, security/privacy routes and deployment protection.
    Treat backend configuration, real database/OAuth verification and migration
    approval as separate gates; do not claim a full hosted release from a static
    deployment or synthetic tests.
19. Explain where the owner obtains the Spotify Client Secret and the pilot's
    allowed-user IDs without receiving those values in chat. Review Spotify's
    current account-identity guidance before enabling hosted sign-in.
20. Commit and push the project checkpoint to GitHub with an updated README and
    this AI prompt log, excluding secrets, personal/local outputs and generated
    artifacts. Preserve the original checkout and unrelated work; do not merge
    the implementation branch into `main` without a separate decision.

## October 7–8, 2026 workflow and checkpoint

Claude Code authored approved source/test patches and performed first-pass
self-review through the restricted workflow. Codex applied and verified patches,
reviewed security/lifecycle/profile boundaries and handled planning and hosting.
On October 8 the owner temporarily returned backend/visual implementation to
Codex while Claude usage was limited. The public source includes these changes
and their synthetic tests; this log does not reproduce private assistant output,
subscription/login data, prompts containing secrets or local diagnostic captures.

The October 8 static pilot is READY/production on the existing protected Vercel
project, with stronger visual color/effects, neutral defaults and synthetic 3D
preview. Only an allowlisted static bundle was uploaded, and downloaded files
matched its build hashes. Backend source exists but is not deployed: provider
settings, immutable account-identity compatibility, real PostgreSQL races/auth
migrations and actual OAuth/routing checks remain gates. Paid AI remains off.
Browser pairing, music/GPU/visual acceptance and private-profile migration are
not claimed complete. See the README and the dated verification documents for
specific evidence, test counts and remaining checks.

Before this GitHub checkpoint, Codex reran the complete relevant suites: 355
frontend, 190 cloud, 364 audio-engine and 17 diagnostic cases passed (926 total).
Seven disposable-PostgreSQL cases stayed skipped. Native/hosted frontend builds,
cloud type check and full Windows Debug/Release builds passed; the Windows builds
had zero warnings/errors. Separate Release output preserved the running app.
The usual frontend size advisory remains. No new manual acceptance was performed.

This publication is a source checkpoint rather than an automatic deployment,
database migration, merge to `main`, paid-service activation or release sign-off.
