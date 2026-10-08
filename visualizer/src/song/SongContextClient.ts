import { isSongContextMessage, normalizeSongContext, type SongContextSnapshot } from "./SongContext";
import {
  authenticateMessage,
  closeEventCode,
  companionAuthenticationCloseCode,
  companionRequestTimeoutMs,
  isAuthenticationFailedMessage,
  isCompanionToken,
  isStreamAuthenticated,
  loopbackStreamUrl,
  parseHandshakeText,
  reconnectDelayMs,
  streamReconnectMaxAttempts,
} from "../connection/CompanionProtocol";

export type SongContextConnectionState = "connecting" | "connected" | "disconnected";

export class SongContextClient {
  private readonly listeners = new Set<(snapshot: SongContextSnapshot) => void>();
  private readonly statusListeners = new Set<(status: SongContextConnectionState) => void>();
  private readonly endpoint: string | null;
  private socket: WebSocket | null = null;
  private authenticated = false;
  private reconnectTimer = 0;
  private handshakeTimer = 0;
  private reconnectAttempt = 0;
  private stopped = true;

  // Only the exact loopback /song-context endpoint ever receives the
  // credential. An invalid URL or a missing credential stays disconnected.
  public constructor(
    url: string,
    private readonly getCredential: () => string | null = () => null,
    private readonly onAuthenticationRequired: () => void = () => {},
  ) {
    this.endpoint = loopbackStreamUrl(url, "/song-context");
  }

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
    this.reconnectAttempt = 0;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    this.releaseSocket();
    this.emitStatus("disconnected");
  }

  // Commands go only to the current socket after the companion acknowledged
  // authentication; an open but unauthenticated socket is not enough.
  public configureAndConnect(clientId?: string): boolean {
    const socket = this.socket;
    if (socket === null || !this.authenticated || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(JSON.stringify({
        protocolVersion: 1,
        type: "configureAndConnectSpotify",
        clientId: clientId?.trim() || null,
      }));
    } catch {
      return false;
    }

    return true;
  }

  private connect(): void {
    this.reconnectTimer = 0;
    if (this.stopped) {
      return;
    }

    if (this.endpoint === null || !isCompanionToken(this.getCredential())) {
      this.stop();
      return;
    }

    this.emitStatus("connecting");
    if (this.stopped) {
      return;
    }

    const socket = openSocket(this.endpoint);
    if (socket === null) {
      this.emitStatus("disconnected");
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.authenticated = false;
    this.handshakeTimer = window.setTimeout(() => this.handleDrop(socket), companionRequestTimeoutMs);
    socket.addEventListener("open", () => this.handleOpen(socket));
    socket.addEventListener("message", (event) => this.handleMessage(socket, event));
    socket.addEventListener("close", (event) => this.handleClose(socket, event));
    socket.addEventListener("error", () => this.handleDrop(socket));
  }

  private handleOpen(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }

    const credential = this.getCredential();
    if (!isCompanionToken(credential)) {
      this.stop();
      return;
    }

    try {
      socket.send(authenticateMessage(credential));
    } catch {
      this.handleDrop(socket);
    }
  }

  private handleMessage(socket: WebSocket, event: MessageEvent<unknown>): void {
    if (socket !== this.socket) {
      return;
    }

    if (!this.authenticated) {
      this.handleHandshake(socket, parseHandshakeText(event.data));
      return;
    }

    if (typeof event.data !== "string") {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(event.data);
    } catch {
      // Ignore malformed local messages and keep the connection alive.
      return;
    }

    if (isAuthenticationFailedMessage(message)) {
      this.handleAuthenticationFailure(socket);
      return;
    }

    if (!isSongContextMessage(message)) {
      return;
    }

    try {
      const snapshot = normalizeSongContext(message.payload);
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    } catch {
      // A failing listener must not tear down the local connection.
    }
  }

  // Before acknowledgement only a bounded authenticated/authenticationFailed
  // reply matters; snapshots and anything else are ignored.
  private handleHandshake(socket: WebSocket, message: unknown): void {
    if (isAuthenticationFailedMessage(message)) {
      this.handleAuthenticationFailure(socket);
      return;
    }

    if (!isStreamAuthenticated(message, Date.now())) {
      return;
    }

    this.authenticated = true;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = 0;
    this.reconnectAttempt = 0;
    this.emitStatus("connected");
  }

  private handleClose(socket: WebSocket, event: Event): void {
    if (socket !== this.socket) {
      return;
    }

    if (closeEventCode(event) === companionAuthenticationCloseCode) {
      this.handleAuthenticationFailure(socket);
    } else {
      this.handleDrop(socket);
    }
  }

  // Authentication failures never retry; the app re-pairs and restarts.
  private handleAuthenticationFailure(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }

    this.stopped = true;
    this.releaseSocket();
    this.emitStatus("disconnected");
    this.onAuthenticationRequired();
  }

  private handleDrop(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }

    this.releaseSocket();
    this.emitStatus("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }

    if (this.reconnectAttempt >= streamReconnectMaxAttempts) {
      this.stopped = true;
      return;
    }

    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  // Detaches the socket before closing it so a synchronous close event is
  // treated as stale.
  private releaseSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.handshakeTimer);
    this.reconnectTimer = 0;
    this.handshakeTimer = 0;
    try {
      socket?.close(1000);
    } catch {
      // Closing is best effort.
    }
  }

  private emitStatus(status: SongContextConnectionState): void {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

function openSocket(url: string): WebSocket | null {
  try {
    return new WebSocket(url);
  } catch {
    return null;
  }
}
