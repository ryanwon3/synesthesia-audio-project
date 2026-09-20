import { isSongContextMessage, normalizeSongContext, type SongContextSnapshot } from "./SongContext";

export type SongContextConnectionState = "connecting" | "connected" | "disconnected";

export class SongContextClient {
  private readonly listeners = new Set<(snapshot: SongContextSnapshot) => void>();
  private readonly statusListeners = new Set<(status: SongContextConnectionState) => void>();
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private stopped = true;

  public constructor(private readonly url: string) {}

  public onSnapshot(listener: (snapshot: SongContextSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onStatus(listener: (status: SongContextConnectionState) => void): () => void {
    this.statusListeners.add(listener);
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
    this.emitStatus("disconnected");
  }

  public configureAndConnect(clientId?: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.socket.send(JSON.stringify({
      protocolVersion: 1,
      type: "configureAndConnectSpotify",
      clientId: clientId?.trim() || null,
    }));
    return true;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }

    this.emitStatus("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (socket === this.socket) {
        this.reconnectAttempt = 0;
        this.emitStatus("connected");
      }
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
      if (isSongContextMessage(message)) {
        const snapshot = normalizeSongContext(message.payload);
        for (const listener of this.listeners) {
          listener(snapshot);
        }
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
    this.emitStatus("disconnected");
    if (this.stopped) {
      return;
    }

    const delay = Math.min(5000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 4);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private emitStatus(status: SongContextConnectionState): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
