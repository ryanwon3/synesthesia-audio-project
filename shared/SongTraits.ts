export const moods = ["neutral", "sad", "dreamy", "joyful", "tense", "calm", "dark"] as const;
export type Mood = typeof moods[number];
export const effects = ["ripples", "ribbons", "clouds", "sparks", "fragments"] as const;
export type Effect = typeof effects[number];
// Hosted contexts accept only these; legacy local profiles keep free-form imagery strings.
export const hostedImageries = ["none", "water", "air", "light", "earth", "fire"] as const;
export type HostedImagery = typeof hostedImageries[number];
export interface MoodTraits {
  mood: Mood; energy: number; tension: number; softness: number; imagery: string;
  bassEffect: Effect; midEffect: Effect; trebleEffect: Effect;
}
export interface SongVisualProfile {
  wholeSong: MoodTraits;
  sections: { startMs: number; endMs: number; traits: MoodTraits }[];
}
