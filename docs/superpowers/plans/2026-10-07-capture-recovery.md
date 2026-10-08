# Automatic Capture Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restart process-loopback capture after an unexpected capture stop or fault while the target process remains alive, without creating a retry storm or changing the AudioFrame protocol, DSP, renderer, or personal pitch-color behavior.

**Architecture:** Put the reusable recovery loop in `audio-engine`, where capture ownership belongs. A small `IAudioCaptureSession` boundary lets the loop observe capture completion and remain unit-testable without Windows audio hardware; `AudioEngineRuntime` implements that boundary. The WPF desktop monitor and console Host become thin adapters that supply target discovery, process-liveness checks, and optional diagnostic logging.

**Tech Stack:** .NET 10, C# 14, WPF, xUnit v3, Windows process-loopback capture, PowerShell build orchestration

**Spec:** `AGENTS.md` and the outstanding real-audio checks in `docs/mvp-verification.md`

## Global Constraints

- `audio-engine` owns process-loopback capture, DSP, profile persistence, integrations, and the localhost server; `desktop` owns only WPF/WebView2 lifecycle composition.
- The capture callback must not perform external I/O, logging, database access, or unpredictable-cost work. A capture-stop handler may only signal a waiting background task.
- The normalized `AudioFrame` protocol and localhost WebSocket contract remain unchanged.
- `tools/TestTonePlayer` stays independent from production capture and rendering code.
- External enrichment must remain optional; local audio recovery cannot depend on Spotify Web API, Last.fm, lyrics, OpenAI, or SQLite.
- Do not touch the user's pitch-color mapping, mood mode, calibration storage, song overrides, DSP mapping, or renderer behavior in this change.
- Preserve the existing untracked `outputs/` directory and all unrelated user changes.
- Do not claim Spotify isolation, audio-device recovery, sleep/resume behavior, audible output, timing, or visual quality unless the corresponding manual check is performed and recorded.
- Claude Code performs the implementation; Codex reviews every task's diff and verification evidence before the next task proceeds.
- Do not create commits unless the user separately authorizes committing; each task includes a proposed commit message for later use.

## Review Focus

- A stop/fault raised synchronously during `StartCaptureAsync` must not be missed; Task 1 adds `DoesNotMissCaptureStoppedRaisedDuringStart`.
- A stale stop event for a different PID must not terminate the active session; Task 1 adds `IgnoresCaptureStoppedForDifferentProcess`.
- Repeated faults while the target remains alive must wait the configured restart backoff before starting again; Task 1 adds `RestartsAfterFaultUsingConfiguredBackoff`.
- Cancellation during active capture must unsubscribe handlers, stop capture exactly once, and start no replacement session; Task 1 adds `CancellationStopsCaptureWithoutRestart`.
- A target process that exits during capture must stop cleanly, then either wait for a replacement in name-based mode or return in fixed-PID mode; Task 1 adds both `WaitsForReplacementAfterTargetExit` and `ReturnsAfterFixedTargetExit`.

---

## File Structure

- Create `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/IAudioCaptureSession.cs`: minimal start/stop/state/event boundary used by the recovery monitor and its tests.
- Create `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessCaptureMonitor.cs`: reusable target discovery, session observation, bounded restart delay, cancellation, and status notifications.
- Modify `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/AudioEngineRuntime.cs`: implement `IAudioCaptureSession` and expose the underlying `CaptureStopped` event without adding work to the capture thread.
- Modify `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessTargetLocator.cs`: centralize the duplicated safe process-liveness check as `IsAlive(int processId)`.
- Create `tests/SpotifySynesthesia.AudioEngine.Tests/ProcessCaptureMonitorTests.cs`: hardware-independent fault, exit, backoff, PID filtering, and cancellation tests.
- Modify `desktop/SpotifySynesthesia.Desktop/SpotifyCaptureMonitor.cs`: replace its process-exit-only loop with the shared recovery monitor.
- Modify `audio-engine/host/SpotifySynesthesia.AudioEngine.Host/Program.cs`: use the same recovery monitor while retaining console heartbeat diagnostics and fixed-PID completion behavior.
- Modify `docs/mvp-verification.md` only after verification: record automated results and clearly separate performed manual checks from checks still outstanding.

