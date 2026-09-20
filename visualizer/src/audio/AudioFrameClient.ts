import { isAudioFrameMessage, type AudioFrame } from "./AudioFrame";

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface AudioFrameClientStatus {
  state: ConnectionState;
  messagesPerSecond: number;
  lastReceiveAt: number;
}

export class AudioFrameClient {
  private readonly frameListeners = new Set<(frame: AudioFrame) => void>();
  private readonly statusListeners = new Set<(status: AudioFrameClientStatus) => void>();
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private stopped = true;
  private messagesThisWindow = 0;
  private rateWindowStartedAt = performance.now();
  private status: AudioFrameClientStatus = {
    state: "disconnected",
    messagesPerSecond: 0,
    lastReceiveAt: 0,
  };

  public constructor(private readonly url: string) {}

  public get currentStatus(): AudioFrameClientStatus {
    return { ...this.status };
  }

  public onFrame(listener: (frame: AudioFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  public onStatus(listener: (status: AudioFrameClientStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  public start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Visualizer stopped");
    this.socket = null;
    this.setState("disconnected");
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.setState("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (socket !== this.socket) {
        return;
      }

      this.reconnectAttempt = 0;
      this.setState("connected");
    });

    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.handleDisconnect(socket));
    socket.addEventListener("error", () => socket.close());
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (typeof event.data !== "string") {
      return;
    }

    try {
      const message: unknown = JSON.parse(event.data);
      if (!isAudioFrameMessage(message)) {
        return;
      }

      const now = performance.now();
      this.messagesThisWindow += 1;
      const elapsed = now - this.rateWindowStartedAt;
      if (elapsed >= 1000) {
        this.status.messagesPerSecond = this.messagesThisWindow * 1000 / elapsed;
        this.messagesThisWindow = 0;
        this.rateWindowStartedAt = now;
      }

      this.status.lastReceiveAt = now;
      this.emitStatus();
      for (const listener of this.frameListeners) {
        listener(message.payload);
      }
    } catch {
      // Ignore malformed local messages and keep the connection alive.
    }
  }

  private handleDisconnect(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }

    this.socket = null;
    this.status.lastReceiveAt = 0;
    this.status.messagesPerSecond = 0;
    this.setState("disconnected");
    if (this.stopped) {
      return;
    }

    const delay = Math.min(5000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 4);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private setState(state: ConnectionState): void {
    this.status.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    const snapshot = this.currentStatus;
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
  }
}
