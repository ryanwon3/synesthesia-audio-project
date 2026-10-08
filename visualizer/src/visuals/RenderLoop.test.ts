import { describe, expect, it, vi } from "vitest";
import { RenderLoop, type FrameScheduler } from "./RenderLoop";

const FRAME_MS = 1000 / 60;

// Deterministic stand-in for requestAnimationFrame. Handles start at 0 like a valid browser handle.
class FakeScheduler implements FrameScheduler {
  readonly cancelled: number[] = [];
  private nextHandle = 0;
  private readonly pending = new Map<number, (timestamp: number) => void>();
  private readonly issued = new Map<number, (timestamp: number) => void>();

  requestFrame(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    this.issued.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.cancelled.push(handle);
    this.pending.delete(handle);
  }

  pendingHandles(): number[] {
    return [...this.pending.keys()];
  }

  // Runs every callback pending at this instant, as one browser frame would.
  frame(timestamp: number): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) callback(timestamp);
  }

  // A callback the browser had already dequeued when cancelFrame arrived.
  invokeStale(handle: number, timestamp: number): void {
    this.issued.get(handle)?.(timestamp);
  }
}

function harness() {
  const scheduler = new FakeScheduler();
  const frames: Array<{ timestamp: number; delta: number }> = [];
  let resets = 0;
  const loop = new RenderLoop(
    scheduler,
    (timestamp, delta) => frames.push({ timestamp, delta }),
    () => { resets += 1; },
  );
  return { scheduler, frames, loop, resets: () => resets };
}

describe("RenderLoop", () => {
  it("keeps exactly one pending frame and forwards bounded deltas", () => {
    const { scheduler, frames, loop } = harness();

    loop.start();
    loop.start();
    expect(scheduler.pendingHandles()).toEqual([0]);

    scheduler.frame(1000);
    expect(scheduler.pendingHandles()).toHaveLength(1);
    scheduler.frame(1000 + FRAME_MS);
    expect(scheduler.pendingHandles()).toHaveLength(1);
    scheduler.frame(5000);
    expect(scheduler.pendingHandles()).toHaveLength(1);

    expect(frames.map((frame) => frame.timestamp)).toEqual([1000, 1000 + FRAME_MS, 5000]);
    expect(frames[0].delta).toBe(0);
    expect(frames[1].delta).toBeCloseTo(1 / 60, 9);
    expect(Number.isFinite(frames[2].delta)).toBe(true);
    expect(frames[2].delta).toBeGreaterThan(0);
    expect(frames[2].delta).toBeLessThanOrEqual(0.1);
  });

  it("stops while hidden and resumes once from a fresh timing baseline", () => {
    const { scheduler, frames, loop, resets } = harness();

    loop.start();
    loop.setHidden(true);
    expect(scheduler.cancelled).toEqual([0]);
    expect(scheduler.pendingHandles()).toEqual([]);

    scheduler.invokeStale(0, 1000);
    loop.start();
    loop.setHidden(true);
    expect(frames).toEqual([]);
    expect(scheduler.pendingHandles()).toEqual([]);
    expect(resets()).toBe(0);

    loop.setHidden(false);
    loop.setHidden(false);
    expect(resets()).toBe(1);
    expect(scheduler.pendingHandles()).toHaveLength(1);

    scheduler.frame(600_000);
    scheduler.frame(600_000 + FRAME_MS);
    expect(frames.map((frame) => frame.delta)).toEqual([0, expect.closeTo(1 / 60, 9)]);
  });

  it("reset notifies once, guards the old callback, and does not catch up", () => {
    const { scheduler, frames, loop, resets } = harness();

    loop.start();
    scheduler.frame(1000);
    const [before] = scheduler.pendingHandles();

    loop.reset();
    expect(resets()).toBe(1);
    expect(scheduler.cancelled).toContain(before);
    const after = scheduler.pendingHandles();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before);

    scheduler.invokeStale(before, 1000 + FRAME_MS);
    expect(frames).toHaveLength(1);
    expect(scheduler.pendingHandles()).toEqual(after);

    scheduler.frame(90_000);
    scheduler.frame(90_000 + FRAME_MS);
    expect(frames.slice(1).map((frame) => frame.delta)).toEqual([0, expect.closeTo(1 / 60, 9)]);
  });

  it("disposes idempotently and stops scheduling after a render error", () => {
    const { scheduler, frames, loop, resets } = harness();
    loop.start();
    scheduler.frame(1000);
    expect(scheduler.pendingHandles()).toHaveLength(1);
    const [pending] = scheduler.pendingHandles();

    loop.dispose();
    loop.dispose();
    expect(scheduler.cancelled).toEqual([pending]);

    loop.start();
    loop.setHidden(true);
    loop.setHidden(false);
    loop.reset();
    scheduler.invokeStale(pending, 2000);
    expect(scheduler.pendingHandles()).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(resets()).toBe(0);

    const failing = new FakeScheduler();
    const error = new Error("render failed");
    const onError = vi.fn();
    const broken = new RenderLoop(failing, () => { throw error; }, () => {}, onError);

    broken.start();
    expect(() => failing.frame(1000)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
    expect(failing.pendingHandles()).toEqual([]);

    failing.invokeStale(0, 1000 + FRAME_MS);
    failing.frame(1000 + FRAME_MS);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
