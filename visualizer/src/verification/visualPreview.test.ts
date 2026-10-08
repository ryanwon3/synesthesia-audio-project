// @vitest-environment happy-dom
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import verificationHtml from "../../verification.html?raw";
import type { RenderOptions, VisualRenderer } from "../visuals/VisualRenderer";

// Only the GPU boundary is replaced; entry, factory, mapping and fixtures are real.
const gpu = vi.hoisted(() => {
  const state = { fail: new Set<string>(), attempts: [] as string[], created: [] as FakeRenderer[] };
  class FakeRenderer implements VisualRenderer {
    public renders = 0;
    public resizes = 0;
    public disposed = false;
    public loseContext = false;
    public readonly liveAtCreate: number;
    public constructor(public readonly kind: string, public readonly canvas: HTMLCanvasElement,
      public readonly options: RenderOptions, public readonly quality?: string) {
      state.attempts.push(kind);
      if (state.fail.has(kind)) throw new Error(`${kind} unavailable`);
      this.liveAtCreate = state.created.filter(r => !r.disposed).length;
      state.created.push(this);
    }
    public render(): void {
      this.renders++;
      if (this.loseContext) { this.loseContext = false; this.options.onFailure("WebGL context lost"); }
    }
    public resize(): void { this.resizes++; }
    public dispose(): void { this.disposed = true; }
    public setLayerPreview(): void {}
    public setReducedMotion(): void {}
    public clear(): void {}
  }
  return { state, FakeRenderer };
});
vi.mock("../visuals/spatial/SpatialEnvironment", () => ({
  SpatialEnvironment: class extends gpu.FakeRenderer {
    public constructor(canvas: HTMLCanvasElement, options: RenderOptions, quality?: string) { super("spatial", canvas, options, quality); }
  },
}));
vi.mock("../visuals/EvolvingPainting", () => ({
  EvolvingPainting: class extends gpu.FakeRenderer {
    public constructor(canvas: HTMLCanvasElement, options: RenderOptions) { super("painting", canvas, options); }
  },
}));

const FALLBACK = "The 3D scene could not start. Using the painting instead.";
const LOST = "WebGL context lost";
const clock = { now: 0, nextId: 1, queue: new Map<number, FrameRequestCallback>() };
let hidden = false;
const tracked: Array<[EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];

function step(ms = 16): void {
  clock.now += ms;
  const due = [...clock.queue.values()];
  clock.queue.clear();
  for (const callback of due) callback(clock.now);
}
function stepFor(ms: number): void {
  const end = clock.now + ms;
  while (clock.now < end) step();
}
function setHidden(value: boolean): void {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}
function select(id: string, value: string): void {
  const element = document.querySelector<HTMLSelectElement>(`#${id}`)!;
  element.value = value;
  element.dispatchEvent(new Event("change"));
}
const status = (): string => document.querySelector("#status")!.textContent ?? "";
const live = () => gpu.state.created.filter(r => !r.disposed);

async function boot() {
  const page = new DOMParser().parseFromString(verificationHtml, "text/html");
  page.querySelectorAll("script").forEach(script => script.remove());
  document.head.innerHTML = page.head.innerHTML;
  document.body.innerHTML = page.body.innerHTML;
  // Same registry as the entry after resetModules, so the real engine is observed, not replaced.
  const { VisualContextEngine } = await import("../mappings/VisualContextEngine");
  const update = vi.spyOn(VisualContextEngine.prototype, "update");
  await import("./visualPreview");
  return { update };
}

beforeEach(() => {
  vi.resetModules();
  gpu.state.fail.clear(); gpu.state.attempts.length = 0; gpu.state.created.length = 0;
  clock.now = 0; clock.nextId = 1; clock.queue.clear(); hidden = false;
  localStorage.clear(); sessionStorage.clear();
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    const id = clock.nextId++; clock.queue.set(id, callback); return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => { clock.queue.delete(id); });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  // Track realm-level listeners so each entry instance is fully detached in teardown.
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions) => {
      if (listener) tracked.push([target, type, listener, options]);
      add(type, listener, options);
    }) as EventTarget["addEventListener"]);
  }
});

