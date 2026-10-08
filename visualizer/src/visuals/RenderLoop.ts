export interface FrameScheduler {
  requestFrame(callback: (timestamp: number) => void): number;
  cancelFrame(handle: number): void;
}

const MAX_DELTA_SECONDS = 0.1;

// Drives one outstanding frame callback at a time through an injected scheduler.
// Each scheduled callback carries a generation token so cancelled or dequeued callbacks are ignored.
export class RenderLoop {
  private running = false;
  private hidden = false;
  private disposed = false;
  private failed = false;
  private handle: number | null = null;
  private generation = 0;
  private lastTimestamp: number | null = null;

  constructor(
    private readonly scheduler: FrameScheduler,
    private readonly onFrame: (timestamp: number, deltaSeconds: number) => void,
    private readonly onReset: () => void,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.disposed || this.failed || this.running) return;
    this.running = true;
    this.lastTimestamp = null;
    this.schedule();
  }

  setHidden(hidden: boolean): void {
    if (this.disposed || this.failed || hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.cancel();
      return;
    }
    if (!this.running) return;
    this.restart();
  }

  reset(): void {
    if (this.disposed || this.failed) return;
    this.restart();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.cancel();
  }

  private restart(): void {
    this.cancel();
    this.lastTimestamp = null;
    try {
      this.onReset();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.running || this.hidden || this.disposed || this.failed || this.handle !== null) return;
    const generation = ++this.generation;
    this.handle = this.scheduler.requestFrame((timestamp) => this.tick(generation, timestamp));
  }

  private cancel(): void {
    this.generation += 1;
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    this.scheduler.cancelFrame(handle);
  }

  private tick(generation: number, timestamp: number): void {
    if (generation !== this.generation || !this.running || this.hidden || this.disposed || this.failed) return;
    this.handle = null;

    const delta = this.lastTimestamp === null ? 0 : (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;

    try {
      this.onFrame(timestamp, Number.isFinite(delta) && delta > 0 ? Math.min(delta, MAX_DELTA_SECONDS) : 0);
    } catch (error) {
      this.fail(error);
      return;
    }
    // onFrame may have reset, hidden, or disposed the loop; schedule() is a no-op in those cases.
    this.schedule();
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.running = false;
    this.cancel();
    this.onError?.(error);
  }
}
