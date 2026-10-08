import { pitchClasses, type PitchClass } from "../audio/AudioFrame";
import { moodRules, moods } from "../song/SongVisualProfile";
import { ProfileStore, type ProfileWriteResult } from "../profiles/ProfileStore";
import { exportProfile, readProfileFile } from "../profiles/ProfileTransfer";
import {
  type SynesthesiaProfile,
  type SynesthesiaResponse,
} from "../profiles/SynesthesiaProfile";
import {
  defaultBronzeWaveColor,
  defaultSpatialPreferences,
  isSongThemeOverride,
  isSpatialWaveColor,
  maxSongOverrides,
  withSongOverride,
  type SongThemeOverride,
  type SpatialPreferences,
  type SpatialThemeId,
} from "../profiles/SpatialProfile";
import type { CurrentTrack } from "../song/SongContext";

interface RangeSetting {
  key: keyof SynesthesiaResponse;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}

const rangeSettings: RangeSetting[] = [
  responseSetting("bassDeformation", "Bass deformation"),
  responseSetting("midStructure", "Mid structure"),
  responseSetting("trebleParticles", "Treble detail"),
  responseSetting("transientImpulse", "Transient impulse"),
  responseSetting("persistence", "Persistence"),
  responseSetting("movement", "Movement"),
  responseSetting("sharpness", "Sharpness"),
  responseSetting("softness", "Softness"),
  responseSetting("depth", "Depth"),
  responseSetting("smoothing", "Smoothing"),
  {
    key: "attackMs",
    label: "Color attack",
    min: 10,
    max: 300,
    step: 5,
    format: (value) => `${Math.round(value)} ms`,
  },
  {
    key: "releaseMs",
    label: "Color release",
    min: 100,
    max: 1500,
    step: 25,
    format: (value) => `${Math.round(value)} ms`,
  },
];

const spatialSettings = [
  ["waveStrength", "Wave strength"], ["rainStrength", "Rain strength"], ["glassStrength", "Glass strength"],
  ["fallSpeed", "Fall speed"], ["waveScale", "Wave scale"], ["rainPersistence", "Rain persistence"],
  ["depth", "Spatial depth"],
] as const;
const spatialPreviews = [["Preview all", "all"], ["Preview waves", "waves"], ["Preview rain", "rain"], ["Preview glass", "glass"]] as const;
// Name-only reference association: no recording ID is known, so none is invented.
const referenceSong: SongThemeOverride["match"] = { spotifyTrackId: null, title: "back to friends", artist: "sombr" };

export type MotionPreference = "system" | "reduce" | "full";

export class CalibrationPanel {
  private profile: SynesthesiaProfile;
  private readonly store: ProfileStore;
  private storageWarning: string | null;
  private notice = "";
  private revision = 0;
  private importing = false;
  private disposed = false;
  private exportUrl: string | null = null;
  // Session-only presentation choice; never written to the profile or storage.
  private spatialTheme: SpatialThemeId = "personal";
  // Session-only bronze tint; only written to the profile by an explicit, confirmed song-theme save.
  private waveColor = defaultBronzeWaveColor;
  // Validated identity of the trustworthy current track reported by the host, or null.
  private currentMatch: SongThemeOverride["match"] | null = null;
  private motion: MotionPreference = "system";
  // Reported by the host so the Renderer select shows what is actually running, not only the saved request.
  private activeRenderer: SpatialPreferences["mode"] | null = null;
  private rendererNote: string | null = null;

  public constructor(
    private readonly element: HTMLElement,
    initialProfile: SynesthesiaProfile,
    private readonly onChange: (profile: SynesthesiaProfile) => void,
    private readonly onClose: () => void,
    store: ProfileStore | null = null,
    initialWarning: string | null = null,
  ) {
    this.store = store ?? new ProfileStore(null);
    this.storageWarning = initialWarning;
    this.profile = structuredClone(initialProfile);
    this.render();
  }

  public setProfile(profile: SynesthesiaProfile): void {
    if (this.disposed) return;
    this.revision++;
    this.profile = structuredClone(profile);
    this.render();
  }