afterEach(() => {
  window.dispatchEvent(new Event("beforeunload"));
  for (const [target, type, listener, options] of tracked.splice(0)) target.removeEventListener(type, listener, options);
  clock.queue.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as { hidden?: boolean }).hidden;
  document.head.innerHTML = ""; document.body.innerHTML = "";
});

describe("visual verification preview", () => {
  it("keeps a truthful painting fallback when the spatial constructor fails", async () => {
    gpu.state.fail.add("spatial");
    const { update } = await boot();

    expect(gpu.state.attempts).toEqual(["spatial", "painting"]);
    expect(document.querySelector<HTMLSelectElement>("#renderer")!.value).toBe("painting");
    expect(status()).toContain(FALLBACK);

    stepFor(1600);
    const [painting] = gpu.state.created;
    expect(painting.kind).toBe("painting");
    expect(painting.renders).toBeGreaterThan(0);
    expect(status()).toContain(FALLBACK);
    expect(status()).toMatch(/painting/i);
    expect(status()).toMatch(/FPS/);

    // Requested synthetic profile is untouched by the fallback; nothing is persisted.
    const { previewProfile } = await import("./PreviewFixtures");
    const fixture = previewProfile();
    const profile = update.mock.calls.at(-1)![1];
    expect(profile.name).toBe(fixture.name);
    expect(profile.colorMode).toBe("personal");
    expect(profile.pitchColors).toEqual(fixture.pitchColors);
    expect({ ...profile.spatial, songOverrides: [] }).toEqual({ ...fixture.spatial, songOverrides: [] });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("stops on a live renderer failure and recovers only through an explicit choice", async () => {
    await boot();
    stepFor(100);
    const [failed] = gpu.state.created;
    expect(failed.kind).toBe("spatial");
    expect(failed.renders).toBeGreaterThan(0);

    failed.loseContext = true;
    step();
    expect(clock.queue.size).toBe(0);
    const rendersAtFailure = failed.renders;
    stepFor(2000);
    expect(failed.renders).toBe(rendersAtFailure);
    expect(status()).toContain(LOST);
    expect(gpu.state.created).toHaveLength(1);

    select("renderer", "painting");
    const painting = gpu.state.created[1];
    expect(painting.kind).toBe("painting");
    expect(failed.disposed).toBe(true);
    expect(painting.liveAtCreate).toBe(0);
    expect(painting.canvas).toBe(failed.canvas);
    expect(clock.queue.size).toBe(1);
    stepFor(1600);
    expect(painting.renders).toBeGreaterThan(0);
    expect(status()).not.toContain(LOST);
    expect(status()).toMatch(/painting/i);

    // A callback retained by the failed generation must not touch the current one.
    failed.options.onFailure("Stale generation failure");
    expect(status()).not.toContain("Stale generation failure");
    expect(painting.disposed).toBe(false);
    expect(clock.queue.size).toBe(1);
    const before = painting.renders;
    stepFor(100);
    expect(painting.renders).toBeGreaterThan(before);

    select("renderer", "spatial");
    const retried = gpu.state.created[2];
    expect(retried.kind).toBe("spatial");
    expect(retried.liveAtCreate).toBe(0);
    stepFor(100);
    expect(retried.renders).toBeGreaterThan(0);
    expect(live()).toEqual([retried]);
  });

  it("treats unload as terminal for controls, callbacks and visibility", async () => {
    await boot();
    stepFor(100);
    const [renderer] = gpu.state.created;
    const saved = renderer.options.onFailure;

    window.dispatchEvent(new Event("beforeunload"));
    expect(clock.queue.size).toBe(0);
    expect(renderer.disposed).toBe(true);
    const statusAtUnload = status();
    const renders = renderer.renders;

    select("renderer", "painting");
    select("quality", "low");
    select("mode", "mood");
    document.querySelector<HTMLButtonElement>('[data-case="bass"]')!.click();
    window.dispatchEvent(new Event("resize"));
    saved("Late failure after unload");
    setHidden(true);
    setHidden(false);
    stepFor(500);

    expect(gpu.state.created).toEqual([renderer]);
    expect(gpu.state.attempts).toEqual(["spatial"]);
    expect(clock.queue.size).toBe(0);
    expect(renderer.renders).toBe(renders);
    expect(renderer.resizes).toBe(0);
    expect(status()).toBe(statusAtUnload);
  });
});
