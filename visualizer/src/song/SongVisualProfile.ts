import { extrapolateProgressMs, type SongContextSnapshot } from "./SongContext";
import { effects, moods, type Mood, type MoodTraits, type SongVisualProfile } from "../../../shared/SongTraits";

export { effects, moods, type Effect, type Mood, type MoodTraits, type SongVisualProfile } from "../../../shared/SongTraits";
export interface LyricsAnalysisState {
  status: string; source: string | null; timed: boolean; cached: boolean; error: string | null;
  profile: SongVisualProfile | null;
}
export const neutralTraits: MoodTraits = {
  mood: "neutral", energy: 0.5, tension: 0.3, softness: 0.6, imagery: "none",
  bassEffect: "ripples", midEffect: "ribbons", trebleEffect: "sparks",
};

// Editable semantic rules. Genre alone never implies an emotion (in particular pop != sad).
export const moodRules: Record<Mood, { tags: string[]; colors: string[]; traits: Partial<MoodTraits> }> = {
  neutral: { tags: [], colors: ["#467c86", "#9474ad", "#d3b385"], traits: {} },
  sad: { tags: ["sad", "melancholic", "melancholy", "heartbreak"], colors: ["#164fa3", "#5143b8", "#a06fe0"], traits: { softness: 0.85, energy: 0.25, midEffect: "clouds", trebleEffect: "ribbons" } },
  dreamy: { tags: ["dreamy", "ethereal", "dream pop", "shoegaze"], colors: ["#6e63b9", "#67b5c8", "#c789bc"], traits: { softness: 0.9, midEffect: "clouds", trebleEffect: "sparks" } },
  joyful: { tags: ["happy", "joyful", "uplifting", "upbeat"], colors: ["#edb448", "#ed987b", "#de606d"], traits: { energy: 0.8, tension: 0.1, midEffect: "ribbons", trebleEffect: "sparks" } },
  tense: { tags: ["tense", "aggressive", "angry", "metal", "industrial"], colors: ["#b92e54", "#e58538", "#7234aa"], traits: { tension: 0.9, softness: 0.2, energy: 0.9, midEffect: "fragments", trebleEffect: "fragments" } },
  calm: { tags: ["calm", "intimate", "ambient", "chill", "relaxing"], colors: ["#287c85", "#527ead", "#65a38f"], traits: { energy: 0.2, tension: 0.05, softness: 0.95, midEffect: "clouds", trebleEffect: "ribbons" } },
  dark: { tags: ["dark", "ominous", "gothic", "darkwave"], colors: ["#343986", "#79477e", "#8c344c"], traits: { tension: 0.7, energy: 0.3, midEffect: "clouds", trebleEffect: "fragments" } },
};

export function tagTraits(song?: SongContextSnapshot): MoodTraits {
  if (song?.stale) return { ...neutralTraits };
  const scores = new Map<Mood, number>();
  for (const [tags, strength] of [[song?.lastFm?.trackTags, 1], [song?.lastFm?.artistTags, 0.3]] as const) {
    for (const tag of tags ?? []) {
      const normalized = tag.name.toLowerCase().replaceAll("-", " ");
      for (const mood of moods) {
        if (moodRules[mood].tags.some(word => (` ${normalized} `).includes(` ${word} `)))
          scores.set(mood, (scores.get(mood) ?? 0) + strength * (tag.weight ?? 0.5));
      }
    }
  }
  const mood = [...scores].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "neutral";
  return { ...neutralTraits, ...moodRules[mood].traits, mood };
}

export function songTraits(song?: SongContextSnapshot, now = Date.now()): MoodTraits {
  if (song?.stale) return { ...neutralTraits };
  const overrides = song?.activeProfile?.reserved.personalOverrides as { visualProfile?: unknown } | null;
  const analysis = isVisualProfile(overrides?.visualProfile) ? overrides.visualProfile : song?.lyricsAnalysis?.profile;
  if (!analysis || !isVisualProfile(analysis)) return tagTraits(song);
  const progress = song ? extrapolateProgressMs(song, now) : null;
  return (progress !== null ? analysis.sections.find(s => progress >= s.startMs && progress < s.endMs)?.traits : null) ?? analysis.wholeSong;
}
export function isVisualProfile(value: unknown): value is SongVisualProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as SongVisualProfile;
  const traits = (t: MoodTraits) => t && moods.includes(t.mood) && [t.energy, t.tension, t.softness].every(n => Number.isFinite(n) && n >= 0 && n <= 1) &&
    [t.bassEffect, t.midEffect, t.trebleEffect].every(e => effects.includes(e));
  return traits(p.wholeSong) && Array.isArray(p.sections) && p.sections.length <= 16 && p.sections.every(s =>
    s && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.startMs >= 0 && s.endMs > s.startMs && traits(s.traits));
}
