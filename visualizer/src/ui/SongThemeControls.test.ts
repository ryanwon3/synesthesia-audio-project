// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationPanel } from "./CalibrationPanel";
import { ProfileStore } from "../profiles/ProfileStore";
import { defaultSpatialPreferences, resolveSpatialTheme, type SongThemeOverride } from "../profiles/SpatialProfile";
import type { SynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import type { CurrentTrack } from "../song/SongContext";
import { ACTIVE_KEY, BACKUP_KEY, TestStorage, testProfile } from "../profiles/profile.test-fixtures";

// Tests-first: the host reports trustworthy, non-stale metadata, or null on loss.
type SongThemeHost = CalibrationPanel & { setCurrentTrack(track: CurrentTrack | null): void };

const TINT = "Bronze wave color";
const SAVE_REFERENCE = "Save for back to friends";
const SAVE_CURRENT = "Save for current song";
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

function association(id: string | null, title: string, artist: string, waveColor: string): SongThemeOverride {
  return { match: { spotifyTrackId: id, title, artist }, themeId: "bronze-rain-glass", waveColor };
}
// Synthetic entries only; the reference title/artist is the one user-given association.
function reference(waveColor: string): SongThemeOverride {
  return association(null, "back to friends", "sombr", waveColor);
}
function spatialProfile(extra: SongThemeOverride[] = []): SynesthesiaProfile {
  return { ...testProfile(), spatial: { ...defaultSpatialPreferences(), mode: "spatial", waveStrength: 0.2,
    songOverrides: [association("synthetic1", "Synthetic title", "Synthetic artist", "#123456"), ...extra] } };
}
function track(id: string, title: string, artist: string): CurrentTrack {
  return { spotifyTrackId: id, spotifyUri: null, isrc: null, title, artists: [{ spotifyArtistId: null, name: artist }],
    album: null, durationMs: 180000, explicit: null, progressMs: 1000, isPlaying: true, observedAtUtc: "2026-01-01T00:00:00.000Z" };
}
function mount(initial: SynesthesiaProfile) {
  mounted?.dispose();
  const storage = new TestStorage();
  const raw = JSON.stringify(initial, null, 3) + "\n";
  storage.setItem(ACTIVE_KEY, raw);
  const changes: SynesthesiaProfile[] = [];
  const element = document.querySelector<HTMLElement>("#panel")!;
  const panel = new CalibrationPanel(element, initial,
    (profile) => changes.push(structuredClone(profile)), () => {}, new ProfileStore(storage));
  mounted = panel;
  const events: unknown[] = [];
  element.addEventListener("spatial-theme-change", (event) => events.push((event as CustomEvent).detail));
  return { storage, raw, changes, panel, host: panel as SongThemeHost, element, events };
}
function tint(): HTMLInputElement {
  const found = [...document.querySelectorAll<HTMLInputElement>('input[type="color"]')].find((input) =>
    input.getAttribute("aria-label") === TINT || input.closest("label")?.textContent?.trim() === TINT);
  expect(found, `Expected accessible ${TINT} input`).toBeDefined();
  return found!;
}
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((entry) => (entry.getAttribute("aria-label") ?? entry.textContent?.trim()) === name);
  expect(found, `Expected user-visible ${name} control`).toBeDefined();
  return found!;
}
function change(control: HTMLInputElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
function status(): string {
  return document.querySelector<HTMLElement>('[data-profile-status][role="status"]')?.textContent ?? "";
}
function pitchColors(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="color"]')]
    .filter((input) => input !== tint()).map((input) => input.value.toLowerCase());
}
function persisted(ui: ReturnType<typeof mount>): SynesthesiaProfile {
  return JSON.parse(ui.storage.getItem(ACTIVE_KEY)!) as SynesthesiaProfile;
}
function expectUntouched(ui: ReturnType<typeof mount>): void {
  expect(ui.storage.getItem(ACTIVE_KEY)).toBe(ui.raw);
  expect(ui.storage.getItem(BACKUP_KEY)).toBeNull();
  expect(ui.storage.length).toBe(1);
  expect(window.localStorage.length).toBe(0);
  expect(ui.changes).toEqual([]);
}
// Everything except the one added association matches the starting profile; order is not part of the contract.
function expectAssociation(profile: SynesthesiaProfile, initial: SynesthesiaProfile, saved: SongThemeOverride): void {
  const { songOverrides, ...spatial } = profile.spatial!;
  const { songOverrides: before, ...initialSpatial } = initial.spatial!;
  expect({ ...profile, spatial }).toEqual({ ...initial, spatial: initialSpatial });
  expect(songOverrides).toHaveLength(before.length + 1);
  expect(songOverrides).toEqual(expect.arrayContaining([...before, saved]));
}