  public setRendererStatus(active: SpatialPreferences["mode"] | null, note: string | null): void {
    if (this.disposed) return;
    this.activeRenderer = active;
    this.rendererNote = note;
    const mode = this.element.querySelector<HTMLSelectElement>('select[aria-label="Renderer mode"]');
    if (mode !== null) mode.value = this.rendererModeValue();
    const status = this.element.querySelector<HTMLElement>("[data-renderer-status]");
    if (status !== null) this.writeRendererNote(status);
  }

  // The host reports live, non-stale metadata or null; the current-song save follows it and re-reads it on click.
  public setCurrentTrack(track: CurrentTrack | null): void {
    if (this.disposed) return;
    this.currentMatch = savableMatch(track);
    const button = this.element.querySelector<HTMLButtonElement>("[data-save-current]");
    if (button !== null) button.disabled = this.currentMatch === null;
    const label = this.element.querySelector<HTMLElement>("[data-current-song]");
    if (label !== null) label.textContent = currentSongText(this.currentMatch);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.currentMatch = null;
    if (this.exportUrl !== null) URL.revokeObjectURL(this.exportUrl);
    this.exportUrl = null;
  }

  private render(): void {
    this.element.replaceChildren();
    const header = document.createElement("div");
    header.className = "panel-header";
    header.innerHTML = `
      <div>
        <span class="panel-kicker">PERSONAL PROFILE</span>
        <h1>Calibration</h1>
      </div>
      <button class="icon-button panel-close" type="button" aria-label="Close calibration" title="Close">
        <i data-lucide="x" aria-hidden="true"></i>
      </button>`;
    header.querySelector("button")?.addEventListener("click", this.onClose);

    const content = document.createElement("div");
    content.className = "panel-content";
    content.append(this.createTransferSection(), this.createLayerSection(), this.createSpatialSection(), this.createPitchSection(), this.createResponseSection());

    const footer = document.createElement("footer");
    footer.className = "panel-footer";
    const resetButton = document.createElement("button");
    resetButton.className = "command-button";
    resetButton.type = "button";
    resetButton.innerHTML = `<i data-lucide="rotate-ccw" aria-hidden="true"></i><span>Reset profile</span>`;
    resetButton.addEventListener("click", () => {
      if (this.disposed || !window.confirm("Reset to the bundled profile? Your saved settings will be backed up first.")) return;
      this.applyReplacement(this.store.reset(), "Profile reset. Your previous saved settings are available in Restore backup.");
    });
    const status = document.createElement("p");
    status.className = "form-status";
    status.dataset.profileStatus = "";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    footer.append(resetButton, status);

    this.element.append(header, content, footer);
    this.updateStatus();
    this.updateBusy();
  }

