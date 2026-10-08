import { describe, expect, it, vi } from "vitest";
import { calmVisualState } from "../mappings/VisualState";
import { createVisualRenderer, switchVisualRenderer } from "./RendererFactory";
import type { RenderOptions } from "./VisualRenderer";

class TestPainting {
  public render = vi.fn();
  public resize = vi.fn();
  public dispose = vi.fn();
  public setLayerPreview = vi.fn();
  public setReducedMotion = vi.fn();
  public clear = vi.fn();
  public constructor(public canvas: HTMLCanvasElement, public options: RenderOptions) {}
}

describe("renderer contract", () => {
  const canvas = {} as HTMLCanvasElement; // Constructor seam only; never used as a real canvas.
  it("creates the available painting and preserves its lifecycle contract", () => {
    const options = { reducedMotion: false, onFailure: vi.fn() };
    const renderer = createVisualRenderer(canvas, "painting", options, { painting: TestPainting });
    renderer.render(calmVisualState, 0.01);
    renderer.resize();
    renderer.dispose();
    expect(renderer).toBeInstanceOf(TestPainting);
    expect(renderer.render).toHaveBeenCalledWith(calmVisualState, 0.01);
    expect(renderer.resize).toHaveBeenCalledOnce();
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(options.onFailure).not.toHaveBeenCalled();
  });
  it("reports unavailable spatial mode honestly instead of returning an empty renderer", () => {
    const onFailure = vi.fn();
    expect(() => createVisualRenderer(canvas, "spatial", { reducedMotion: false, onFailure },
      { painting: TestPainting })).toThrow(/spatial.*not available/i);
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/spatial.*not available/i));
  });
  it("reports a failed WebGL constructor without pretending a renderer exists", () => {
    const onFailure = vi.fn();
    class Unavailable {
      public render = vi.fn();
      public resize = vi.fn();
      public dispose = vi.fn();
      public setLayerPreview = vi.fn();
      public setReducedMotion = vi.fn();
      public clear = vi.fn();
      public constructor() { throw new Error("test-only WebGL unavailable"); }
    }
    expect(() => createVisualRenderer(canvas, "painting", { reducedMotion: false, onFailure },
      { painting: Unavailable })).toThrow(/WebGL/i);
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/WebGL/i));
  });
  it("uses the spatial constructor when it exists and reports no fallback", () => {
    class Spatial extends TestPainting {}
    const options = { reducedMotion: false, onFailure: vi.fn() };
    expect(createVisualRenderer(canvas, "spatial", options, { painting: TestPainting, spatial: Spatial })).toBeInstanceOf(Spatial);
    expect(options.onFailure).not.toHaveBeenCalled();
  });
  it("failedSpatialCreationDisposesBeforeFallback through constructor rollback", () => {
    const events: string[] = [];
    class FailingSpatial extends TestPainting {
      public constructor(surface: HTMLCanvasElement, options: RenderOptions) {
        super(surface, options);
        events.push("allocate");
        try { throw new Error("controlled spatial failure"); }
        finally { this.dispose(); events.push("rollback"); }
      }
    }
    class Painting extends TestPainting {
      public constructor(surface: HTMLCanvasElement, options: RenderOptions) { super(surface, options); events.push("painting"); }
    }
    const onFailure = vi.fn();
    expect(createVisualRenderer(canvas, "spatial", { reducedMotion: false, onFailure }, { painting: Painting, spatial: FailingSpatial })).toBeInstanceOf(Painting);
    expect(events).toEqual(["allocate", "rollback", "painting"]);
    expect(onFailure).toHaveBeenCalledWith(expect.stringMatching(/painting/i));
  });
  it("modeSwitchDisposesExactlyOnce before creating the next renderer", () => {
    const current = new TestPainting(canvas, { reducedMotion: false, onFailure: vi.fn() });
    const options = { reducedMotion: false, onFailure: vi.fn() };
    const next = switchVisualRenderer(current, canvas, "painting", options, { painting: TestPainting });
    expect(current.dispose).toHaveBeenCalledOnce();
    expect(next).not.toBe(current);
  });
  it("noWebGlReportsUnsupported even when spatial and painting both fail", () => {
    class NoWebGl extends TestPainting {
      public constructor(surface: HTMLCanvasElement, options: RenderOptions) { super(surface, options); throw new Error("no controlled GPU"); }
    }
    const onFailure = vi.fn();
    expect(() => createVisualRenderer(canvas, "spatial", { reducedMotion: false, onFailure }, { painting: NoWebGl, spatial: NoWebGl })).toThrow(/WebGL/i);
    expect(onFailure).toHaveBeenLastCalledWith(expect.stringMatching(/WebGL/i));
  });
});
