# Personal Spatial Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight 3D black environment with warm horizontal bronze waves, bass-driven rain, and falling translucent glass tiles, calibrated against the user's “back to friends” reference.

**Architecture:** Keep the existing painting behind a small renderer interface. A feature-driven spatial mapping produces a normalized, bounded addition to VisualState; the renderer receives no AudioFrame, provider response, or account state. Separate wave/rain/glass layers share pooled simulation data and user-owned theme settings.

**Tech Stack:** Existing Three.js/WebGL, TypeScript/Vitest, Vite shaders, existing controlled visual preview page; no new UI framework or source-separation runtime.

**Spec:** `docs/superpowers/specs/2026-10-07-hosted-synesthesia-design.md`; shared rollout constraints in `2026-10-07-hosted-synesthesia-rollout.md`.

## Global Constraints

- Personal pitch colors remain the default. Mood palettes remain explicitly opt-in.
- Guitar and melody often occupy the same frequencies. These drivers are feature-driven approximations, not isolated instrument detection.
- Increasing clarity should preserve the subtle warmth of the bronze guitar layer rather than simply making every effect bright or intense.
- The result remains an evolving abstract environment, not a waveform, equalizer, spectrum, or analytics screen.
- Do not blindly normalize FFT bands by bin count or replace bass/treble pitch colors based on the consultation alone.
- Keep the existing painting as fallback/comparison. Cloud failures must not control rendering or live attacks.
- Claude authors code/tests; Codex reviews and verifies. Changes require the foundation profile-preservation boundary; no automatic commits or unrelated refactors.

## Review Focus

- A v1 profile or imported song theme: Task 1 preserves every existing color/response and rejects invalid new settings without erasing the backup.
- Bass/mid overlap or noisy/low-confidence chroma: Task 2 bounds feature-driven emissions and never claims independent guitar/lead detection.
- Silence, stale frames, or repeated sustained attack values: Tasks 2–3 decay/retire effects instead of continuously spawning objects.
- Large resize/DPR, reduced motion, tab suspension, and context loss: Tasks 3–4 keep resources bounded and restore or explain failure.
- A song change or late AI context: Tasks 1–2 keep user overrides separate and prevent semantics from swapping musical roles.

---

## File boundaries

- `visualizer/src/visuals/VisualRenderer.ts`, `RendererFactory.ts`: common lifecycle and safe mode selection.
- `visualizer/src/profiles/SpatialProfile.ts`, `SpatialProfile.test.ts`: versioned optional spatial preferences and song-specific overrides; existing pitch/profile storage remains the owner.
- `visualizer/src/mappings/SpatialVisualState.ts`, `SpatialContextEngine.ts`, `SpatialContextEngine.test.ts`: normalized feature-driven state and causality tests.
- `visualizer/src/visuals/spatial/SceneDynamics.ts`, `SceneDynamics.test.ts`, `SpatialEnvironment.ts`, `BronzeWaveLayer.ts`, `RainLayer.ts`, `GlassLayer.ts`, `SpatialQuality.ts`: pooled simulation, rendering, and finite quality limits.
- `visualizer/src/shaders/spatial-waves.vert.glsl`, `spatial-waves.frag.glsl`, `spatial-glass.vert.glsl`, `spatial-glass.frag.glsl`: stylized geometry/material shaders; not a feedback-only painting.
- Existing `VisualState.ts`, `VisualContextEngine.ts`, `EvolvingPainting.ts`, `main.ts`, `CalibrationPanel.ts`, and `verification/visualPreview.ts`: integration points, not a wholesale rewrite.

Representative assertion contracts for the named tests below:

```ts
const profile = defaultSynesthesiaProfile();
const originalColors = structuredClone(profile.pitchColors);
expect(resolveSpatialTheme(profile, null, "bronze-rain-glass").id).toBe("bronze-rain-glass");
expect(profile.pitchColors).toEqual(originalColors);
const dynamics = new SceneDynamics({maxRain: 96, maxGlass: 128});
const first = dynamics.update(quietSpatialState, 1 / 60);
const rainBuffer = first.rainPositions;
const glassBuffer = first.glassPositions;
for (let i = 0; i < 36000; i++) {
  const next = dynamics.update(quietSpatialState, 1 / 60);
  expect(next.rainPositions).toBe(rainBuffer);
  expect(next.glassPositions).toBe(glassBuffer);
  expect(next.rainCount).toBeLessThanOrEqual(96);
  expect(next.glassCount).toBeLessThanOrEqual(128);
}
```

Use active synthetic impulses in the named saturation/lifetime tests as well;
the reuse test above does not prove visible quality or GPU behavior.

### Task 1: Renderer contract and personal theme ownership

