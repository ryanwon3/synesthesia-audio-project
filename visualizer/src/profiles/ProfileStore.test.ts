import { describe, expect, it } from "vitest";
import { ProfileStore } from "./ProfileStore";
import { isSynesthesiaProfile } from "./SynesthesiaProfile";
import { ACTIVE_KEY, BACKUP_KEY, RECOVERY_KEY, DAMAGED_KEY, TestStorage, testProfile } from "./profile.test-fixtures";

function original(storage: TestStorage): string {
  const raw = JSON.stringify(testProfile(), null, 3) + "\n";
  storage.setItem(ACTIVE_KEY, raw);
  return raw;
}
function nextProfile() { return { ...testProfile(), name: "Another synthetic palette" }; }

describe("ProfileStore", () => {
  it("loads the existing v1 key without modifying its bytes", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    expect(new ProfileStore(storage).load()).toEqual({ profile: testProfile(), warning: null });
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.length).toBe(1);
  });
  it("loads a usable bundled default without writing storage when empty", () => {
    const storage = new TestStorage();
    const result = new ProfileStore(storage).load();
    expect(isSynesthesiaProfile(result.profile)).toBe(true);
    expect(result.warning).toBeNull();
    expect(storage.length).toBe(0);
  });
  it.each(["", "{corrupted bytes", "null", "[]"])("PreservesMalformedStoredBytes (%s)", (raw) => {
    const storage = new TestStorage();
    storage.setItem(ACTIVE_KEY, raw);
    const result = new ProfileStore(storage).load();
    expect(result.warning).toBeTruthy();
    expect(isSynesthesiaProfile(result.profile)).toBe(true);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.length).toBe(1);
  });
  it("reports unavailable storage as temporary, without throwing", () => {
    const storage = new TestStorage();
    storage.failRead = true;
    expect(new ProfileStore(storage).load().warning).toBeTruthy();
    expect(new ProfileStore(null).load().warning).toBeTruthy();
    expect(new ProfileStore(null).replace(testProfile()).ok).toBe(false);
  });
  it("backs up exact previous bytes before replacement", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    const result = new ProfileStore(storage).replace(nextProfile());
    expect(result).toEqual({ ok: true, profile: nextProfile() });
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
    expect(JSON.parse(storage.getItem(ACTIVE_KEY)!)).toEqual(nextProfile());
  });
  it("preserves malformed current bytes in backup before explicit replacement", () => {
    const storage = new TestStorage();
    storage.setItem(ACTIVE_KEY, "corrupt but recoverable bytes");
    expect(new ProfileStore(storage).replace(testProfile()).ok).toBe(true);
    expect(storage.getItem(BACKUP_KEY)).toBe("corrupt but recoverable bytes");
  });
  it.each([
    "corrupt but recoverable bytes",
    JSON.stringify({ ...testProfile(), schemaVersion: 2 }),
    JSON.stringify({ ...testProfile(), response: {} }),
    JSON.stringify({ ...testProfile(), colorMode: "unsupported" }),
  ])("retains invalid original bytes through multiple saves and reload (%s)", (raw) => {
    const storage = new TestStorage();
    storage.setItem(ACTIVE_KEY, raw);
    const store = new ProfileStore(storage);
    const loaded = store.load();
    expect(loaded.warning).toBeTruthy();
    expect(store.replace({ ...loaded.profile, name: "First edit" }).ok).toBe(true);
    expect(store.replace({ ...loaded.profile, name: "Second edit" }).ok).toBe(true);
    expect(storage.getItem(DAMAGED_KEY)).toBe(raw);
    expect(new ProfileStore(storage).load().profile.name).toBe("Second edit");
    expect(storage.getItem(DAMAGED_KEY)).toBe(raw);
  });
  it("failed preservation of invalid originals blocks replacement and reset", () => {
    const storage = new TestStorage();
    const raw = "recoverable damaged original";
    storage.setItem(ACTIVE_KEY, raw);
    storage.failWriteKey = DAMAGED_KEY;
    const store = new ProfileStore(storage);
    expect(store.replace(testProfile()).ok).toBe(false);
    expect(store.reset().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBeNull();
    expect(storage.getItem(DAMAGED_KEY)).toBeNull();
  });
  it("protects an invalid legacy backup before rotating it", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.setItem(BACKUP_KEY, "invalid legacy backup");
    expect(new ProfileStore(storage).replace(nextProfile()).ok).toBe(true);
    expect(storage.getItem(DAMAGED_KEY)).toBe("invalid legacy backup");
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
  });
  it("does not overwrite a different retained damaged original", () => {
    const storage = new TestStorage();
    storage.setItem(DAMAGED_KEY, "earlier damaged original");
    storage.setItem(ACTIVE_KEY, "different damaged current");
    expect(new ProfileStore(storage).replace(testProfile()).ok).toBe(false);
    expect(storage.getItem(DAMAGED_KEY)).toBe("earlier damaged original");
    expect(storage.getItem(ACTIVE_KEY)).toBe("different damaged current");
    expect(storage.getItem(BACKUP_KEY)).toBeNull();
  });
  it("keeps oversized damaged originals in place rather than creating unbounded retention", () => {
    const storage = new TestStorage();
    const raw = "{" + "x".repeat(65_536);
    storage.setItem(ACTIVE_KEY, raw);
    expect(new ProfileStore(storage).replace(testProfile()).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.length).toBe(1);
  });
  it("BackupFailurePreventsReplacement", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.failWriteKey = BACKUP_KEY;
    expect(new ProfileStore(storage).replace(nextProfile()).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBeNull();
  });
  it("an active-write failure keeps current bytes and their backup", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.failWriteKey = ACTIVE_KEY;
    expect(new ProfileStore(storage).replace(nextProfile()).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
  });
  it("invalid replacement does not overwrite active or backup", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.setItem(BACKUP_KEY, "older bytes");
    const invalid = testProfile();
    invalid.response.attackMs = 0;
    expect(new ProfileStore(storage).replace(invalid).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe("older bytes");
  });
  it("uncloneable input cannot mutate storage before reporting failure", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.setItem(BACKUP_KEY, "older bytes");
    expect(new ProfileStore(storage).replace(new Proxy(nextProfile(), {})).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe("older bytes");
  });
  it("backs up current bytes before reset and restores them afterward", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    const store = new ProfileStore(storage);
    const result = store.reset();
    expect(result.ok).toBe(true);
    expect(storage.getItem(ACTIVE_KEY)).toBeNull();
    expect(storage.getItem(BACKUP_KEY)).toBe(raw);
    expect(store.restoreBackup()).toEqual({ ok: true, profile: testProfile() });
    expect(store.load()).toEqual({ profile: testProfile(), warning: null });
  });
  it.each(["backup", "remove"])("reset failure at %s preserves active bytes", (step) => {
    const storage = new TestStorage();
    const raw = original(storage);
    if (step === "backup") storage.failWriteKey = BACKUP_KEY;
    else storage.failRemoveKey = ACTIVE_KEY;
    expect(new ProfileStore(storage).reset().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
  });
  it("empty reset and first save retain an existing backup", () => {
    const storage = new TestStorage();
    storage.setItem(BACKUP_KEY, "older bytes");
    const store = new ProfileStore(storage);
    expect(store.reset().ok).toBe(true);
    expect(store.replace(testProfile()).ok).toBe(true);
    expect(storage.getItem(BACKUP_KEY)).toBe("older bytes");
  });
  it("restore swaps profiles without changing colors/settings", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    const store = new ProfileStore(storage);
    expect(store.replace(nextProfile()).ok).toBe(true);
    expect(store.restoreBackup()).toEqual({ ok: true, profile: testProfile() });
    expect(JSON.parse(storage.getItem(BACKUP_KEY)!)).toEqual(nextProfile());
    expect(store.restoreBackup()).toEqual({ ok: true, profile: nextProfile() });
    expect(JSON.parse(raw)).toEqual(testProfile());
    expect(storage.getItem(RECOVERY_KEY)).toBeNull();
  });
  it.each([null, "malformed backup", '{"schemaVersion":1}'])("invalid backup does not change any bytes (%s)", (backup) => {
    const storage = new TestStorage();
    const raw = original(storage);
    if (backup !== null) storage.setItem(BACKUP_KEY, backup);
    expect(new ProfileStore(storage).restoreBackup().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe(backup);
  });
  it("failed restore preserves its target across a new store instance", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.setItem(BACKUP_KEY, JSON.stringify(nextProfile()));
    storage.failWriteKey = ACTIVE_KEY;
    expect(new ProfileStore(storage).restoreBackup().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    storage.failWriteKey = null;
    expect(new ProfileStore(storage).restoreBackup()).toEqual({ ok: true, profile: nextProfile() });
    expect(JSON.parse(storage.getItem(BACKUP_KEY)!)).toEqual(testProfile());
  });
  it.each([RECOVERY_KEY, BACKUP_KEY])("failed restore write to %s leaves the current and target recoverable", (key) => {
    const storage = new TestStorage();
    const raw = original(storage);
    const backup = JSON.stringify(nextProfile());
    storage.setItem(BACKUP_KEY, backup);
    storage.failWriteKey = key;
    expect(new ProfileStore(storage).restoreBackup().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.getItem(BACKUP_KEY)).toBe(backup);
    storage.failWriteKey = null;
    expect(new ProfileStore(storage).restoreBackup()).toEqual({ ok: true, profile: nextProfile() });
  });
  it("a completed restore is not replayed when recovery cleanup fails", () => {
    const storage = new TestStorage();
    original(storage);
    storage.setItem(BACKUP_KEY, JSON.stringify(nextProfile()));
    storage.failRemoveKey = RECOVERY_KEY;
    expect(new ProfileStore(storage).restoreBackup()).toEqual({ ok: true, profile: nextProfile() });
    storage.failRemoveKey = null;
    expect(new ProfileStore(storage).restoreBackup()).toEqual({ ok: true, profile: testProfile() });
  });
  it("does not overwrite an interrupted restore with unrelated edits or reset", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.setItem(BACKUP_KEY, JSON.stringify(nextProfile()));
    storage.failWriteKey = ACTIVE_KEY;
    expect(new ProfileStore(storage).restoreBackup().ok).toBe(false);
    storage.failWriteKey = null;
    const store = new ProfileStore(storage);
    expect(store.load().warning).toBeTruthy();
    expect(store.replace({ ...testProfile(), name: "Unrelated edit" }).ok).toBe(false);
    expect(store.reset().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(store.restoreBackup()).toEqual({ ok: true, profile: nextProfile() });
  });
  it("cannot leave a completed recovery record to be mistaken for a pending restore after edits", () => {
    const storage = new TestStorage();
    original(storage);
    storage.setItem(BACKUP_KEY, JSON.stringify(nextProfile()));
    storage.failRemoveKey = RECOVERY_KEY;
    const store = new ProfileStore(storage);
    expect(store.restoreBackup().ok).toBe(true);
    const active = storage.getItem(ACTIVE_KEY);
    expect(store.replace(testProfile()).ok).toBe(false);
    expect(store.reset().ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(active);
    storage.failRemoveKey = null;
    expect(store.replace(testProfile()).ok).toBe(true);
    expect(storage.getItem(RECOVERY_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(BACKUP_KEY)!)).toEqual(nextProfile());
  });
  it("a failed storage read rejects every write without erasing existing data", () => {
    const storage = new TestStorage();
    const raw = original(storage);
    storage.failRead = true;
    const store = new ProfileStore(storage);
    expect(store.replace(nextProfile()).ok).toBe(false);
    expect(store.reset().ok).toBe(false);
    expect(store.restoreBackup().ok).toBe(false);
    storage.failRead = false;
    expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
    expect(storage.length).toBe(1);
  });
});
