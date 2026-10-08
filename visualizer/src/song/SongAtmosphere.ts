import type { SongContextSnapshot } from "./SongContext";
export interface SongAtmosphere { warmth: number; haze: number; shimmer: number; distortion: number }
export const neutralAtmosphere: Readonly<SongAtmosphere> = { warmth: 0.5, haze: 0.2, shimmer: 0.35, distortion: 0.2 };

// Editable presentation rules, not an instrument or emotion classifier. They
// contain no pitch colors and never write a personal profile.
const rules = [
  { tags: ["acoustic", "folk", "singer songwriter", "indie folk"], warmth: 0.9, haze: 0.3, shimmer: 0.2, distortion: 0.08 },
  { tags: ["ambient", "dream pop", "shoegaze", "ethereal", "chillout"], warmth: 0.4, haze: 0.85, shimmer: 0.45, distortion: 0.1 },
  { tags: ["electronic", "synthwave", "synth pop", "electronica", "dance"], warmth: 0.3, haze: 0.12, shimmer: 0.95, distortion: 0.45 },
  { tags: ["metal", "industrial", "punk", "hard rock"], warmth: 0.55, haze: 0.1, shimmer: 0.65, distortion: 0.95 },
  { tags: ["jazz", "soul", "r&b", "blues"], warmth: 0.8, haze: 0.4, shimmer: 0.5, distortion: 0.15 },
] as const;

export function tagAtmosphere(song?: SongContextSnapshot): SongAtmosphere {
  if (song?.stale || !song?.lastFm) return { ...neutralAtmosphere };
  const contributions: { name: string; weight: number }[] = [];
  for (const [tags, strength] of [[song.lastFm.trackTags, 1], [song.lastFm.artistTags, 0.3]] as const) {
    for (const tag of tags.slice(0, 32)) {
      const weight = tag.weight === null ? 0.5 : tag.weight;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1 || typeof tag.name !== "string") continue;
      contributions.push({ name: tag.name.normalize("NFKC").trim().toLowerCase().replace(/[-_\s]+/g, " "), weight: weight * strength });
    }
  }
  contributions.sort((a, b) => a.name.localeCompare(b.name) || a.weight - b.weight);
  const sum = { warmth: 0, haze: 0, shimmer: 0, distortion: 0 };
  let total = 0;
  for (const tag of contributions) for (const rule of rules) {
    if (!rule.tags.some(name => (` ${tag.name} `).includes(` ${name} `))) continue;
    total += tag.weight;
    for (const key of Object.keys(sum) as (keyof SongAtmosphere)[]) sum[key] += (rule[key] - neutralAtmosphere[key]) * tag.weight;
  }
  const result = { ...neutralAtmosphere };
  for (const key of Object.keys(sum) as (keyof SongAtmosphere)[]) {
    result[key] = Math.max(0, Math.min(1, neutralAtmosphere[key] + sum[key] / Math.max(1, total)));
  }
  return result;
}