**Files:** Create VisualRenderer/RendererFactory and SpatialProfile files/tests; modify `EvolvingPainting.ts`, `main.ts`, `SynesthesiaProfile.ts`, `ProfileStore.ts`, `ProfileTransfer.ts`, and profile/transfer tests from the foundation plan.

**Interfaces:**

- `VisualRenderer { render(state: VisualState, deltaSeconds: number): void; resize(): void; dispose(): void }`; `createVisualRenderer(canvas: HTMLCanvasElement, mode: "painting" | "spatial", options: RenderOptions): VisualRenderer`. Define `RenderOptions {reducedMotion: boolean; onFailure: (message: string) => void}`.
- Optional `SynesthesiaProfile.spatial: SpatialPreferences` with `schemaVersion: 1`, `mode: "painting" | "spatial"`, numeric controls `waveStrength`, `rainStrength`, `glassStrength`, `fallSpeed`, `waveScale`, `rainPersistence`, `depth`, and `songOverrides: SongThemeOverride[]` (maximum 32). Controls are finite 0–1 normalized values; legacy outer schema/version and all existing fields remain unchanged.
- `SongThemeOverride {match: {spotifyTrackId: string | null; title: string; artist: string}; themeId: "bronze-rain-glass"; waveColor: string}`. `resolveSpatialTheme(profile: SynesthesiaProfile, track: CurrentTrack | null, manualTheme: "personal" | "bronze-rain-glass" | null): ResolvedSpatialTheme` prioritizes explicit manual selection, then an exact local song override, then personal mode; generated context never selects this theme. A saved track ID wins over title/artist matching; normalized exact title+artist is a fallback, never a guessed Spotify ID.
- `ResolvedSpatialTheme {id: "personal" | "bronze-rain-glass"; background: RgbColor; waveColorOverride: RgbColor | null}`. Personal mode uses existing pitch colors; only an explicit bronze theme/override supplies a different wave color.

- [ ] Write failing `legacyProfileRetainsAllValues`, `themeDoesNotMutatePitchColors`, `exactSongOverrideWins`, `unknownSongDoesNotInheritOverride`, and `invalidSpatialImportPreservesBackup`. Test the title/artist reference with synthetic identity, not an invented real track ID.
- [ ] Run `npm --prefix visualizer test -- SpatialProfile.test.ts`; expect failures before new helpers exist.
- [ ] Implement optional spatial defaults and validation without rewriting v1 pitch/response settings. Extend safe import/export/backup to include new settings; retain one profile storage transaction boundary. Unknown theme IDs, oversized overrides/names, malformed colors, and invalid control values are rejected.
- [ ] Offer “Bronze waves · rain · glass” as a user-selected preset. Starting wave-color suggestion is `#b88654`, adjustable in calibration; it is a starting tint, not a claim about the exact bronze the user experiences. Background for that preset is `#000000`. Save the confirmed “back to friends”/“sombr” association locally only when selected; do not make every user's account inherit it automatically.
- [ ] Implement the renderer interface for EvolvingPainting and route main's render/resize/dispose calls through it. Keep the painting selected for legacy settings until the new spatial mode exists and passes verification. RendererFactory initially rejects unavailable spatial mode safely; no empty renderer pretending to work.
- [ ] Run profile/transfer/mapping tests and frontend build. Codex reviews backward compatibility, override scope, lifecycle, and public-default/private-profile separation. Proposed commit: `refactor(visuals): add renderer and personal theme boundaries`.

### Task 2: Honest and distinguishable feature mapping

**Files:** Create SpatialVisualState/SpatialContextEngine and tests; modify `mappings/VisualState.ts`, `VisualContextEngine.ts`, and mapping tests. No DSP/protocol change is included.

**Interfaces:**

- `SpatialVisualState` has `themeId`, `background`, `waves: {energy, softness, scale, color}`, `rain: {energy, impulse, persistence, color}`, `glass: {energy, impulse, fallSpeed, opacity, color}`, plus normalized `depth`, `stereoBalance`, and `stereoWidth`. Scalars are finite 0–1; colors are finite RGB tuples. Export `quietSpatialState: SpatialVisualState` with zero energy/impulses, personal theme, and finite neutral geometry/material settings.
- Add optional `VisualState.spatial?: SpatialVisualState` for compatibility. `SpatialContextEngine.update(frame: AudioFrame, mapped: VisualState, preferences: SpatialPreferences, theme: ResolvedSpatialTheme, deltaSeconds: number): SpatialVisualState`; its mutable history is private. Invoke it in VisualContextEngine with the existing layer colors and user-owned resolved theme, then return the normalized state.

