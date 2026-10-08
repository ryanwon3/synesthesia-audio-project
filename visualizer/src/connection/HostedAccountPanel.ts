import { CloudAccountClient, type HostedCapabilities } from "./CloudAccountClient";
import { initialSongContext, type SongContextSnapshot } from "../song/SongContext";
import { HostedSongContextClient, type HostedSongContextStatus } from "../song/HostedSongContextClient";

// Metadata/account lifecycle only. This component cannot stop audio capture,
// write palettes, ask for provider credentials or automatically spend AI usage.
export class HostedAccountPanel {
  private readonly context = new HostedSongContextClient();
  private readonly connect = button("Connect Spotify", "cloudConnect");
  private readonly disconnect = button("Disconnect Spotify", "cloudDisconnect");
  private readonly signOut = button("Sign out", "cloudSignOut");
  private readonly analyze = button("Analyze song mood", "cloudAnalyze");
  private readonly message = document.createElement("span");
  private readonly analysisHint = document.createElement("span");
  private caps: HostedCapabilities = { spotify: false, lyrics: false, ai: false };
  private signedIn = false;
  private trackId: string | null = null;
  private busy = false;
  private active = false;
  private disposed = false;
  private generation = 0;
  private readonly visibility = (): void => { if (document.hidden) this.pause(); else this.start(); };

  constructor(root: HTMLElement,
    private readonly hooks: { onSnapshot(snapshot: SongContextSnapshot): void; onStatus(status: HostedSongContextStatus): void },
    private readonly account = new CloudAccountClient()) {
    this.message.className = "hosted-account-status";
    this.message.setAttribute("role", "status");
    this.message.textContent = "Checking cloud metadata…";
    this.analysisHint.className = "hosted-account-status";
    this.analysisHint.textContent = "Optional analysis sends matched lyrics to OpenAI. Audio and personal colors are never uploaded.";
    root.append(this.connect, this.disconnect, this.signOut, this.analyze, this.message, this.analysisHint);
    this.connect.addEventListener("click", () => { void this.action("connect"); });
    this.disconnect.addEventListener("click", () => { void this.action("disconnect"); });
    this.signOut.addEventListener("click", () => { void this.action("signOut"); });
    this.analyze.addEventListener("click", () => { void this.action("analyze"); });
    this.context.onSnapshot(snapshot => {
      if (!this.active || this.disposed) return;
      this.trackId = !snapshot.stale && snapshot.authenticationStatus === "valid" ? snapshot.currentTrack?.spotifyTrackId ?? null : null;
      this.signedIn = snapshot.authenticationStatus === "valid";
      this.hooks.onSnapshot(snapshot);
      const tagged = (snapshot.lastFm?.trackTags.length ?? 0) + (snapshot.lastFm?.artistTags.length ?? 0) > 0;
      this.message.textContent = this.trackId ? tagged ? "Last.fm song tags active" : "Spotify connected; no song tags available" :
        this.signedIn ? "Waiting for Spotify playback" : "Connect Spotify for song tags";
      this.updateControls();
    });
    this.context.onStatus(status => {
      if (!this.active || this.disposed) return;
      if (status !== "connected") this.trackId = null;
      this.hooks.onStatus(status);
      if (status === "disconnected" && this.signedIn) this.message.textContent = "Song metadata offline. Audio still works.";
      this.updateControls();
    });
    document.addEventListener("visibilitychange", this.visibility);
    this.updateControls();
  }

  start(): void {
    if (this.disposed || this.active || document.hidden) return;
    this.active = true;
    const generation = ++this.generation;
    void this.initialize(generation);
  }

  private async initialize(generation: number): Promise<void> {
    const live = () => this.active && !this.disposed && generation === this.generation;
    try {
      const caps = await this.account.capabilities();
      if (!live()) return;
      this.caps = caps;
      if (!caps.spotify) {
        this.message.textContent = "Cloud metadata not configured. Audio and preview still work.";
        this.updateControls(); return;
      }
      const signedIn = await this.account.signedIn();
      if (!live()) return;
      this.signedIn = signedIn;
      this.message.textContent = this.signedIn ? "Connecting song tags…" : "Connect Spotify for song tags";
      this.updateControls();
      if (this.signedIn) this.context.start();
    } catch {
      if (!live()) return;
      this.message.textContent = "Cloud metadata unavailable. Audio and preview still work.";
      this.updateControls();
    }
  }

  private async action(kind: "connect" | "disconnect" | "signOut" | "analyze"): Promise<void> {
    if (!this.active || this.disposed || this.busy || !this.caps.spotify) return;
    if (kind === "analyze" && (!this.caps.ai || !this.signedIn || this.trackId === null)) return;
    const trackId = this.trackId;
    const generation = ++this.generation;
    this.account.stop();
    if (kind === "disconnect" || kind === "signOut") {
      this.signedIn = false;
      this.context.stop();
      this.clearMetadata(); // Clear first, including when the network operation fails.
    }
    this.busy = true;
    this.updateControls();
    try {
      if (kind === "analyze" && trackId !== null) await this.context.requestAnalysis(trackId);
      else if (kind !== "analyze") await this.account[kind]();
      if (this.disposed || generation !== this.generation) return;
      this.message.textContent = kind === "analyze" ? "Analysis request accepted" : kind === "connect" ? "Opening Spotify…" :
        kind === "disconnect" ? "Spotify disconnected" : "Signed out";
    } catch {
      if (this.disposed || generation !== this.generation) return;
      this.message.textContent = "The request could not finish. Audio and your colors are unchanged.";
    } finally {
      if (!this.disposed && generation === this.generation) { this.busy = false; this.updateControls(); }
    }
  }

  private clearMetadata(): void {
    this.trackId = null;
    this.hooks.onSnapshot({ ...initialSongContext, stale: true });
    this.hooks.onStatus("disconnected");
  }
  private updateControls(): void {
    this.connect.hidden = this.signedIn;
    this.disconnect.hidden = this.signOut.hidden = !this.signedIn;
    this.analyze.hidden = !this.caps.ai || !this.signedIn;
    this.analysisHint.hidden = this.analyze.hidden;
    this.connect.disabled = this.disconnect.disabled = this.signOut.disabled = this.busy || !this.caps.spotify || this.disposed;
    this.analyze.disabled = this.busy || this.trackId === null || this.disposed;
  }
  private pause(): void {
    if (this.disposed) return;
    this.active = false; this.generation++; this.busy = false;
    this.account.stop(); this.context.stop(); this.clearMetadata();
    this.updateControls();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.active = false; this.generation++;
    document.removeEventListener("visibilitychange", this.visibility);
    this.account.stop(); this.context.stop();
    this.updateControls();
  }
}

function button(label: string, key: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button"; element.className = "text-button";
  element.textContent = label; element.dataset[key] = "";
  return element;
}
