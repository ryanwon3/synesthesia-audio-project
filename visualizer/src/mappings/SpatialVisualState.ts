import type { SpatialThemeId } from "../profiles/SpatialProfile";
import type { RgbColor } from "./VisualState";

export interface SpatialVisualState {
  themeId: SpatialThemeId;
  background: RgbColor;
  waves: { energy: number; softness: number; scale: number; color: RgbColor; distortion?: number };
  rain: { energy: number; impulse: number; persistence: number; color: RgbColor };
  glass: { energy: number; impulse: number; fallSpeed: number; opacity: number; color: RgbColor; shimmer?: number };
  haze?: number;
  depth: number;
  stereoBalance: number;
  stereoWidth: number;
}
export const quietSpatialState: SpatialVisualState = {
  themeId: "personal", background: [0.02, 0.025, 0.03],
  waves: { energy: 0, softness: 0.6, scale: 0.5, color: [0.3, 0.4, 0.5] },
  rain: { energy: 0, impulse: 0, persistence: 0.45, color: [0.3, 0.4, 0.5] },
  glass: { energy: 0, impulse: 0, fallSpeed: 0.4, opacity: 0.35, color: [0.3, 0.4, 0.5] },
  depth: 0.6, stereoBalance: 0.5, stereoWidth: 0,
};
