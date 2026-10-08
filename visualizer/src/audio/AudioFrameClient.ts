import { isAudioFrameMessage, type AudioFrame } from "./AudioFrame";
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

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface AudioFrameClientStatus {
  state: ConnectionState;
  messagesPerSecond: number;
  lastReceiveAt: number;
}

export class AudioFrameClient {
  private readonly frameListeners = new Set<(frame: AudioFrame) => void>();
  private readonly statusListeners = new Set<(status: AudioFrameClientStatus) => void>();
  private readonly endpoint: string | null;
  private socket: WebSocket | null = null;
  private authenticated = false;
  private reconnectTimer = 0;
  private handshakeTimer = 0;
  private reconnectAttempt = 0;
  private stopped = true;
  private messagesThisWindow = 0;
  private rateWindowStartedAt = performance.now();
  private status: AudioFrameClientStatus = {
    state: "disconnected",
    messagesPerSecond: 0,
    lastReceiveAt: 0,
  };

  // Only the exact loopback /audio endpoint ever receives the credential. An
  // invalid URL or a missing credential leaves the client disconnected.
  public constructor(
    url: string,
    private readonly getCredential: () => string | null = () => null,
    private readonly onAuthenticationRequired: () => void = () => {},
  ) {
    this.endpoint = loopbackStreamUrl(url, "/audio");
  }

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
    this.reconnectAttempt = 0;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    this.releaseSocket();
    this.setState("disconnected");
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

    this.setState("connecting");
    if (this.stopped) {
      return;
    }

    const socket = openSocket(this.endpoint);
    if (socket === null) {
      this.setState("disconnected");
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

    if (!isAudioFrameMessage(message)) {
      return;
    }

    try {
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
      // A failing listener must not tear down the local connection.
    }
  }

  // Before acknowledgement only a bounded authenticated/authenticationFailed
  // reply matters; frames and anything else are ignored.
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
    this.setState("connected");
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
    this.setState("disconnected");
    this.onAuthenticationRequired();
  }

  private handleDrop(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }

    this.releaseSocket();
    this.setState("disconnected");
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
    this.messagesThisWindow = 0;
    this.rateWindowStartedAt = performance.now();
    this.status.messagesPerSecond = 0;
    this.status.lastReceiveAt = 0;
    try {
      socket?.close(1000);
    } catch {
      // Closing is best effort.
    }
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

function openSocket(url: string): WebSocket | null {
  try {
    return new WebSocket(url);
  } catch {
    return null;
  }
}
