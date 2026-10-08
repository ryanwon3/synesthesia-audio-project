import { isSynesthesiaProfile, type SynesthesiaProfile } from "./SynesthesiaProfile";
import type { ProfileWriteResult } from "./ProfileStore";

export type ProfileImportResult = ProfileWriteResult;
const maxBytes = 65_536;
const tooLarge = "Choose a profile JSON file no larger than 64 KiB.";
const invalid = "This is not a complete supported profile. Your current colors and settings have not been replaced.";

export function exportProfile(profile: SynesthesiaProfile): string {
  const snapshot: unknown = structuredClone(profile);
  if (!isSynesthesiaProfile(snapshot)) throw new Error(invalid);
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  if (!fitsProfileSize(text)) throw new Error(tooLarge);
  return text;
}
export function fitsProfileSize(text: string): boolean {
  return text.length <= maxBytes && new TextEncoder().encode(text).byteLength <= maxBytes;
}
export function parseProfileImport(text: string): ProfileImportResult {
  // The cheap bound avoids allocating an encoder result for arbitrarily large text.
  if (!fitsProfileSize(text)) {
    return { ok: false, message: tooLarge };
  }
  try {
    const profile: unknown = JSON.parse(text);
    if (!isSynesthesiaProfile(profile)) return { ok: false, message: invalid };
    // The saved/downloaded representation must fit too, not only compact input.
    if (!fitsProfileSize(JSON.stringify(profile, null, 2) + "\n")) return { ok: false, message: tooLarge };
    return { ok: true, profile };
  } catch {
    return { ok: false, message: invalid };
  }
}
export async function readProfileFile(file: File): Promise<ProfileImportResult> {
  if (file.size > maxBytes) return { ok: false, message: tooLarge };
  try {
    return parseProfileImport(await file.text());
  } catch {
    return { ok: false, message: "The selected file could not be read. Try selecting it again; your profile is unchanged." };
  }
}
