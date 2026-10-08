// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationPanel } from "./CalibrationPanel";
import { ProfileStore } from "../profiles/ProfileStore";
import type { SynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { ACTIVE_KEY, BACKUP_KEY, DAMAGED_KEY, TestStorage, testProfile } from "../profiles/profile.test-fixtures";

let downloads: Blob[] = [];
let downloadNames: string[] = [];
let mounted: CalibrationPanel | null = null;
const confirmDescriptor = Object.getOwnPropertyDescriptor(window, "confirm");

beforeEach(() => {
  document.body.innerHTML = '<aside id="panel"></aside>';
  downloads = [];
  downloadNames = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloads.push(blob as Blob);
    return `blob:synthetic-download-${downloads.length}`;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloadNames.push(this.download);
  });
  // happy-dom does not supply the blocking browser confirmation API.
  Object.defineProperty(window, "confirm", { configurable: true, value: vi.fn(() => true) });
});
afterEach(() => {
  mounted?.dispose();
  mounted = null;
  vi.restoreAllMocks();
  if (confirmDescriptor) Object.defineProperty(window, "confirm", confirmDescriptor);
  else Reflect.deleteProperty(window, "confirm");
  document.body.innerHTML = "";
});

function mount(initial = testProfile(), warning: string | null = null) {
  const storage = new TestStorage();
  const raw = JSON.stringify(initial, null, 3) + "\n";
  storage.setItem(ACTIVE_KEY, raw);
  const changes: SynesthesiaProfile[] = [];
  const panel = new CalibrationPanel(document.querySelector<HTMLElement>("#panel")!, initial,
    (profile) => changes.push(structuredClone(profile)), () => {}, new ProfileStore(storage), warning);
  mounted = panel;
  return { storage, raw, changes, panel };
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => entry.textContent?.trim() === text);
  expect(found, `Expected user-visible ${text} control`).toBeDefined();
  return found!;
}
function status(): string {
  const element = document.querySelector<HTMLElement>('[data-profile-status][role="status"]');
  expect(element, "profile status must be exposed as an accessible live region").not.toBeNull();
  return element!.textContent ?? "";
}
function chooseFile(file: File | null): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input, "Expected user-triggered profile file selection").not.toBeNull();
  const list = {
    ...(file === null ? {} : { 0: file }), length: file === null ? 0 : 1,
    item: (index: number) => index === 0 ? file : null,
    *[Symbol.iterator]() { if (file !== null) yield file; },
  };
  Object.defineProperty(input!, "files", { configurable: true, value: list });
  input!.dispatchEvent(new Event("change", { bubbles: true }));
}
function selected(profile: SynesthesiaProfile): File {
  return new File([JSON.stringify(profile)], "synthetic.json", { type: "application/json" });
}
async function settled(): Promise<void> {
  await vi.waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
}
function move(value: string): void {
  const row = [...document.querySelectorAll<HTMLLabelElement>("label")].find((item) => item.textContent?.startsWith("Movement"));
  const input = row?.querySelector<HTMLInputElement>('input[type="range"]');
  expect(input).toBeDefined();
  input!.value = value;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CalibrationPanel profile controls", () => {
  it("CancellationDoesNotResetProfile", () => {
    const ui = mount();
    vi.mocked(window.confirm).mockReturnValue(false);
    button("Reset profile").click();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.storage.getItem(BACKUP_KEY)).toBeNull();
    expect(ui.changes).toEqual([]);
  });
  it("confirmed reset preserves a backup before changing the active profile", () => {
    const ui = mount();
    button("Reset profile").click();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(ui.storage.getItem(ACTIVE_KEY)).toBeNull();
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(ui.raw);
    expect(ui.changes).toHaveLength(1);
    expect(status()).toMatch(/reset|backup/i);
  });
  it("failed reset keeps both saved and in-memory palette", () => {
    const ui = mount();
    ui.storage.failWriteKey = BACKUP_KEY;
    button("Reset profile").click();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.changes).toEqual([]);
    expect(status()).toMatch(/could not|unchanged/i);
  });
  it("cancelling import preserves the current and existing backup bytes", async () => {
    const ui = mount();
    ui.storage.setItem(BACKUP_KEY, "older bytes");
    vi.mocked(window.confirm).mockReturnValue(false);
    chooseFile(selected({ ...testProfile(), name: "Imported synthetic profile" }));
    await settled();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe("older bytes");
    expect(ui.changes).toEqual([]);
  });
  it("confirmed import replaces exactly the selected colors and response", async () => {
    const ui = mount();
    const imported = { ...testProfile(), name: "Imported synthetic profile", colorMode: "mood" as const };
    chooseFile(selected(imported));
    await settled();
    expect(ui.changes).toEqual([imported]);
    expect(JSON.parse(ui.storage.getItem(ACTIVE_KEY)!)).toEqual(imported);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(ui.raw);
    expect(status()).toMatch(/imported|saved/i);
  });
  it("invalid import never prompts or replaces current settings", async () => {
    const ui = mount();
    chooseFile(new File(['{"schemaVersion":1}'], "incomplete.json"));
    await settled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.changes).toEqual([]);
    expect(status()).toMatch(/not a complete|not.*supported/i);
  });
  it("cancelled native file selection makes no changes", () => {
    const ui = mount();
    chooseFile(null);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.changes).toEqual([]);
  });
  it("import write failure does not change the in-memory profile", async () => {
    const ui = mount();
    ui.storage.failWriteKey = ACTIVE_KEY;
    chooseFile(selected({ ...testProfile(), name: "Imported synthetic profile" }));
    await settled();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.changes).toEqual([]);
    button("Export profile").click();
    expect(JSON.parse(await downloads[0].text())).toEqual(testProfile());
  });
  it("exports a local JSON download without changing stored bytes or optional-field absence", async () => {
    const legacy = testProfile();
    delete legacy.layers;
    delete legacy.colorMode;
    const ui = mount(legacy);
    button("Export profile").click();
    expect(downloads).toHaveLength(1);
    expect(downloadNames).toHaveLength(1);
    expect(downloadNames[0]).toMatch(/\.json$/);
    expect(JSON.parse(await downloads[0].text())).toEqual(legacy);
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.storage.getItem(BACKUP_KEY)).toBeNull();
    expect(ui.changes).toEqual([]);
  });
  it("restores a backup only with confirmation", () => {
    const ui = mount();
    const backup = { ...testProfile(), name: "Backup synthetic profile" };
    const backupRaw = JSON.stringify(backup);
    ui.storage.setItem(BACKUP_KEY, backupRaw);
    vi.mocked(window.confirm).mockReturnValue(false);
    button("Restore backup").click();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(backupRaw);
    expect(ui.changes).toEqual([]);
    vi.mocked(window.confirm).mockReturnValue(true);
    button("Restore backup").click();
    expect(ui.changes).toEqual([backup]);
    expect(JSON.parse(ui.storage.getItem(ACTIVE_KEY)!)).toEqual(backup);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(ui.raw);
  });
  it("retains at most one download URL and releases it at application cleanup", () => {
    const ui = mount();
    button("Export profile").click();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    button("Export profile").click();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-download-1");
    ui.panel.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:synthetic-download-2");
    ui.panel.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it("storage failure previews calibration for this session and keeps it exportable", async () => {
    const ui = mount();
    ui.storage.failWriteKey = BACKUP_KEY;
    move("0.25");
    const expected = testProfile();
    expected.response.movement = 0.25;
    expect(ui.changes).toEqual([expected]);
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
    expect(status()).toMatch(/session|not.*saved/i);
    button("Export profile").click();
    expect(JSON.parse(await downloads[0].text())).toEqual(expected);
  });
  it("keeps the startup storage warning visible when reopening calibration", () => {
    const ui = mount(testProfile(), "Synthetic warning: settings could not be read.");
    expect(status()).toContain("settings could not be read");
    ui.panel.setProfile(testProfile());
    expect(status()).toContain("settings could not be read");
  });
  it.each([false, true])("multiple slider events retain damaged settings (preservation failure: %s)", (fail) => {
    const storage = new TestStorage();
    const raw = "original damaged settings, not expendable fallback";
    storage.setItem(ACTIVE_KEY, raw);
    const store = new ProfileStore(storage);
    const loaded = store.load();
    const changes: number[] = [];
    mounted = new CalibrationPanel(document.querySelector<HTMLElement>("#panel")!, loaded.profile,
      (profile) => changes.push(profile.response.movement), () => {}, store, loaded.warning);
    if (fail) storage.failWriteKey = DAMAGED_KEY;
    move("0.25");
    move("0.35");
    expect(changes).toEqual([0.25, 0.35]);
    if (fail) {
      expect(storage.getItem(ACTIVE_KEY)).toBe(raw);
      expect(storage.getItem(DAMAGED_KEY)).toBeNull();
      expect(status()).toMatch(/session|not.*saved/i);
    } else {
      expect(storage.getItem(DAMAGED_KEY)).toBe(raw);
      expect(new ProfileStore(storage).load().profile.response.movement).toBe(0.35);
      expect(storage.getItem(DAMAGED_KEY)).toBe(raw);
    }
  });
  it("does not let a slow import overwrite more recent calibration", async () => {
    const ui = mount();
    const file = selected({ ...testProfile(), name: "Stale synthetic import" });
    let finish!: (text: string) => void;
    file.text = () => new Promise<string>((resolve) => { finish = resolve; });
    chooseFile(file);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    move("0.25");
    finish(JSON.stringify({ ...testProfile(), name: "Stale synthetic import" }));
    await settled();
    const expected = testProfile();
    expected.response.movement = 0.25;
    expect(ui.changes).toEqual([expected]);
    expect(JSON.parse(ui.storage.getItem(ACTIVE_KEY)!)).toEqual(expected);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(status()).toMatch(/changed|again/i);
  });
});
