import type { AudioFrame } from "../audio/AudioFrame";
import type { AudioFrameClientStatus } from "../audio/AudioFrameClient";
import type { VisualState } from "../mappings/VisualState";
import { extrapolateProgressMs, type SongContextSnapshot } from "../song/SongContext";

export class DebugOverlay {
  private visible = false;

  public constructor(
    private readonly element: HTMLElement,
    private readonly configureLastFm: () => void = () => undefined,
    private readonly configureOpenAi: () => void = () => undefined,
    private readonly reanalyze: () => void = () => undefined,
  ) {}

  public toggle(): void {
    this.setVisible(!this.visible);
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.classList.toggle("is-visible", visible);
    this.element.setAttribute("aria-hidden", String(!visible));
  }

  public update(
    frame: AudioFrame,
    state: VisualState,
    connection: AudioFrameClientStatus,
    fps: number,
    song: SongContextSnapshot,
  ): void {
    if (!this.visible) {
      return;
    }

    const chroma = Object.entries(frame.chroma)
      .map(([pitch, value]) => `${formatPitch(pitch)} ${format(value)}`)
      .join("  ");
    const track = song.currentTrack;
    const progress = extrapolateProgressMs(song);
    const lastFm = song.lastFm;
    this.element.innerHTML = `
      <section><h2>Audio</h2>
        <dl><dt>RMS</dt><dd>${format(frame.rms)}</dd><dt>Bass</dt><dd>${format(frame.bassEnergy)}</dd>
        <dt>Mids</dt><dd>${format(frame.midEnergy)}</dd><dt>Treble</dt><dd>${format(frame.trebleEnergy)}</dd>
        <dt>Centroid</dt><dd>${format(frame.spectralCentroid)}</dd><dt>Flux</dt><dd>${format(frame.spectralFlux)}</dd>
        <dt>Onset</dt><dd>${format(frame.onsetStrength)}</dd><dt>Pitch</dt><dd>${frame.dominantPitchClass?.replace("Sharp", "#") ?? "-"}</dd>
        <dt>Balance</dt><dd>${format(frame.stereoBalance)}</dd><dt>Width</dt><dd>${format(frame.stereoWidth)}</dd></dl>
        <p class="chroma-readout">${chroma}</p>
      </section>
      <section><h2>Visual</h2>
        <dl><dt>Brightness</dt><dd>${format(state.brightness)}</dd><dt>Fluidity</dt><dd>${format(state.fluidity)}</dd>
        <dt>Density</dt><dd>${format(state.density)}</dd><dt>Depth</dt><dd>${format(state.depth)}</dd>
        <dt>Persistence</dt><dd>${format(state.persistence)}</dd><dt>Turbulence</dt><dd>${format(state.turbulence)}</dd></dl>
      </section>
      <section><h2>System</h2>
        <dl><dt>Socket</dt><dd>${connection.state}</dd><dt>Updates</dt><dd>${connection.messagesPerSecond.toFixed(1)} Hz</dd>
        <dt>Render</dt><dd>${fps.toFixed(1)} FPS</dd><dt>Sequence</dt><dd>${frame.sequence}</dd></dl>
      </section>
      <section><h2>Song</h2>
        <dl><dt>Metadata</dt><dd>${formatLabel(song.metadataStatus)}</dd><dt>Authorization</dt><dd>${formatLabel(song.authenticationStatus)}</dd>
        <dt>Title</dt><dd>${safe(track?.title)}</dd><dt>Artists</dt><dd>${safe(track?.artists.map((artist) => artist.name).filter(Boolean).join(", "))}</dd>
        <dt>Album</dt><dd>${safe(track?.album?.name)}</dd><dt>Spotify ID</dt><dd>${safe(track?.spotifyTrackId)}</dd>
        <dt>ISRC</dt><dd>${safe(track?.isrc)}</dd><dt>Playback</dt><dd>${track ? track.isPlaying ? "Playing" : "Paused" : "-"}</dd>
        <dt>Progress</dt><dd>${formatDuration(progress)} / ${formatDuration(track?.durationMs ?? null)}</dd><dt>Stale</dt><dd>${song.stale ? "Yes" : "No"}</dd>
        <dt>Last update</dt><dd>${formatDate(song.lastSuccessfulUpdateUtc)}</dd><dt>Profile</dt><dd>${song.activeProfile ? "Loaded" : "-"}</dd>
        <dt>Profile source</dt><dd>${song.profileSource ? formatLabel(song.profileSource) : "-"}</dd><dt>SQLite</dt><dd>${formatLabel(song.sqliteStatus)}</dd>
        <dt>Database</dt><dd class="debug-path">${safe(song.databasePath)}</dd><dt>Polling</dt><dd>${formatInterval(song.currentPollingIntervalMilliseconds)}</dd>
        <dt>Next retry</dt><dd>${formatDate(song.nextRetryUtc)}</dd><dt>Auth granted</dt><dd>${formatDate(song.authorizationGrantedAtUtc)}</dd>
        <dt>Refresh expires</dt><dd>${formatDate(song.refreshCredentialExpiresAtUtc)}</dd><dt>Auth detail</dt><dd>${safe(song.authenticationDetail)}</dd></dl>
      </section>
      <section><h2>Last.fm</h2>
        <dl><dt>Status</dt><dd>${lastFm ? formatLabel(lastFm.status) : "Not configured"}</dd><dt>Source</dt><dd>${lastFm ? formatLabel(lastFm.cacheSource) : "-"}</dd>
        <dt>Matched track</dt><dd>${safe(lastFm?.matchedTrack)}</dd><dt>Matched artist</dt><dd>${safe(lastFm?.matchedArtist)}</dd>
        <dt>Match</dt><dd>${lastFm?.matchQuality ? formatLabel(lastFm.matchQuality) : "-"}</dd><dt>Retrieved</dt><dd>${formatDate(lastFm?.retrievedAtUtc ?? null)}</dd>
        <dt>Track tags</dt><dd class="debug-tags">${formatTags(lastFm?.trackTags)}</dd><dt>Artist tags</dt><dd class="debug-tags">${formatTags(lastFm?.artistTags)}</dd>
        <dt>Error</dt><dd>${lastFm?.errorCategory ? formatLabel(lastFm.errorCategory) : "-"}</dd><dt>Next retry</dt><dd>${formatDate(lastFm?.nextRetryUtc ?? null)}</dd></dl>
        <div class="debug-actions"><button class="command-button" type="button" data-configure-lastfm>Configure</button></div>
      </section>
      <section><h2>AI lyrics analysis</h2>
        <dl><dt>API key</dt><dd>${song.openAiConfigured ? "Configured" : "Not configured"}</dd><dt>Analysis</dt><dd>${safe(song.lyricsAnalysis?.status ?? "Waiting for song")}</dd>
        <dt>Lyrics source</dt><dd>${safe(song.lyricsAnalysis?.source)}</dd><dt>Timing</dt><dd>${song.lyricsAnalysis?.timed ? "Lyric sections" : "Whole song"}</dd>
        <dt>Result</dt><dd>${song.lyricsAnalysis?.cached ? "Cached" : "New"}</dd><dt>Model</dt><dd>${safe(song.lyricsSettings?.model ?? "gpt-5-mini")}</dd>
        <dt>Automatic</dt><dd>${song.lyricsSettings?.automatic ? "On" : "Off"}</dd><dt>Detail</dt><dd>${safe(song.lyricsAnalysis?.error)}</dd></dl>
        <p>Analysis sends matched lyrics to OpenAI and uses API credits.</p>
        <div class="debug-actions"><button class="command-button" type="button" data-configure-openai>Configure</button>
        <button class="command-button" type="button" data-reanalyze ${!song.openAiConfigured || !track ? "disabled" : ""}>Reanalyze this song</button></div>
      </section>`;
    this.element.querySelector<HTMLButtonElement>("[data-configure-lastfm]")
      ?.addEventListener("click", this.configureLastFm, { once: true });
    this.element.querySelector<HTMLButtonElement>("[data-configure-openai]")
      ?.addEventListener("click", this.configureOpenAi, { once: true });
    this.element.querySelector<HTMLButtonElement>("[data-reanalyze]")
      ?.addEventListener("click", this.reanalyze, { once: true });
  }
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "-";
}

function formatPitch(value: string): string {
  return value.replace("Sharp", "#").toUpperCase();
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }

  const totalSeconds = Math.floor(Math.max(0, value) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "-" : date.toLocaleTimeString();
}

function formatInterval(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : `${(value / 1000).toFixed(1)} s`;
}

function formatLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}

function safe(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }

  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTags(tags: { name: string; weight: number | null }[] | undefined): string {
  if (!tags?.length) {
    return "-";
  }

  return tags.map((tag) => safe(
    tag.weight === null ? tag.name : `${tag.name} ${tag.weight.toFixed(2)}`,
  )).join(", ");
}
