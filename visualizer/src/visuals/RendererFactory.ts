import { EvolvingPainting } from "./EvolvingPainting";
import { SpatialEnvironment } from "./spatial/SpatialEnvironment";
import type { RenderOptions, VisualRenderer } from "./VisualRenderer";

export type RendererConstructor = new (canvas: HTMLCanvasElement, options: RenderOptions) => VisualRenderer;
export interface RendererConstructors { painting: RendererConstructor; spatial?: RendererConstructor }
export type RendererMode = "painting" | "spatial";
export function createVisualRenderer(canvas: HTMLCanvasElement, mode: RendererMode,
  options: RenderOptions, constructors: RendererConstructors = { painting: EvolvingPainting, spatial: SpatialEnvironment }): VisualRenderer {
  if (mode === "spatial") {
    if (!constructors.spatial) {
      const message = "Spatial rendering is not available. Use the painting until the 3D renderer is verified.";
      options.onFailure(message);
      throw new Error(message);
    }
    try { return new constructors.spatial(canvas, options); }
    catch { options.onFailure("The 3D scene could not start. Using the painting instead."); }
  }
  try { return new constructors.painting(canvas, options); }
  catch {
    const message = "WebGL rendering is unavailable. Your profile is unchanged.";
    options.onFailure(message);
    throw new Error(message);
  }
}

export function switchVisualRenderer(current: VisualRenderer, canvas: HTMLCanvasElement, mode: RendererMode,
  options: RenderOptions, constructors?: RendererConstructors): VisualRenderer {
  current.dispose();
  return createVisualRenderer(canvas, mode, options, constructors);
}