### Task 1: Build and test the reusable recovery monitor

**Files:**
- Create: `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/IAudioCaptureSession.cs`
- Create: `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessCaptureMonitor.cs`
- Test: `tests/SpotifySynesthesia.AudioEngine.Tests/ProcessCaptureMonitorTests.cs`

**Interfaces:**
- Consumes: `ProcessLoopbackCaptureState`, `ProcessLoopbackCaptureStopped`, target PID resolvers, process-liveness probes, and cancellation tokens.
- Produces: `IAudioCaptureSession`; `ProcessCaptureMonitorOptions`; `ProcessCaptureMonitorEventKind`; `ProcessCaptureMonitorEvent`; and `ProcessCaptureMonitor.RunAsync(bool waitForTargetRestart, CancellationToken cancellationToken)`.

- [ ] **Step 1: Write the failing test fixture and fake capture session**

  Add `ProcessCaptureMonitorTests` with a private `FakeAudioCaptureSession : IAudioCaptureSession`. The fake records start/stop counts, exposes the number of `CaptureStopped` subscribers, and can raise `ProcessLoopbackCaptureStopped` either synchronously from `StartCaptureAsync` or when directed by a test. Add a fake delay delegate that records requested durations and returns a test-controlled task.

- [ ] **Step 2: Write `DoesNotMissCaptureStoppedRaisedDuringStart` and verify it fails**

  Configure PID `101` as alive and have the fake raise a stopped event for PID `101` from inside its first `StartCaptureAsync`. Allow a second start, then cancel. Assert two starts occurred and the event subscriber count returned to zero.

  Run:

  ```powershell
  dotnet test tests/SpotifySynesthesia.AudioEngine.Tests/SpotifySynesthesia.AudioEngine.Tests.csproj --filter FullyQualifiedName~ProcessCaptureMonitorTests.DoesNotMissCaptureStoppedRaisedDuringStart
  ```

  Expected: FAIL because the interface and monitor do not exist.

- [ ] **Step 3: Write the remaining failing recovery tests**

  Add tests with these exact behaviors:

  - `IgnoresCaptureStoppedForDifferentProcess`: an event for PID `202` does not end the active PID `101` session.
  - `RestartsAfterFaultUsingConfiguredBackoff`: a fault for live PID `101` produces a second start and records exactly one `RestartBackoff` delay before it.
  - `CancellationStopsCaptureWithoutRestart`: cancellation while PID `101` is active calls `StopCaptureAsync` once, removes the event handler, and leaves the start count at one.
  - `WaitsForReplacementAfterTargetExit`: name-based mode sees PID `101` exit, records `TargetSearchInterval`, then starts PID `303` returned by the resolver.
  - `ReturnsAfterFixedTargetExit`: fixed-PID mode returns after PID `101` exits and does not request another target.

- [ ] **Step 4: Create the capture-session boundary**

  In `IAudioCaptureSession.cs`, define:

  ```csharp
  public interface IAudioCaptureSession
  {
      event Action<ProcessLoopbackCaptureStopped>? CaptureStopped;
      ProcessLoopbackCaptureState CaptureState { get; }
      Task StartCaptureAsync(int processId, CancellationToken cancellationToken = default);
      Task StopCaptureAsync(CancellationToken cancellationToken = default);
  }
  ```

