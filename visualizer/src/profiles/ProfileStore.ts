import { defaultSynesthesiaProfile, type SynesthesiaProfile } from "./SynesthesiaProfile";
import { exportProfile, fitsProfileSize, parseProfileImport } from "./ProfileTransfer";

export interface ProfileLoadResult {
  profile: SynesthesiaProfile;
  warning: string | null;
}
export type ProfileWriteResult =
  | { ok: true; profile: SynesthesiaProfile }
  | { ok: false; message: string };

const activeKey = "spotify-synesthesia.profile.v1";
const backupKey = activeKey + ".backup";
const recoveryKey = activeKey + ".recovery";
const damagedKey = activeKey + ".damaged";
const unavailable = "Settings could not be saved. Your previous saved profile is unchanged. Export this session's profile to keep your changes, then check browser storage and try again.";
const interrupted = "A previous backup restore did not finish. Use Restore backup to complete it before saving other changes or resetting.";
const retained = "An earlier unreadable profile is retained for recovery. Do not clear browser storage; your current profile can be exported separately.";

class PreservationBlocked extends Error {
  public constructor() {
    super("Damaged saved settings could not be backed up safely and have been left unchanged. Export this session's profile to keep changes before resolving the retained original.");
  }
}

export class ProfileStore {
  public constructor(private readonly storage: Storage | null) {}
  public load(): ProfileLoadResult {
    try {
      const storage = this.requireStorage();
      const raw = storage.getItem(activeKey);
      const recovery = storage.getItem(recoveryKey);
      const warning = recovery !== null && recovery !== raw ? interrupted : storage.getItem(damagedKey) !== null ? retained : null;
      if (raw === null) return { profile: defaultSynesthesiaProfile(), warning };
      const result = parseProfileImport(raw);
      return result.ok
        ? { profile: result.profile, warning }
        : { profile: defaultSynesthesiaProfile(), warning: "Saved settings could not be read and have not been deleted. The bundled profile is being used for this session." };
    } catch {
      return { profile: defaultSynesthesiaProfile(), warning: "Browser storage is unavailable. This session uses the bundled profile; export changes to keep them." };
    }
  }
  public replace(profile: SynesthesiaProfile): ProfileWriteResult {
    try {
      // Snapshot/validation must finish before any write; cloning can reject unsupported objects.
      const snapshot = structuredClone(profile);
      const text = exportProfile(snapshot);
      const storage = this.requireStorage();
      const previous = storage.getItem(activeKey);
      if (!this.clearCompletedRecovery(storage, previous)) return { ok: false, message: interrupted };
      this.backupPrevious(storage, previous);
      storage.setItem(activeKey, text);
      return { ok: true, profile: snapshot };
    } catch (error) {
      return { ok: false, message: error instanceof PreservationBlocked ? error.message : unavailable };
    }
  }
  public reset(): ProfileWriteResult {
    try {
      const profile = defaultSynesthesiaProfile();
      const storage = this.requireStorage();
      const previous = storage.getItem(activeKey);
      if (!this.clearCompletedRecovery(storage, previous)) return { ok: false, message: interrupted };
      this.backupPrevious(storage, previous);
      storage.removeItem(activeKey);
      return { ok: true, profile };
    } catch (error) {
      return { ok: false, message: error instanceof PreservationBlocked ? error.message : unavailable };
    }
  }
  public restoreBackup(): ProfileWriteResult {
    try {
      const storage = this.requireStorage();
      const previous = storage.getItem(activeKey);
      const recovery = storage.getItem(recoveryKey);
      // A completed record can remain if cleanup failed. Never replay it.
      const target = recovery !== null && recovery !== previous ? recovery : storage.getItem(backupKey);
      if (target === null) return { ok: false, message: "There is no saved backup to restore. Your profile is unchanged." };
      const result = parseProfileImport(target);
      if (!result.ok) return { ok: false, message: "The saved backup could not be read. It has not been deleted and your profile is unchanged." };
      const text = exportProfile(result.profile);
      // Persist the restore target before overwriting the backup with the current bytes.
      storage.setItem(recoveryKey, text);
      this.backupPrevious(storage, previous);
      storage.setItem(activeKey, text);
      try { storage.removeItem(recoveryKey); } catch { /* A matching active record marks this completed. */ }
      return { ok: true, profile: result.profile };
    } catch {
      return { ok: false, message: "Backup restoration could not finish. Your saved profile is unchanged; the restore target is retained. Check browser storage, then use Restore backup again." };
    }
  }
  private requireStorage(): Storage {
    if (this.storage === null) throw new Error("Storage unavailable");
    return this.storage;
  }
  private backupPrevious(storage: Storage, previous: string | null): void {
    if (previous === null) return;
    this.retainDamaged(storage, previous);
    this.retainDamaged(storage, storage.getItem(backupKey));
    storage.setItem(backupKey, previous);
  }
  private retainDamaged(storage: Storage, raw: string | null): void {
    if (raw === null || parseProfileImport(raw).ok) return;
    // One bounded retained original survives subsequent slider events and backup rotation.
    if (!fitsProfileSize(raw)) throw new PreservationBlocked();
    const earlier = storage.getItem(damagedKey);
    if (earlier === null) storage.setItem(damagedKey, raw);
    else if (earlier !== raw) throw new PreservationBlocked();
  }
  private clearCompletedRecovery(storage: Storage, previous: string | null): boolean {
    const recovery = storage.getItem(recoveryKey);
    if (recovery === null) return true;
    if (recovery !== previous) return false;
    storage.removeItem(recoveryKey);
    return true;
  }
}
