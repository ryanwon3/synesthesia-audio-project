import type { RgbColor } from "./VisualState";
import { moodRules, type Mood } from "../song/SongVisualProfile";

// Local editable palettes, not AI-selected hex values. Pitch C..B maps across the gradient.
export function moodPitchColors(mood: Mood, layer: number): RgbColor[] {
  const stops = moodRules[mood].colors.map(hex => {
    const n = Number.parseInt(hex.slice(1), 16);
    return rgbToLab([(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]);
  });
  return Array.from({ length: 12 }, (_, pitch) => {
    const t = pitch / 11 * 2, segment = Math.min(1, Math.floor(t)), fraction = t - segment;
    const lab = stops[segment].map((v, i) => v + (stops[segment + 1][i] - v) * fraction) as unknown as RgbColor;
    return labToRgb([Math.max(0, Math.min(1, lab[0] + (layer - 1) * 0.045)), lab[1], lab[2]]);
  });
}
// OKLab interpolation keeps perceived lightness smooth rather than washing gradients through gray.
function rgbToLab(rgb: RgbColor): RgbColor {
  const [r, g, b] = rgb.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function labToRgb([L, a, b]: RgbColor): RgbColor {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map(v => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055))) as unknown as RgbColor;
}