- [ ] **Step 5: Create the monitor's public types and validate options**

  In `ProcessCaptureMonitor.cs`, define:

  ```csharp
  public sealed record ProcessCaptureMonitorOptions(
      TimeSpan TargetSearchInterval,
      TimeSpan SessionPollInterval,
      TimeSpan RestartBackoff)
  {
      public static ProcessCaptureMonitorOptions Default { get; } =
          new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
  }

  public enum ProcessCaptureMonitorEventKind
  {
      WaitingForTarget,
      CaptureStarted,
      Heartbeat,
      TargetExited,
      CaptureStopped,
      Restarting,
  }

  public sealed record ProcessCaptureMonitorEvent(
      ProcessCaptureMonitorEventKind Kind,
      int? ProcessId,
      Exception? Error = null);
  ```

  Reject zero or negative option intervals with `ArgumentOutOfRangeException` in the monitor constructor.

- [ ] **Step 6: Implement the monitor constructor and execution contract**

  Implement this signature:

  ```csharp
  public sealed class ProcessCaptureMonitor
  {
      public ProcessCaptureMonitor(
          IAudioCaptureSession captureSession,
          Func<int?> resolveProcessId,
          Func<int, bool> isProcessAlive,
          ProcessCaptureMonitorOptions? options = null,
          Func<TimeSpan, CancellationToken, Task>? delayAsync = null);

      public event Action<ProcessCaptureMonitorEvent>? StatusChanged;

      public Task RunAsync(
          bool waitForTargetRestart,
          CancellationToken cancellationToken);
  }
  ```

  The implementation must subscribe to `CaptureStopped` before starting capture; filter events by the active PID; use a `TaskCompletionSource` with `RunContinuationsAsynchronously`; and ensure the capture-thread event handler does nothing except `TrySetResult`. Always unsubscribe in `finally`. Always stop an active/faulted session with `CancellationToken.None` before returning, retrying, or propagating cancellation.

- [ ] **Step 7: Implement target and restart behavior**

  When no target is available, emit `WaitingForTarget`; return immediately when `waitForTargetRestart` is false, otherwise await `TargetSearchInterval`. During capture, poll process liveness at `SessionPollInterval` and emit `Heartbeat` from the monitor task. On process exit, emit `TargetExited`; return in fixed-PID mode or resume target discovery in name-based mode. On an unexpected stop while the process is alive, emit `CaptureStopped`, await exactly `RestartBackoff`, emit `Restarting`, and start the target again. Cancellation must win over all retry paths.

- [ ] **Step 8: Run all focused monitor tests**

  Run:

  ```powershell
  dotnet test tests/SpotifySynesthesia.AudioEngine.Tests/SpotifySynesthesia.AudioEngine.Tests.csproj --filter FullyQualifiedName~ProcessCaptureMonitorTests
  ```

  Expected: all `ProcessCaptureMonitorTests` pass with no warnings.

- [ ] **Step 9: Review gate and proposed commit**

  Codex reviews the Task 1 diff for capture-thread safety, event unsubscription, cancellation races, and deterministic tests. After approval, the proposed commit is:

  ```text
  feat(audio): add testable capture recovery monitor
  ```

### Task 2: Adapt the production runtime and process locator

**Files:**
- Modify: `audio-engine/src/SpotifySynesthesia.AudioEngine/Server/AudioEngineRuntime.cs`
- Modify: `audio-engine/src/SpotifySynesthesia.AudioEngine/Capture/ProcessTargetLocator.cs`
- Test: `tests/SpotifySynesthesia.AudioEngine.Tests/ProcessCaptureMonitorTests.cs`

**Interfaces:**
- Consumes: `IAudioCaptureSession` and the existing private `ProcessLoopbackCapture` owned by `AudioEngineRuntime`.
- Produces: `AudioEngineRuntime : IAudioCaptureSession` and `ProcessTargetLocator.IsAlive(int processId)` for both application hosts.

- [ ] **Step 1: Add a failing event-forwarding test seam assertion**

  Extend the monitor fixture with a contract test that compiles only when the production `AudioEngineRuntime` is assignable to `IAudioCaptureSession`. Keep Windows audio activation out of this test; it verifies the public boundary, not hardware behavior.