  private createTransferSection(): HTMLElement {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = "Keep your personal profile";
    const description = document.createElement("p");
    description.textContent = "Export your colors and settings before moving to another browser or the hosted app. Files stay on your device; importing requires confirmation.";
    const actions = document.createElement("div");
    actions.className = "profile-actions";
    const exportButton = this.transferButton("Export profile", () => this.downloadProfile());
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    input.setAttribute("aria-label", "Choose profile JSON file");
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = "";
      if (file !== undefined) void this.importProfile(file);
    });
    const importButton = this.transferButton("Import profile", () => input.click());
    importButton.dataset.profileImport = "";
    const restoreButton = this.transferButton("Restore backup", () => {
      if (this.disposed || !window.confirm("Restore your saved backup? Your current saved profile will be backed up before replacement.")) return;
      this.applyReplacement(this.store.restoreBackup(), "Backup restored and saved on this device.");
    });
    actions.append(exportButton, importButton, restoreButton, input);
    section.append(heading, description, actions);
    return section;
  }

  private transferButton(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "command-button";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => { if (!this.disposed) action(); });
    return button;
  }

  private downloadProfile(): void {
    if (this.disposed) return;
    try {
      const blob = new Blob([exportProfile(this.profile)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      if (this.exportUrl !== null) URL.revokeObjectURL(this.exportUrl);
      this.exportUrl = url;
      const link = document.createElement("a");
      link.href = url;
      link.download = "synesthesia-profile.json";
      link.hidden = true;
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      // Retain one URL until the next export or page cleanup, not an immediate revoke during download.
      this.notice = "Profile download requested. Keep the file somewhere safe; it contains your personal colors and settings.";
    } catch {
      this.notice = "The profile download could not start. Your settings are unchanged; try exporting again.";
    }
    this.updateStatus();
  }

  private async importProfile(file: File): Promise<void> {
    if (this.disposed || this.importing) return;
    this.importing = true;
    const revision = this.revision;
    this.updateBusy();
    try {
      const result = await readProfileFile(file);
      if (this.disposed) return;
      if (revision !== this.revision) {
        this.notice = "Your profile changed while the file was being read. Select it again if you still want to import it.";
        this.updateStatus();
        return;
      }
      if (!result.ok) {
        this.notice = result.message;
        this.updateStatus();
        return;
      }
      if (!window.confirm("Replace your current colors and settings with this file? Your saved profile will be backed up first.")) return;
      this.applyReplacement(this.store.replace(result.profile), "Profile imported and saved on this device.");
    } finally {
      this.importing = false;
      if (!this.disposed) this.updateBusy();
    }
  }

  private applyReplacement(result: ProfileWriteResult, notice: string): void {
    if (!result.ok) {
      this.notice = result.message;
      this.updateStatus();
      return;
    }
    this.storageWarning = null;
    this.notice = notice;
    this.setProfile(result.profile);
    this.onChange(structuredClone(result.profile));
  }

  private updateStatus(): void {
    const status = this.element.querySelector<HTMLElement>("[data-profile-status]");
    if (status !== null) status.textContent = [this.storageWarning, this.notice].filter(Boolean).join(" ");
  }

  private updateBusy(): void {
    this.element.setAttribute("aria-busy", String(this.importing));
    const button = this.element.querySelector<HTMLButtonElement>("[data-profile-import]");
    if (button !== null) button.disabled = this.importing;
  }

  private createPitchSection(): HTMLElement {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = "Pitch colors";
    const grid = document.createElement("div");
    grid.className = "pitch-grid";

    for (const pitch of pitchClasses) {
      grid.append(this.createPitchControl(pitch));
    }

    section.append(heading, grid);
    return section;
  }

  private createLayerSection(): HTMLElement {
    const section = document.createElement("section");
    section.innerHTML = "<h2>Song layers</h2><p>Audio controls movement. Tags and lyrics shape texture. Personal pitch colors are preserved when you try mood palettes.</p>";
    const colorLabel = document.createElement("label"); colorLabel.textContent = "Color mode ";
    const mode = document.createElement("select"); mode.setAttribute("aria-label", "Color mode");
    mode.innerHTML = '<option value="personal">Personal pitch colors</option><option value="mood">Mood palette · pitch selects shade</option>';
    mode.value = this.profile.colorMode ?? "personal";
    mode.addEventListener("change", () => { this.profile.colorMode = mode.value as "personal" | "mood"; this.commit(); });
    colorLabel.append(mode); section.append(colorLabel);
    const previews = document.createElement("div"); previews.className = "mood-previews";
    for (const mood of moods.filter(m => m !== "neutral")) {
      const preview = document.createElement("div"); preview.textContent = mood;
      preview.style.borderLeft = `12px solid ${moodRules[mood].colors[1]}`;
      preview.style.backgroundImage = `linear-gradient(90deg, ${moodRules[mood].colors.join(",")})`;
      preview.title = `${mood}: pitches C through B select different shades`; previews.append(preview);
    }
    section.append(previews);
    const layers = this.profile.layers ?? { moodInfluence: 0.8, bass: 1, mid: 1, treble: 1 };
    for (const [key, title] of [["moodInfluence", "Mood influence"], ["bass", "Bass · ripples"], ["mid", "Mids · flowing structures"], ["treble", "Treble · fine detail"]] as const) {
      const row = document.createElement("label"); row.className = "range-control";
      const label = document.createElement("span"); label.textContent = title;
      const value = document.createElement("output");
      const input = document.createElement("input"); input.type = "range"; input.min = "0"; input.max = "1"; input.step = "0.01";
      input.value = String(layers[key]); value.textContent = `${Math.round(Number(input.value) * 100)}%`;
      input.addEventListener("input", () => {
        this.profile.layers ??= { ...layers };
        this.profile.layers![key] = Number(input.value); value.textContent = `${Math.round(Number(input.value) * 100)}%`; this.commit();
      });
      row.append(label, value, input); section.append(row);
    }
    return section;
  }

  private createSpatialSection(): HTMLElement {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = "Spatial layers";
    const mappings = document.createElement("ul");
    for (const text of ["Sustained mids → waves", "Low attacks → rain", "Harmonic changes → glass · melodic approximation"]) {
      const item = document.createElement("li");
      item.textContent = text;
      mappings.append(item);
    }
    const description = document.createElement("p");
    description.textContent = "These layers are approximations from the mixed audio and cannot separate individual instruments. Painting remains the default renderer; the spatial renderer is an experimental preview whose accuracy is not verified.";
    section.append(heading, mappings, description);

    const modeLabel = document.createElement("label"); modeLabel.textContent = "Renderer ";
    const mode = document.createElement("select"); mode.setAttribute("aria-label", "Renderer mode");
    mode.innerHTML = '<option value="painting">Painting (default)</option><option value="spatial">Spatial · Experimental preview (not verified)</option>';
    mode.value = this.rendererModeValue();
    mode.addEventListener("change", () => {
      const value = mode.value;
      if (this.disposed || (value !== "painting" && value !== "spatial")) return;
      this.spatialPreferences().mode = value;
      this.commit();
      // After the commit so listeners see the saved choice; only this explicit request switches renderers.
      if (!this.disposed) this.element.dispatchEvent(new CustomEvent("spatial-mode-change", { detail: { mode: value } }));
    });
    modeLabel.append(mode);
    const rendererStatus = document.createElement("p");
    rendererStatus.dataset.rendererStatus = "";
    rendererStatus.setAttribute("role", "status");
    rendererStatus.setAttribute("aria-live", "polite");
    this.writeRendererNote(rendererStatus);
    section.append(modeLabel, rendererStatus);

    const themeLabel = document.createElement("label"); themeLabel.textContent = "Theme for this session ";
    const theme = document.createElement("select"); theme.setAttribute("aria-label", "Spatial theme");
    theme.innerHTML = '<option value="personal">Personal colors</option><option value="bronze-rain-glass">Bronze waves · rain · glass</option>';
    theme.value = this.spatialTheme;
    theme.addEventListener("change", () => {
      const value = theme.value;
      if (this.disposed) return;
      if (value !== "personal" && value !== "bronze-rain-glass") { theme.value = this.spatialTheme; return; }
      this.spatialTheme = value;
      this.element.dispatchEvent(new CustomEvent("spatial-theme-change", { detail: { theme: value } }));
    });
    themeLabel.append(theme);
    const themeNote = document.createElement("p");
    themeNote.textContent = "Bronze waves · rain · glass uses #b88654 as a starting suggestion for wave color. The theme lasts for this session only and does not change your saved profile. Until you pick a theme here, any saved per-song theme still applies.";
    section.append(themeLabel, themeNote);

    const tintLabel = document.createElement("label"); tintLabel.textContent = "Bronze wave color ";
    const tint = document.createElement("input"); tint.type = "color";
    tint.setAttribute("aria-label", "Bronze wave color");
    tint.value = this.waveColor;
    tint.addEventListener("input", () => {
      if (this.disposed) return;
      const value = tint.value.toLowerCase();
      if (!isSpatialWaveColor(value)) { tint.value = this.waveColor; return; }
      // Picking a tint is an explicit bronze choice for this session; personal colors stay untouched.
      this.waveColor = value;
      this.spatialTheme = "bronze-rain-glass";
      theme.value = this.spatialTheme;
      this.element.dispatchEvent(new CustomEvent("spatial-theme-change", { detail: { theme: "bronze-rain-glass", waveColor: value } }));
    });
    tintLabel.append(tint);
    const saveNote = document.createElement("p");
    saveNote.textContent = "Saving a song theme stores the bronze theme and this wave color in your profile in this browser only; it is never sent to an account or service. Saved themes apply while no session theme is chosen.";
    const currentSong = document.createElement("p");
    currentSong.dataset.currentSong = "";
    currentSong.textContent = currentSongText(this.currentMatch);
    const saveActions = document.createElement("div");
    saveActions.className = "profile-actions";
    const saveReference = this.transferButton("Save for back to friends", () =>
      this.saveSongTheme(() => ({ ...referenceSong }), "This matches by title and artist only."));
    const saveCurrent = this.transferButton("Save for current song", () =>
      this.saveSongTheme(() => this.currentMatch, "This matches this Spotify recording only."));
    saveCurrent.dataset.saveCurrent = "";
    saveCurrent.disabled = this.currentMatch === null;
    saveActions.append(saveReference, saveCurrent);
    section.append(tintLabel, saveNote, currentSong, saveActions);

    const motionLabel = document.createElement("label"); motionLabel.textContent = "Motion ";
    const motion = document.createElement("select"); motion.setAttribute("aria-label", "Motion");
    motion.innerHTML = '<option value="system">System preference</option><option value="reduce">Reduce motion</option><option value="full">Full motion</option>';
    motion.value = this.motion;
    motion.addEventListener("change", () => {
      const value = motion.value;
      if (this.disposed) return;
      if (value !== "system" && value !== "reduce" && value !== "full") { motion.value = this.motion; return; }
      this.motion = value;
      this.element.dispatchEvent(new CustomEvent("spatial-motion-change", { detail: { motion: value } }));
    });
    motionLabel.append(motion);
    const motionNote = document.createElement("p");
    motionNote.textContent = "Applies to both renderers for this session only. System preference follows your device's reduced-motion setting.";
    section.append(motionLabel, motionNote);

    // Display defaults for legacy profiles without attaching them; only explicit input adds spatial preferences.
    const preferences = this.profile.spatial ?? defaultSpatialPreferences();
    for (const [key, title] of spatialSettings) {
      const row = document.createElement("label"); row.className = "range-control";
      const label = document.createElement("span"); label.textContent = title;
      const value = document.createElement("output");
      const input = document.createElement("input"); input.type = "range"; input.min = "0"; input.max = "1"; input.step = "0.01";
      input.value = String(preferences[key]); value.textContent = `${Math.round(preferences[key] * 100)}%`;
      input.addEventListener("input", () => {
        const next = Number(input.value);
        if (this.disposed || !Number.isFinite(next) || next < 0 || next > 1) return;
        this.spatialPreferences()[key] = next;
        value.textContent = `${Math.round(next * 100)}%`;
        this.commit();
      });
      row.append(label, value, input); section.append(row);
    }

    const actions = document.createElement("div");
    actions.className = "profile-actions";
    for (const [label, layer] of spatialPreviews) {
      actions.append(this.transferButton(label, () =>
        this.element.dispatchEvent(new CustomEvent("spatial-preview", { detail: { layer } }))));
    }
    section.append(actions);
    return section;
  }

  private spatialPreferences(): SpatialPreferences {
    this.profile.spatial ??= defaultSpatialPreferences();
    return this.profile.spatial;
  }

  // Confirmed, revision-guarded save of one bronze association; replaces a matching entry and never evicts.
  private saveSongTheme(read: () => SongThemeOverride["match"] | null, scope: string): void {
    if (this.disposed) return;
    const match = read();
    if (match === null) return;
    const entry: SongThemeOverride = { match: { ...match }, themeId: "bronze-rain-glass", waveColor: this.waveColor };
    if (!isSongThemeOverride(entry)) {
      this.notice = "This song's details cannot be saved safely. Your profile is unchanged.";
      this.updateStatus();
      return;
    }
    if (this.withAssociation(entry) === null) { this.reportSongLimit(); return; }
    const revision = this.revision;
    const { title, artist } = entry.match;
    if (!window.confirm(`Save Bronze waves · rain · glass with wave color ${entry.waveColor} for "${title}" by ${artist}? ${scope} It is stored only in this browser, and your saved profile will be backed up first.`)) return;
    if (this.disposed) return;
    const after = read();
    if (revision !== this.revision || after === null || !sameMatch(after, entry.match)) {
      this.notice = "Your profile or the current song changed before saving. Nothing was saved; try again.";
      this.updateStatus();
      return;
    }
    const next = this.withAssociation(entry);
    if (next === null) { this.reportSongLimit(); return; }
    const result = this.store.replace(next);
    if (result.ok) {
      this.applyReplacement(result, "Song theme saved on this device. It is not shared with any account or service.");
      return;
    }
    // Same failure semantics as other edits: preview for this session without claiming a save.
    this.revision++;
    this.profile = next;
    this.storageWarning = result.message;
    this.notice = "This song theme is previewed only for this session and was not saved.";
    this.updateStatus();
    this.onChange(structuredClone(next));
  }

  private withAssociation(entry: SongThemeOverride): SynesthesiaProfile | null {
    const next = structuredClone(this.profile);
    next.spatial ??= defaultSpatialPreferences();
    const overrides = withSongOverride(next.spatial.songOverrides, entry);
    if (overrides === null) return null;
    next.spatial.songOverrides = overrides;
    return next;
  }

  private reportSongLimit(): void {
    this.notice = `You already have ${maxSongOverrides} saved song themes, the limit. Nothing was saved and no existing theme was removed.`;
    this.updateStatus();
  }

  private rendererModeValue(): SpatialPreferences["mode"] {
    return this.activeRenderer ?? this.profile.spatial?.mode ?? "painting";
  }

  private writeRendererNote(status: HTMLElement): void {
    status.textContent = this.rendererNote ?? "";
    status.hidden = this.rendererNote === null;
  }

  private createPitchControl(pitch: PitchClass): HTMLElement {
    const label = document.createElement("label");
    label.className = "pitch-control";
    const input = document.createElement("input");
    input.type = "color";
    input.value = this.profile.pitchColors[pitch];
    input.setAttribute("aria-label", `${displayPitch(pitch)} color`);
    input.addEventListener("input", () => {
      this.profile.pitchColors[pitch] = input.value;
      this.commit();
    });
    const text = document.createElement("span");
    text.textContent = displayPitch(pitch);
    label.append(input, text);
    return label;
  }

  private createResponseSection(): HTMLElement {
    const section = document.createElement("section");
    section.className = "response-section";
    const heading = document.createElement("h2");
    heading.textContent = "Response";
    section.append(heading);

    for (const setting of rangeSettings) {
      const row = document.createElement("label");
      row.className = "range-control";
      const title = document.createElement("span");
      title.textContent = setting.label;
      const value = document.createElement("output");
      value.textContent = setting.format(this.profile.response[setting.key]);
      const input = document.createElement("input");
      input.type = "range";
      input.min = setting.min.toString();
      input.max = setting.max.toString();
      input.step = setting.step.toString();
      input.value = this.profile.response[setting.key].toString();
      input.addEventListener("input", () => {
        const nextValue = Number(input.value);
        this.profile.response[setting.key] = nextValue;
        value.textContent = setting.format(nextValue);
        this.commit();
      });
      row.append(title, value, input);
      section.append(row);
    }

    return section;
  }

  private commit(): void {
    if (this.disposed) return;
    this.revision++;
    const snapshot = structuredClone(this.profile);
    const result = this.store.replace(snapshot);
    this.storageWarning = result.ok ? null : result.message;
    this.notice = result.ok ? "Saved on this device." : "These changes are previewed only for this session.";
    this.updateStatus();
    this.onChange(snapshot);
  }
}

function responseSetting(key: keyof SynesthesiaResponse, label: string): RangeSetting {
  return {
    key,
    label,
    min: 0,
    max: 1,
    step: 0.01,
    format: (value) => `${Math.round(value * 100)}%`,
  };
}

function displayPitch(pitch: PitchClass): string {
  return pitch.replace("Sharp", "#");
}

// Live metadata qualifies only with a real bounded Spotify ID plus a bounded, nonempty title and artist.
function savableMatch(track: CurrentTrack | null): SongThemeOverride["match"] | null {
  if (track === null || typeof track !== "object") return null;
  const id = track.spotifyTrackId;
  const title = typeof track.title === "string" ? track.title.trim() : "";
  const artist = (Array.isArray(track.artists) ? track.artists : [])
    .map((entry) => typeof entry?.name === "string" ? entry.name.trim() : "").find((name) => name !== "") ?? "";
  if (typeof id !== "string" || !/^[a-z0-9]{1,128}$/i.test(id) || title === "" || title.length > 256 ||
      artist === "" || artist.length > 128) return null;
  return { spotifyTrackId: id, title, artist };
}

function sameMatch(left: SongThemeOverride["match"], right: SongThemeOverride["match"]): boolean {
  return left.spotifyTrackId === right.spotifyTrackId && left.title === right.title && left.artist === right.artist;
}

function currentSongText(match: SongThemeOverride["match"] | null): string {
  return match === null
    ? "Save for current song is available while Spotify reports a current song."
    : `Current song: ${match.title} — ${match.artist}`;
}
