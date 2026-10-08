// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationPanel } from "./CalibrationPanel";
import { ProfileStore } from "../profiles/ProfileStore";
import { defaultSpatialPreferences, type SpatialPreferences } from "../profiles/SpatialProfile";
import type { SynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { ACTIVE_KEY, BACKUP_KEY, TestStorage, testProfile } from "../profiles/profile.test-fixtures";

const controls = [
  ["Wave strength", "waveStrength"], ["Rain strength", "rainStrength"], ["Glass strength", "glassStrength"],
  ["Fall speed", "fallSpeed"], ["Wave scale", "waveScale"], ["Rain persistence", "rainPersistence"],
  ["Spatial depth", "depth"],
] as const;
const previews = [["Preview all", "all"], ["Preview waves", "waves"], ["Preview rain", "rain"], ["Preview glass", "glass"]] as const;
let mounted: CalibrationPanel | null = null;
const confirmDescriptor = Object.getOwnPropertyDescriptor(window, "confirm");

beforeEach(() => {
  document.body.innerHTML = '<aside id="panel"></aside>';
  window.localStorage.clear();
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

// Synthetic spatial preferences only; the override names no real recording.
function spatialProfile(): SynesthesiaProfile {
  return { ...testProfile(), spatial: { ...defaultSpatialPreferences(), mode: "spatial", waveStrength: 0.2,
    songOverrides: [{ match: { spotifyTrackId: "synthetic1", title: "Synthetic title", artist: "Synthetic artist" },
      themeId: "bronze-rain-glass", waveColor: "#123456" }] } };
}
function mount(initial = testProfile()) {
  const storage = new TestStorage();
  const raw = JSON.stringify(initial, null, 3) + "\n";
  storage.setItem(ACTIVE_KEY, raw);
  const changes: SynesthesiaProfile[] = [];
  const element = document.querySelector<HTMLElement>("#panel")!;
  const panel = new CalibrationPanel(element, initial,
    (profile) => changes.push(structuredClone(profile)), () => {}, new ProfileStore(storage));
  mounted = panel;
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ["spatial-preview", "spatial-theme-change"]) {
    element.addEventListener(type, (event) => {
      expect(event).toBeInstanceOf(CustomEvent);
      events.push({ type, detail: (event as CustomEvent).detail });
    });
  }
  return { storage, raw, changes, panel, element, events };
}
function range(name: string): HTMLInputElement {
  const found = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((input) =>
    input.getAttribute("aria-label") === name || input.closest("label")?.querySelector("span")?.textContent?.trim() === name);
  expect(found, `Expected accessible ${name} range`).toBeDefined();
  return found!;
}
function select(name: string): HTMLSelectElement {
  const found = document.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`);
  expect(found, `Expected accessible ${name} select`).not.toBeNull();
  return found!;
}
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name);
  expect(found, `Expected user-visible ${name} control`).toBeDefined();
  return found!;
}
function change(control: HTMLInputElement | HTMLSelectElement, value: string, type = "input"): void {
  control.value = value;
  control.dispatchEvent(new Event(type, { bubbles: true }));
}
function status(): string {
  return document.querySelector<HTMLElement>('[data-profile-status][role="status"]')?.textContent ?? "";
}
function expectUntouched(ui: ReturnType<typeof mount>): void {
  expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
  expect(ui.storage.getItem(BACKUP_KEY)).toBeNull();
  expect(ui.storage.length).toBe(1);
  expect(window.localStorage.length).toBe(0);
  expect(ui.changes).toEqual([]);
}

describe("CalibrationPanel spatial controls", () => {
  it("mounts honest spatial copy and controls without touching a legacy profile", () => {
    const legacy = testProfile();
    const ui = mount(legacy);
    const text = ui.element.textContent ?? "";
    for (const label of ["Sustained mids → waves", "Low attacks → rain", "Harmonic changes → glass · melodic approximation"]) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/(not|no|cannot|can't)\b[^.]*separat[^.]*instrument/i);
    for (const [name, key] of controls) {
      const input = range(name);
      expect([input.min, input.max]).toEqual(["0", "1"]);
      expect(Number(input.value)).toBe(defaultSpatialPreferences()[key]);
    }
    const mode = select("Renderer mode");
    expect(mode.value).toBe("painting");
    expect([...mode.options].find((option) => option.value === "spatial")?.textContent).toMatch(/Experimental preview/);
    expect(legacy).toEqual(testProfile());
    expectUntouched(ui);
    expect(ui.events).toEqual([]);
  });
  it("adds validated spatial defaults only on user input and saves each change with a backup", () => {
    const ui = mount();
    const values = ["0.1", "0.2", "0.3", "0.4", "0.15", "0.25", "0.35"];
    const expected: SpatialPreferences = defaultSpatialPreferences();
    controls.forEach(([name, key], index) => {
      change(range(name), values[index]);
      expected[key] = Number(values[index]);
    });
    expect(ui.changes[0]).toEqual({ ...testProfile(), spatial: { ...defaultSpatialPreferences(), waveStrength: 0.1 } });
    expect(ui.changes).toHaveLength(7);
    expect(ui.changes.at(-1)).toEqual({ ...testProfile(), spatial: expected });
    expect(JSON.parse(ui.storage.getItem(ACTIVE_KEY)!)).toEqual({ ...testProfile(), spatial: expected });
    expect(status()).toMatch(/saved/i);
  });
  it("preserves existing spatial fields and previews session-only when saving fails", () => {
    const initial = spatialProfile();
    const ui = mount(initial);
    change(range("Glass strength"), "0.3");
    const saved = structuredClone(initial);
    saved.spatial!.glassStrength = 0.3;
    expect(ui.changes).toEqual([saved]);
    expect(JSON.parse(ui.storage.getItem(ACTIVE_KEY)!)).toEqual(saved);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(ui.raw);
    const savedRaw = ui.storage.getItem(ACTIVE_KEY);
    ui.storage.failWriteKey = BACKUP_KEY;
    change(range("Fall speed"), "0.9");
    expect(ui.changes.at(-1)).toEqual({ ...saved, spatial: { ...saved.spatial!, fallSpeed: 0.9 } });
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(savedRaw);
    expect(status()).toMatch(/session/i);
  });
  it("persists spatial renderer mode only on explicit selection", () => {
    const ui = mount();
    change(select("Renderer mode"), "spatial", "change");
    const expected = { ...testProfile(), spatial: { ...defaultSpatialPreferences(), mode: "spatial" as const } };
    expect(ui.changes).toEqual([expected]);
    expect(JSON.parse(ui.storage.getItem(ACTIVE_KEY)!)).toEqual(expected);
    ui.panel.setProfile(spatialProfile());
    expect(select("Renderer mode").value).toBe("spatial");
  });
  it("layer preview buttons dispatch events without profile or storage changes", () => {
    const ui = mount();
    for (const [name] of previews) button(name).click();
    expect(ui.events).toEqual(previews.map(([, layer]) => ({ type: "spatial-preview", detail: { layer } })));
    expectUntouched(ui);
  });
  it("spatial theme selection is session-only and shows a starting suggestion", () => {
    const ui = mount();
    const theme = select("Spatial theme");
    expect([...theme.options].map((option) => option.value)).toEqual(["personal", "bronze-rain-glass"]);
    expect(theme.value).toBe("personal");
    change(theme, "bronze-rain-glass", "change");
    expect(ui.events).toEqual([{ type: "spatial-theme-change", detail: { theme: "bronze-rain-glass" } }]);
    expect(ui.element.textContent).toContain("#b88654");
    expect(ui.element.textContent).toMatch(/starting suggestion/i);
    expectUntouched(ui);
  });
  it("cancelled reset preserves spatial profile and colors", () => {
    const ui = mount(spatialProfile());
    vi.mocked(window.confirm).mockReturnValue(false);
    button("Reset profile").click();
    expectUntouched(ui);
    expect(Number(range("Wave strength").value)).toBe(0.2);
    expect(select("Renderer mode").value).toBe("spatial");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="C color"]')?.value).toBe("#010203");
  });
  it("disposal blocks spatial callbacks, saves and events", () => {
    const ui = mount();
    const wave = range("Wave strength");
    const mode = select("Renderer mode");
    const theme = select("Spatial theme");
    const preview = button("Preview all");
    ui.panel.dispose();
    change(wave, "0.3");
    change(mode, "spatial", "change");
    change(theme, "bronze-rain-glass", "change");
    preview.click();
    expectUntouched(ui);
    expect(ui.events).toEqual([]);
  });
});
