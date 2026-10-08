# Hosted Synesthesia Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved Vercel/Windows-companion application and a personal, feature-driven 3D bronze-wave/rain/glass theme.

**Architecture:** Local Windows capture/DSP produces AudioFrame data without sending raw audio to the cloud. Vercel serves the existing Vite frontend and optional authenticated background integrations. Three.js renders a normalized VisualState on the user's machine.

**Tech Stack:** Existing .NET 10/WPF/WebView2, Vite/TypeScript/Three.js/Vitest, Vercel Node functions, Marketplace-managed Neon Postgres, Better Auth with Spotify.

**Spec:** `docs/superpowers/specs/2026-10-07-hosted-synesthesia-design.md` — approved 2026-10-07.

## Global Constraints

- Raw audio is not uploaded to Vercel.
- Personal pitch colors remain the default. Mood palettes remain explicitly opt-in.
- Guitar and melody often occupy the same frequencies. These drivers are feature-driven approximations, not isolated instrument detection.
- External I/O, database access, and unbounded work remain outside capture/DSP callbacks.
- Build every affected project and run focused plus full relevant tests at each milestone.
- Claude Code authors most product code and tests and performs first-pass self-review; Codex owns the plans, independent high-risk reviews, verification, and report. Do not substitute a Codex implementer/subagent without discussing the change with the user.
- Preserve `outputs/`, `data/`, existing secrets/account stores, and unrelated edits. Never read or send those to Claude. Do not erase legacy credentials during migration.
- No automatic commits, pushes, public release, paid-plan upgrades, or secret-value inspection. Review scoped diffs and propose commits; deployment of the requested pilot follows the release checks below.

October 8 update: the user authorized temporary Codex takeover while Claude Pro
is capped, then approved one 6:40 a.m. Eastern subscription check/resume. Return
most remaining coding/self-review to Claude after reset; Codex keeps planning,
verification and high-risk review. Leave at least 50% of the shared five-hour
Codex allowance unused (stop coding/review at 45% used for headroom), without
credit resets/purchases. Keep the Windows app closed. This author update does
not relax privacy, preservation, billing, publication or manual-acceptance gates.

## Review Focus

### October 8 latest authority and publication checkpoint

The human subsequently revoked the Codex usage reserve, permitted opening the
Windows app, deferred user testing, and authorized temporary Codex backend/
visual implementation. The updated neutral static pilot is deployed; backend
functions and real database/auth/owner/palette gates remain open. The latest
explicit request authorizes committing and pushing project source to GitHub,
including updated README and AI prompt log. This supersedes the earlier
no-commit/no-push restriction for this checkpoint only. It does not authorize
merging to main, secret/private-profile publication, paid activation, owner
database migrations or an automatic backend promotion. Preserve the original
checkout and unrelated outputs. Historical closed-app/reserve/source-not-started
statements below are not the latest state; consult dated verification documents.

- Capture faults with Spotify still alive: the recovery plan's monitor tests must prove bounded recovery.
- A malicious site or an expired/replayed pairing challenge: companion-plan Tasks 2–3 must reject access before sending frames.
- Damaged/imported profiles or full storage: companion-plan Task 4 must preserve old bytes and user colors.
- Concurrent cloud requests, account mismatch, or missing configuration: cloud-plan Tasks 1–4 must fail closed without affecting live audio.
- Overlapping instruments, low-confidence pitch, GPU loss, or reduced motion: spatial-plan Tasks 2–4 must remain honest, bounded, and usable.

---

## Three independently reviewable plans

1. `2026-10-07-companion-foundations.md`: capture recovery, origin/authentication policy, companion pairing, profile backup/export/import, and desktop composition. Produces a secure local application without requiring cloud services.
2. `2026-10-07-cloud-services.md`: Vercel configuration, provisioned durable storage, Spotify sign-in, bounded provider integrations, usage limits, and hosted browser integration. Depends on the secure companion, not on the new renderer.
3. `2026-10-07-spatial-theme.md`: renderer boundary, personal theme storage, feature mapping, pooled 3D geometry, calibration, and hardware/visual verification. Reuses the same local contracts and may be developed/tested locally once the companion prerequisites pass; cloud failures are never renderer prerequisites.

The older `2026-10-07-capture-recovery.md` remains the detailed capture leaf plan. Its desktop-only service-ownership statement describes the old guide; this approved design governs the new cloud split. Its no-unrelated-edits, callback safety, verification, and no-automatic-commit restrictions still apply.

## Execution and review contract

- [x] Record the plan review before product changes. The execution method is already selected: Claude Code implementation and first-pass self-review with Codex planning and high-risk review. User confirmed this on 2026-10-07.
- [x] At execution time, inspect attached worktrees and the current Git state. Native managed worktree created on branch `codex/hosted-synesthesia`; approved documents copied, original checkout preserved.
- [x] Establish baseline builds/tests before requesting the first product patch. Debug build and 166 baseline tests passed. Three pre-existing frontend dependency audit findings are tracked in the execution ledger before hosting.
- [ ] Give Claude one task at a time, its exact file allowlist, the relevant design/plan, and the required tests. Require tests first. Do not authorize secrets, deployments, shell startup changes, commits, pushes, or unrelated refactors.
- [ ] Prefer Claude-authored patch output from a read-only, source-scoped session. Codex applies patches using `apply_patch`, runs the failing test, requests the minimal implementation patch, and reviews it. If direct Claude workspace edits are needed, establish equally narrow tool permissions before using that method.
- [ ] Claude checks each diff against the task and self-reviews its tests and implementation. Codex runs focused verification and independently examines security, capture lifecycle, palette preservation, and resource bounds at milestone gates; it need not duplicate a full review after every small patch.
- [ ] If a substantive plan change is required, stop that task, explain the evidence, and amend the plan before resuming. Do not silently introduce instrument separation, a UI-framework rewrite, cloud audio uploads, profile synchronization, or another paid service.

## Release checklist

- [ ] Run `./Build.ps1 -Configuration Debug` and `./Build.ps1 -Configuration Release` from the repository root.
- [ ] Run `dotnet test SpotifySynesthesia.sln -c Release --no-build`, `npm --prefix visualizer test`, and the cloud plan's root test/type-check commands.
- [ ] Record actual Spotify capture, Spotify-vs-browser isolation, target exit/restart, output-device change, sleep/resume, shutdown/port cleanup, and offline desktop behavior. Do not mark unperformed checks passed.
- [ ] Verify the actual HTTPS hosted page connects to the companion in current Windows Chrome and Edge without security-disabled flags. Record browser versions, any permissions, denial behavior, and fallback.
- [ ] Play “back to friends” by sombr with the user. Record which effects fit, which do not, and tuning changes; a synthetic fixture or screenshot does not prove timing or synesthetic accuracy.
- [ ] Verify the owner's server configuration, Spotify callback and pilot allowlist, database isolation, provider limits, and frontend bundle secret checks. Missing owner credentials prevent a complete enriched deployment, not continued local rendering.
- [ ] Deploy a preview from the reviewed state, check routes/login/pairing/provider-failure behavior, and record the URL/commit. Promote the tested pilot to production only after required checks pass; do not deploy the entire workspace or unrelated outputs.

## Self-review

The three plans divide independent deliverables while retaining explicit dependency contracts. Shared constraints cover all approved requirements, and each review-focus item has named tests in its owning plan. Deployment account setup and secret entry are operational checkpoints, not permission for Claude to read credentials. Product implementation has not begun.