describe("CalibrationPanel song theme controls", () => {
  it("bronze wave tint is a session-only starting suggestion", () => {
    const ui = mount(spatialProfile());
    const colorsBefore = pitchColors();
    expect(tint().value.toLowerCase()).toBe("#b88654");
    expect(ui.element.textContent).toMatch(/starting suggestion/i);
    expectUntouched(ui);

    change(tint(), "#a1b2c3");
    expect(ui.events).toEqual([{ theme: "bronze-rain-glass", waveColor: "#a1b2c3" }]);
    expect(pitchColors()).toEqual(colorsBefore);
    expectUntouched(ui);
  });

  it("saves the reference association only on confirmed request and replaces it on repeat", () => {
    const initial = spatialProfile();
    const ui = mount(initial);
    ui.panel.setProfile(structuredClone(initial));
    expectUntouched(ui);

    vi.mocked(window.confirm).mockReturnValue(false);
    button(SAVE_REFERENCE).click();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expectUntouched(ui);

    vi.mocked(window.confirm).mockReturnValue(true);
    button(SAVE_REFERENCE).click();
    expect(ui.changes).toHaveLength(1);
    expectAssociation(ui.changes[0], initial, reference("#b88654"));
    expect(persisted(ui)).toEqual(ui.changes[0]);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(ui.raw);
    expect(status()).toMatch(/saved/i);

    change(tint(), "#a1b2c3");
    expect(ui.changes).toHaveLength(1);
    button(SAVE_REFERENCE).click();
    expect(ui.changes).toHaveLength(2);
    expectAssociation(ui.changes[1], initial, reference("#a1b2c3"));
    expect(persisted(ui)).toEqual(ui.changes[1]);

    // Without a session theme, the saved name-only association matches only the normalized reference.
    const saved = persisted(ui);
    const matched = resolveSpatialTheme(saved, track("syntheticRef", "  Back To  Friends ", "SOMBR"), null);
    expect(matched.id).toBe("bronze-rain-glass");
    expect(matched.waveColorOverride).toEqual([0xa1 / 255, 0xb2 / 255, 0xc3 / 255]);
    for (const other of [track("syntheticX", "back to friends", "Synthetic artist"),
      track("syntheticY", "Synthetic title", "sombr"), track("syntheticZ", "back to friends (synthetic edit)", "sombr")]) {
      expect(resolveSpatialTheme(saved, other, null).id).toBe("personal");
    }
  });

  it("saves only the current trustworthy track, reports failures truthfully, and goes inert on dispose", () => {
    const initial = spatialProfile();
    const ui = mount(initial);
    expect(button(SAVE_CURRENT).disabled).toBe(true);
    button(SAVE_CURRENT).click();
    expect(window.confirm).not.toHaveBeenCalled();
    expectUntouched(ui);

    // Identity is re-read at click: a later metadata switch must not save the earlier track.
    ui.host.setCurrentTrack(track("syntheticA1", "Synthetic song A", "Synthetic artist A"));
    expect(button(SAVE_CURRENT).disabled).toBe(false);
    ui.host.setCurrentTrack(track("syntheticB2", "Synthetic song B", "Synthetic artist B"));
    button(SAVE_CURRENT).click();
    expect(vi.mocked(window.confirm).mock.calls.at(-1)?.[0]).toContain("Synthetic song B");
    expect(ui.changes).toHaveLength(1);
    expectAssociation(ui.changes[0], initial, association("syntheticB2", "Synthetic song B", "Synthetic artist B", "#b88654"));
    expect(persisted(ui)).toEqual(ui.changes[0]);
    expect(JSON.stringify(ui.changes)).not.toContain("syntheticA1");

    ui.host.setCurrentTrack(null);
    expect(button(SAVE_CURRENT).disabled).toBe(true);
    button(SAVE_CURRENT).click();
    expect(ui.changes).toHaveLength(1);

    // Existing failure mechanics: session preview, saved records unchanged, no saved claim.
    ui.host.setCurrentTrack(track("syntheticC3", "Synthetic song C", "Synthetic artist C"));
    const activeBefore = ui.storage.getItem(ACTIVE_KEY);
    const backupBefore = ui.storage.getItem(BACKUP_KEY);
    ui.storage.failWriteKey = BACKUP_KEY;
    button(SAVE_CURRENT).click();
    expect(ui.storage.getItem(ACTIVE_KEY)).toBe(activeBefore);
    expect(ui.storage.getItem(BACKUP_KEY)).toBe(backupBefore);
    expect(ui.changes.at(-1)!.spatial!.songOverrides)
      .toContainEqual(association("syntheticC3", "Synthetic song C", "Synthetic artist C", "#b88654"));
    expect(status()).toMatch(/session/i);
    expect(status()).not.toMatch(/Saved on this device/);

    // At the 32-entry limit nothing is evicted or claimed saved.
    const full = spatialProfile(Array.from({ length: 31 }, (_, i) =>
      association(`syntheticFull${i}`, `Synthetic title ${i}`, "Synthetic artist", "#123456")));
    const capped = mount(full);
    capped.host.setCurrentTrack(track("syntheticD4", "Synthetic song D", "Synthetic artist D"));
    button(SAVE_CURRENT).click();
    expect(capped.storage.getItem(ACTIVE_KEY)).toBe(capped.raw);
    expect(capped.storage.getItem(BACKUP_KEY)).toBeNull();
    for (const emitted of capped.changes) {
      expect(emitted.spatial!.songOverrides.length).toBeLessThanOrEqual(32);
      expect(emitted.spatial!.songOverrides).toEqual(expect.arrayContaining(full.spatial!.songOverrides));
    }
    expect(status()).not.toBe("");
    expect(status()).not.toMatch(/Saved on this device/);

    const [oldTint, oldReference, oldCurrent] = [tint(), button(SAVE_REFERENCE), button(SAVE_CURRENT)];
    const confirms = vi.mocked(window.confirm).mock.calls.length;
    const changes = capped.changes.length;
    capped.panel.dispose();
    expect(() => capped.host.setCurrentTrack(track("syntheticE5", "Synthetic song E", "Synthetic artist E"))).not.toThrow();
    change(oldTint, "#010101");
    oldReference.click();
    oldCurrent.click();
    expect(vi.mocked(window.confirm).mock.calls.length).toBe(confirms);
    expect(capped.events).toEqual([]);
    expect(capped.changes).toHaveLength(changes);
    expect(capped.storage.getItem(ACTIVE_KEY)).toBe(capped.raw);
  });
});