- [ ] **Step 2: Implement `IAudioCaptureSession` on `AudioEngineRuntime`**

  Keep the existing `CaptureState`, `StartCaptureAsync`, and `StopCaptureAsync` members. Expose `CaptureStopped` with custom add/remove accessors that directly subscribe and unsubscribe handlers on `_capture.CaptureStopped`; do not add logging, allocations, dispatching, or async work to the capture event path.

- [ ] **Step 3: Centralize process liveness**

  Add:

  ```csharp
  public static bool IsAlive(int processId)
  ```

  to `ProcessTargetLocator`. Return false for an exited or already-removed PID; catch only the process-race/access exceptions already tolerated by `FindOldestExactMatch`.

- [ ] **Step 4: Run the focused tests and build `audio-engine`**

  Run:

  ```powershell
  dotnet test tests/SpotifySynesthesia.AudioEngine.Tests/SpotifySynesthesia.AudioEngine.Tests.csproj --filter FullyQualifiedName~ProcessCaptureMonitorTests
  dotnet build audio-engine/src/SpotifySynesthesia.AudioEngine/SpotifySynesthesia.AudioEngine.csproj -c Debug
  ```

  Expected: both commands succeed with zero warnings and zero errors.

- [ ] **Step 5: Review gate and proposed commit**

  Codex reviews the Task 2 diff for interface leakage, event lifetime, exception filtering, and unchanged real-time work. After approval, the proposed commit is:

  ```text
  refactor(audio): expose capture lifecycle for recovery
  ```

### Task 3: Use shared recovery in desktop and Host

**Files:**
- Modify: `desktop/SpotifySynesthesia.Desktop/SpotifyCaptureMonitor.cs`
- Modify: `audio-engine/host/SpotifySynesthesia.AudioEngine.Host/Program.cs`

**Interfaces:**
- Consumes: `ProcessCaptureMonitor`, `ProcessCaptureMonitorEvent`, `ProcessTargetLocator.FindOldestExactMatch`, and `ProcessTargetLocator.IsAlive` from Tasks 1–2.
- Produces: automatic restart for the WPF app and console Host without duplicated process-exit polling.

- [ ] **Step 1: Replace the WPF monitor loop**

  Keep `SpotifyCaptureMonitor` as the desktop lifecycle adapter. Construct one `ProcessCaptureMonitor` with:

  ```csharp
  () => ProcessTargetLocator.FindOldestExactMatch("Spotify")?.ProcessId
  ProcessTargetLocator.IsAlive
  ```

  Have `RunAsync` delegate to `monitor.RunAsync(waitForTargetRestart: true, cancellationToken)`. Remove the duplicated `WaitForExitAsync` and `IsAlive` methods. Do not add UI dispatch, logging, or WebView work.

- [ ] **Step 2: Replace the Host's session loop**

  Build the target resolver from `HostArguments`: a fixed PID resolver returns that PID only while it is alive; the name-based resolver calls `FindOldestExactMatch`. Call `RunAsync(waitForTargetRestart: !options.ProcessId.HasValue, cancellationToken)` so fixed-PID runs return after their target exits while process-name runs wait for a replacement.

- [ ] **Step 3: Preserve Host diagnostics through status events**

  Subscribe to `StatusChanged` on the Host's background control path. Log capture start, target exit, retry reason/backoff, and `AudioEngineRuntime.GetSnapshot()` for `Heartbeat`. Never subscribe a console-writing handler directly to `CaptureStopped` or `StateChanged`.

- [ ] **Step 4: Build all affected .NET projects**

  Run:

  ```powershell
  dotnet build audio-engine/host/SpotifySynesthesia.AudioEngine.Host/SpotifySynesthesia.AudioEngine.Host.csproj -c Debug
  dotnet build desktop/SpotifySynesthesia.Desktop/SpotifySynesthesia.Desktop.csproj -c Debug
  ```

  Expected: both projects build with zero warnings and zero errors.

