import type { SynesthesiaProfile } from "./SynesthesiaProfile";

// Synthetic palette only; no user profile, service data, or credentials.
export function testProfile(): SynesthesiaProfile {
  return {
    schemaVersion: 1,
    name: "Synthetic test palette",
    pitchColors: {
      C: "#010203", CSharp: "#112233", D: "#223344", DSharp: "#334455",
      E: "#445566", F: "#556677", FSharp: "#667788", G: "#778899",
      GSharp: "#8899Aa", A: "#99AAbb", ASharp: "#AAbBcC", B: "#bbCCdd",
    },
    response: {
      bassDeformation: 0.1, midStructure: 0.2, trebleParticles: 0.3,
      transientImpulse: 0.4, persistence: 0.5, movement: 0.6,
      sharpness: 0.7, softness: 0.8, depth: 0.9, smoothing: 1,
      attackMs: 125, releaseMs: 725,
    },
    layers: { moodInfluence: 0.15, bass: 0.25, mid: 0.35, treble: 0.45 },
    colorMode: "personal",
  };
}

export const ACTIVE_KEY = "spotify-synesthesia.profile.v1";
export const BACKUP_KEY = "spotify-synesthesia.profile.v1.backup";
export const RECOVERY_KEY = "spotify-synesthesia.profile.v1.recovery";
export const DAMAGED_KEY = "spotify-synesthesia.profile.v1.damaged";

export class TestStorage implements Storage {
  private readonly entries = new Map<string, string>();
  public failRead = false;
  public failWriteKey: string | null = null;
  public failRemoveKey: string | null = null;
  public get length(): number { return this.entries.size; }
  public clear(): void { this.entries.clear(); }
  public key(index: number): string | null { return [...this.entries.keys()][index] ?? null; }
  public getItem(key: string): string | null {
    if (this.failRead) throw new Error("Test-only unavailable storage");
    return this.entries.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    if (key === this.failWriteKey) throw new Error("Test-only unavailable storage");
    this.entries.set(key, value);
  }
  public removeItem(key: string): void {
    if (key === this.failRemoveKey) throw new Error("Test-only unavailable storage");
    this.entries.delete(key);
  }
}