- [ ] Write failing `bassAttackDrivesRainNotWaves`, `sustainedMidEnergyDrivesWaves`, `harmonicChangeDrivesGlassApproximation`, `lowConfidenceDoesNotEmitGlass`, and `contextCannotExchangeFamilies`. Assert rain uses bass inputs, waves use sustained mids, glass uses confidence-gated mid/harmonic change rather than a false treble=melody mapping, and AI mood never exchanges these roles.
- [ ] Add `silenceAndStaleInputDecay`, `sustainedAttackDoesNotRetriggerEveryFrame`, `rejectsNonFiniteControls`, and `explicitBronzeOnlyOverridesWaveColor`. Assert all returned values are finite/bounded and personal colors/other-song settings are unchanged.
- [ ] Run `npm --prefix visualizer test -- SpatialContextEngine.test.ts`; expect failure before mapping implementation.
- [ ] Implement waves from sustained mid energy, rain impulse from bass band attack (fallback: onset*low energy), and glass impulse from confidence-gated changes of harmonic/chroma content plus mid attack. Use the current mapped layer colors; do not replace treble/bass colors with another band's pitch estimate. Document these as feature-driven associations, not instrument/stem separation.
- [ ] Keep trigger parameters in a small exported defaults/config record: confidence gate 0.2, chroma L1 change threshold 0.25, rain minimum impulse 0.2, and refractory periods rain=0.12 s/glass=0.16 s. Reset/suspend trigger history on silence or source/session change, use rising/rearmed attacks, and prevent a constant large attack from spawning every render frame. These are starting calibration values, not DSP accuracy claims.
- [ ] Context may slowly modulate softness/persistence/contrast within bounds, but cannot change family identity or drive live impulses. Preserve painting behavior while making spatial mapping independent of the five old contextual effect weights. Clamp delta 0–0.1 s and honor the existing 500 ms stale-audio handling in main.
- [ ] Run all mapping, profile, AudioFrame, and song tests plus the production build. Codex reviews the feature dependencies and checks there is no renderer/provider coupling or untested FFT recalibration. Proposed commit: `feat(visuals): map distinct spatial musical cues`.

### Task 3: Pooled 3D black environment

**Files:** Create the spatial simulation/render/quality modules and shaders listed above; add `RendererFactory.test.ts`; modify RendererFactory to support spatial creation, fallback, and failure reporting.

**Interfaces:** `SceneDynamics(options: {maxRain: number; maxGlass: number})`; `update(state: SpatialVisualState, deltaSeconds: number): SceneSnapshot`; `clear(): void`. `SceneSnapshot` exposes `rainCount`, `glassCount`, and reusable Float32Array buffers `rainPositions`, `rainScales`, `rainAges`, `glassPositions`, `glassScales`, and `glassAges`, not new object graphs each frame. `SpatialEnvironment implements VisualRenderer`; each layer supplies `update(snapshot: SceneSnapshot, state: SpatialVisualState): void` and `dispose(): void`.

- [ ] Write failing `poolCountsNeverExceedCapacity`, `silenceRetiresEveryParticle`, `hugeOrNegativeDeltaStaysFinite`, `clearRemovesPreviousSongTrails`, and `noAllocationGrowthOverTenMinutes` simulation tests. Hold references to output buffers across updates to assert reuse, and use seeded randomness/time for deterministic tests.
- [ ] Run `npm --prefix visualizer test -- SceneDynamics.test.ts`; expect failure before simulation exists.
- [ ] Implement bounded pools with standard starting quality limits: 96 rain objects, 128 glass tiles, 3 horizontal wave surfaces, and DPR cap 1.5. Low quality uses 48 rain/64 glass/DPR 1; mode selection is explicit or based on measured performance, not device identity. Put limits in SpatialQuality, not personal DSP logic.
- [ ] Implement a perspective camera (initial field of view 45 degrees), actual depth-separated geometry, black background, subtle depth fog, and a stable viewpoint. Keep near/far placement and gentle motion adjustable through normalized depth; no mandatory camera orbit or dramatic movement.
- [ ] Build continuous horizontal bronze/pitch-colored surfaces in BronzeWaveLayer using independent geometry/phase and slow deformation. They are abstract waves, not sampled waveform plots or a spectrum. The user-selected bronze tint applies only to the theme's wave layer.
- [ ] Build RainLayer from bass-triggered droplets/expanding impact forms using pooled instances. Bass energy affects weight/extent; attacks initiate events. Keep impacts visually distinguishable on black without all-over additive glow or fixed frequency bars.
- [ ] Build GlassLayer as thin falling tiles with translucent faces, defined edges, and modest rotation at different depths. Use stylized inexpensive material shading rather than promising physically accurate refraction. Handle transparency/depth ordering deliberately; assess overlap artifacts in the visual harness. Geometry/material/buffer resources are allocated on setup and disposed on teardown.
- [ ] Add factory tests with injected renderer constructors: `failedSpatialCreationDisposesBeforeFallback`, `modeSwitchDisposesExactlyOnce`, and `noWebGlReportsUnsupported`. If fallback needs a fresh rendering surface, replace/reset it safely; do not claim the WebGL painting can work during total WebGL loss. Context loss pauses rendering; restoration rebuilds cleanly or shows the existing unsupported state.
- [ ] Run simulation/factory/full frontend tests and build. Open the real controlled preview, inspect depth/transparency/black contrast, resize repeatedly, switch modes, and check memory/renderer resource counters. Unit tests do not prove appearance. Codex reviews shader inputs, resource cleanup, quality bounds, and absence of service/raw-audio dependencies. Proposed commit: `feat(visuals): render pooled waves rain and glass in 3D`.

