import { pitchClasses, type PitchClass } from "../audio/AudioFrame";
import { moodRules, moods } from "../song/SongVisualProfile";
import {
  resetSynesthesiaProfile,
  saveSynesthesiaProfile,
  type SynesthesiaProfile,
  type SynesthesiaResponse,
} from "../profiles/SynesthesiaProfile";

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

export class CalibrationPanel {
  private profile: SynesthesiaProfile;

  public constructor(
    private readonly element: HTMLElement,
    initialProfile: SynesthesiaProfile,
    private readonly onChange: (profile: SynesthesiaProfile) => void,
    private readonly onClose: () => void,
  ) {
    this.profile = structuredClone(initialProfile);
    this.render();
  }

  public setProfile(profile: SynesthesiaProfile): void {
    this.profile = structuredClone(profile);
    this.render();
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
    content.append(this.createLayerSection(), this.createPitchSection(), this.createResponseSection());

    const footer = document.createElement("footer");
    footer.className = "panel-footer";
    const resetButton = document.createElement("button");
    resetButton.className = "command-button";
    resetButton.type = "button";
    resetButton.innerHTML = `<i data-lucide="rotate-ccw" aria-hidden="true"></i><span>Reset profile</span>`;
    resetButton.addEventListener("click", () => {
      const profile = resetSynesthesiaProfile();
      this.setProfile(profile);
      this.onChange(profile);
    });
    footer.append(resetButton);

    this.element.append(header, content, footer);
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
    this.profile.layers ??= { moodInfluence: 0.8, bass: 1, mid: 1, treble: 1 };
    for (const [key, title] of [["moodInfluence", "Mood influence"], ["bass", "Bass · ripples"], ["mid", "Mids · flowing structures"], ["treble", "Treble · fine detail"]] as const) {
      const row = document.createElement("label"); row.className = "range-control";
      const label = document.createElement("span"); label.textContent = title;
      const value = document.createElement("output");
      const input = document.createElement("input"); input.type = "range"; input.min = "0"; input.max = "1"; input.step = "0.01";
      input.value = String(this.profile.layers[key]); value.textContent = `${Math.round(Number(input.value) * 100)}%`;
      input.addEventListener("input", () => {
        this.profile.layers![key] = Number(input.value); value.textContent = `${Math.round(Number(input.value) * 100)}%`; this.commit();
      });
      row.append(label, value, input); section.append(row);
    }
    return section;
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
    const snapshot = structuredClone(this.profile);
    saveSynesthesiaProfile(snapshot);
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