- [ ] **Step 5: Review gate and proposed commit**

  Codex reviews the Task 3 diff for preserved shutdown behavior, fixed-PID behavior, bounded retries, background-only logging, and absence of DSP/protocol/profile changes. After approval, the proposed commit is:

  ```text
  fix(capture): recover sessions after unexpected stops
  ```

### Task 4: Full verification and honest manual-check record

**Files:**
- Modify after checks: `docs/mvp-verification.md`

**Interfaces:**
- Consumes: the complete Tasks 1–3 implementation.
- Produces: build/test evidence and an explicit record of performed versus outstanding real-world checks.

- [ ] **Step 1: Run the full Debug build**

  Run:

  ```powershell
  .\Build.ps1 -Configuration Debug
  ```

  Expected: Vite production build, NuGet restore, and every solution project build successfully.

- [ ] **Step 2: Run the full Release build**

  Run:

  ```powershell
  .\Build.ps1 -Configuration Release
  ```

  Expected: Vite production build, NuGet restore, and every solution project build successfully.

- [ ] **Step 3: Run the full relevant automated suites**

  Run:

  ```powershell
  dotnet test SpotifySynesthesia.sln -c Release --no-build
  npm --prefix visualizer test
  ```

  Expected: all .NET and Vitest tests pass; record exact counts rather than copying historical counts from documentation.

- [ ] **Step 4: Perform the hardware and lifecycle checks that automation cannot prove**

  Perform and record each check independently:

  1. Play a real Spotify song and confirm AudioFrame diagnostics and the painting respond.
  2. Play Spotify and a browser video together and confirm only Spotify drives the visualization.
  3. Switch the default output device during Spotify playback and confirm capture either continues or automatically restarts without restarting Spotify.
  4. Put Windows to sleep during playback, resume, and confirm capture recovers without restarting Spotify.
  5. Exit and restart Spotify and confirm name-based monitoring attaches to the replacement process.
  6. Run `tools/TestTonePlayer`, start the Host with `--pid`, and confirm a 440 Hz tone is captured; terminate the target and confirm the Host exits cleanly.
  7. Close the WPF app and confirm port 8765 is released and no app-owned WebView2 child remains.

  If any check is not performed, mark it **unverified**. If a device change or sleep does not cause WASAPI to report a stop/fault, record that observation instead of claiming the recovery path ran.

- [ ] **Step 5: Update verification documentation**

  Append the current date, exact automated commands/results, performed manual checks, failures, and remaining unverified behavior to `docs/mvp-verification.md`. Do not overwrite older evidence or describe historical results as current.

- [ ] **Step 6: Final Codex review**

  Codex reviews the full diff, confirms only planned files changed, checks `git diff --check`, verifies test/build outputs, and reports manual checks separately. Confirm `outputs/` remains untouched.

- [ ] **Step 7: Proposed documentation commit**

  After approval, the proposed commit is:

  ```text
  docs: record capture recovery verification
  ```

---

## Self-Review Results

- **Spec coverage:** The plan keeps capture ownership in `audio-engine`, keeps desktop as composition, protects the real-time callback, requires all affected builds/tests, and preserves honest manual-verification reporting. It intentionally excludes profile persistence and color-reset safety as a separate future plan.
- **Step scan:** Each implementation step names one interface, behavior, test, integration, or verification action. No task advances into metadata, renderer, installer, or profile work.
- **Type consistency:** Tasks 2–3 consume the exact interface, event, options, and monitor names produced by Task 1.
- **Review focus:** All five high-risk failure classes have named Task 1 tests.
- **Proportion:** The plan is longer than the small production change because it fixes concurrency and cancellation behavior that must be testable without Windows audio hardware; code bodies remain delegated to the implementer.