### Task 4: Calibration, motion preferences, and playback acceptance

**Files:** Modify `ui/CalibrationPanel.ts`, `styles.css`, `main.ts`, `visuals/VisualRenderer.ts`, `visuals/EvolvingPainting.ts`, `visuals/RipplePool.ts`, `visuals/spatial/SpatialEnvironment.ts`, `verification.html`, and `verification/visualPreview.ts`; create `visualizer/src/ui/SpatialControls.test.ts`; update `docs/song-aware-visuals.md` and add `docs/spatial-verification.md` after checks.

**Interfaces:** Add `setLayerPreview(layer: "all" | "waves" | "rain" | "glass"): void` and `setReducedMotion(enabled: boolean): void` to VisualRenderer, implemented by both renderers. Preview is a presentation filter, not a change to captured audio; the legacy painting uses its nearest band/layer approximation and clearly labels that limitation. RenderOptions carries the initial motion preference. Add `RipplePool.clear(): void` to clear residual painting previews without allocation. Calibration updates the existing safe ProfileStore and normalized controls.

- [ ] Write failing `calibrationExplainsFeatureApproximation`, `soloLayerDoesNotMutateProfileOrAudio`, `cancelledResetPreservesTheme`, `reducedMotionRemovesCameraDriftAndSlowsFalling`, and `hiddenTabResumeDoesNotEmitCatchUpBurst`. Assert exact user-facing driver labels: “Sustained mids → waves”, “Low attacks → rain”, and “Harmonic changes → glass · melodic approximation”.
- [ ] Run `npm --prefix visualizer test -- SpatialControls.test.ts`; expect failing assertions before UI/lifecycle wiring.
- [ ] Add painting/spatial mode selection, the personal preset/override controls, per-family intensity, fall speed, wave scale, persistence, depth, and preview/solo buttons. Defaults keep controls hidden during playback; keyboard/focus and escape/cancel behavior remain usable. Selecting an unrelated song must not inherit the bronze override.
- [ ] Honor `prefers-reduced-motion` and an explicit user override: remove camera drift, reduce fall/impact motion and trails, avoid full-screen flashes, and retain recognizable static/slow forms. Pause simulation/requestAnimationFrame work for hidden pages, reset the timing/trigger baseline on resume, and avoid catch-up emissions.
- [ ] Extend the development-only visual harness with silence, bass pulse, sustained mids, harmonic-change, treble-only, stereo, malformed/stale input, all-family mix, and song-switch scenarios. Keep it out of production entry points; do not use fixtures as substitutes for live Spotify acceptance.
- [ ] Run full frontend suites/build and both solution builds if desktop packaging changes. Manually check WebView2 plus current Windows Chrome/Edge, normal/low quality, fullscreen/resize, mode switches, reduced motion, context loss/restoration, and a ten-minute playback session. Record actual median/p95 frame times and resource trends; target 60 fps with a usable 30 fps low-quality path, but do not claim those rates without measurement.
- [ ] Play “back to friends” by sombr with the user and tune bronze warmth, horizontal wave feel, rain weight/persistence, tile fall/translucency/depth, and overall clarity. Confirm personal colors remain unchanged. Record overlap limitations honestly and request a separate design if exact instrument isolation is required.
- [ ] Codex reviews the full visual diff and all evidence. Keep legacy painting available; make spatial mode the user's selected main mode only after it meets the playback acceptance check. Proposed commit: `feat(calibration): tune personal spatial music theme`.

## Self-review

Renderer inputs remain normalized; only the mapping layer sees audio/context. The wave/rain/glass drivers are explicitly distinct where current features permit, and overlapping harmonic inputs are described as approximations. Optional versioned spatial fields travel through the existing single-profile backup/transfer boundary. Tests cover all five Review Focus items; GPU, timing, and synesthetic acceptance remain required manual evidence, not inferred from those tests.
