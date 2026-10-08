import type { VisualState } from "../mappings/VisualState";

/** Preview solo. Painting keeps the nearest audio band only; this is not stem separation. */
export type LayerPreview = "all" | "waves" | "rain" | "glass";

export interface VisualRenderer {
  render(state: VisualState, deltaSeconds: number): void;
  resize(): void;
  dispose(): void;
  setLayerPreview(layer: LayerPreview): void;
  setReducedMotion(enabled: boolean): void;
  /** Drops residual trails/forms and resets the scene baseline. */
  clear(): void;
}
export interface RenderOptions {
  reducedMotion: boolean;
  onFailure: (message: string) => void;
}

// Shared clock scale so both renderers slow (never rewind) shader time equally.
export const reducedMotionTimeScale = 0.35;

export function normalizeLayerPreview(value: unknown): LayerPreview {
  return value === "waves" || value === "rain" || value === "glass" ? value : "all";
}
