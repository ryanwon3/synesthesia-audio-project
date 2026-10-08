import {
  closeEventCode,
  companionAuthenticationCloseCode,
  companionPairUrl,
  companionRequestTimeoutMs,
  isCompanionToken,
  isPairingCode,
  parseCompanionReply,
  parseLeaseExpiry,
  type CompanionReply,
  type CompanionRequest,
} from "./CompanionProtocol";

export type CompanionStatus = "unpaired" | "pairing" | "paired" | "unavailable";

const renewAfterMs = 25 * 60_000;
const renewMarginMs = 5 * 60_000;

type ControlOutcome =
  | { kind: "reply"; reply: CompanionReply }
  | { kind: "authenticationFailed" }
  | { kind: "unavailable" };

interface ControlRequest {
  cancel(): void;
}

const unavailable: ControlOutcome = { kind: "unavailable" };
const authenticationFailed: ControlOutcome = { kind: "authenticationFailed" };

const expectedReplies: Record<CompanionRequest["type"], CompanionReply["type"]> = {
  pair: "paired",
  renew: "renewed",
  disconnect: "disconnected",
};

// Keeps the companion credential in browser memory only. Codes and tokens are
// never persisted, logged, placed in URLs, or echoed in errors. Bootstrap
// delivery is the trusted caller's job; this class adds no window listeners.
export class CompanionClient {
  private readonly statusListeners = new Set<(status: CompanionStatus) => void>();
  private readonly pairUrl: string;
  private status: CompanionStatus = "unpaired";
  private token: string | null = null;
  private expiresAt = 0;
  private epoch = 0;
  private renewTimer = 0;
  private expiryTimer = 0;
  private control: ControlRequest | null = null;
  private rejectPendingPair: ((error: Error) => void) | null = null;

  public constructor(port = 8765) {
    this.pairUrl = companionPairUrl(port);
  }

  public pair(code: string): Promise<void> {
    if (!isPairingCode(code)) {
      this.reset("unpaired");
      return Promise.reject(new Error("Pairing code is not valid."));
    }

    const epoch = this.reset("pairing");
    if (epoch !== this.epoch) {
      return Promise.reject(cancelledError());
    }

    return new Promise<void>((resolve, reject) => {
      this.rejectPendingPair = reject;
      const control = this.openControl({ protocolVersion: 1, type: "pair", code }, (outcome) => {
        if (epoch !== this.epoch) {
          return;
        }

        this.control = null;
        this.rejectPendingPair = null;
        if (outcome.kind === "reply" && outcome.reply.type === "paired" &&
          this.adopt(outcome.reply.token, outcome.reply.expiresAtUtc)) {
          if (epoch === this.epoch) {
            resolve();
          } else {
            reject(cancelledError());
          }
          return;
        }

        this.reset(outcome.kind === "authenticationFailed" ? "unpaired" : "unavailable");
        reject(new Error("Companion pairing failed."));
      });
      if (epoch === this.epoch) {
        this.control = control;
      }
    });
  }

  public credential(): string | null {
    if (this.token === null) {
      return null;
    }

    if (Date.now() >= this.expiresAt) {
      this.reset("unpaired");
      return null;
    }

    return this.token;
  }

  // Clears local state first, then makes one bounded best-effort revoke with
  // the token held at this moment. The reply never restores any state.
  public disconnect(): void {
    const token = this.credential();
    this.reset("unpaired");
    if (token !== null) {
      this.openControl({ protocolVersion: 1, type: "disconnect", token }, () => {});
    }
  }

  public acceptBootstrap(token: string, expiresAtUtc: string): void {
    if (!isCompanionToken(token) || parseLeaseExpiry(expiresAtUtc, Date.now()) === null) {
      this.reset("unpaired");
      return;
    }

    // A bootstrap replaces the family, unlike renewal. Stop old streams before adopting it.
    this.reset("unpaired");
    this.adopt(token, expiresAtUtc);
  }

  public invalidate(): void {
    this.reset("unpaired");
  }

  public onStatus(listener: (status: CompanionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private adopt(token: unknown, expiresAtUtc: unknown): boolean {
    const expiresAt = parseLeaseExpiry(expiresAtUtc, Date.now());
    if (!isCompanionToken(token) || expiresAt === null) {
      return false;
    }

    this.token = token;
    this.expiresAt = expiresAt;
    this.scheduleLease();
    this.setStatus("paired");
    return true;
  }

  // Renews at 25 minutes, or earlier when the server shortened the lease.
  // Leases with no room left for renewal simply expire.
  private scheduleLease(): void {
    this.clearLeaseTimers();
    const epoch = this.epoch;
    const remaining = this.expiresAt - Date.now();
    this.expiryTimer = window.setTimeout(() => {
      if (epoch === this.epoch) {
        this.reset("unpaired");
      }
    }, remaining);
    if (remaining > renewMarginMs) {
      this.renewTimer = window.setTimeout(
        () => this.renew(epoch),
        Math.min(renewAfterMs, remaining - renewMarginMs),
      );
    }
  }

  private renew(epoch: number): void {
    this.renewTimer = 0;
    const token = this.credential();
    if (epoch !== this.epoch || token === null) {
      return;
    }

    this.control?.cancel();
    const control = this.openControl({ protocolVersion: 1, type: "renew", token }, (outcome) => {
      if (epoch !== this.epoch) {
        return;
      }

      this.control = null;
      if (outcome.kind === "reply" && outcome.reply.type === "renewed" &&
        this.adopt(outcome.reply.token, outcome.reply.expiresAtUtc)) {
        return;
      }

      this.reset(outcome.kind === "authenticationFailed" ? "unpaired" : "unavailable");
    });
    if (epoch === this.epoch) {
      this.control = control;
    }
  }

  // Clears the credential and timers and bumps the epoch before closing any
  // control socket, so late replies cannot restore state. Emits status last.
  private reset(status: CompanionStatus | null): number {
    const control = this.control;
    const rejectPendingPair = this.rejectPendingPair;
    this.control = null;
    this.rejectPendingPair = null;
    this.epoch += 1;
    const epoch = this.epoch;
    this.token = null;
    this.expiresAt = 0;
    this.clearLeaseTimers();
    control?.cancel();
    rejectPendingPair?.(cancelledError());
    if (status !== null) {
      this.setStatus(status);
    }

    return epoch;
  }

  private clearLeaseTimers(): void {
    window.clearTimeout(this.renewTimer);
    window.clearTimeout(this.expiryTimer);
    this.renewTimer = 0;
    this.expiryTimer = 0;
  }

  private setStatus(status: CompanionStatus): void {
    if (status === this.status) {
      return;
    }

    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }

  // One /pair socket, one request, one reply, bounded by a deadline that
  // starts at creation. Settles once; cancel and close are idempotent.
  private openControl(request: CompanionRequest, onOutcome: (outcome: ControlOutcome) => void): ControlRequest {
    let socket: WebSocket | null = null;
    let deadline = 0;
    let settled = false;
    const finish = (outcome: ControlOutcome | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(deadline);
      const current = socket;
      socket = null;
      closeQuietly(current);
      if (outcome !== null) {
        onOutcome(outcome);
      }
    };
    const handle: ControlRequest = { cancel: () => finish(null) };
    deadline = window.setTimeout(() => finish(unavailable), companionRequestTimeoutMs);

    const created = openSocket(this.pairUrl);
    if (created === null) {
      finish(unavailable);
      return handle;
    }

    socket = created;
    created.addEventListener("open", () => {
      if (socket !== created) {
        return;
      }

      try {
        created.send(JSON.stringify(request));
      } catch {
        finish(unavailable);
      }
    });
    created.addEventListener("message", (event) => {
      if (socket !== created) {
        return;
      }

      const reply = parseCompanionReply(event.data);
      if (reply?.type === "authenticationFailed") {
        finish(authenticationFailed);
      } else if (reply !== null && reply.type === expectedReplies[request.type]) {
        finish({ kind: "reply", reply });
      } else {
        finish(unavailable);
      }
    });
    created.addEventListener("close", (event) => {
      if (socket === created) {
        finish(closeEventCode(event) === companionAuthenticationCloseCode ? authenticationFailed : unavailable);
      }
    });
    created.addEventListener("error", () => {
      if (socket === created) {
        finish(unavailable);
      }
    });
    return handle;
  }
}

function cancelledError(): Error {
  return new Error("Companion pairing was cancelled.");
}

function openSocket(url: string): WebSocket | null {
  try {
    return new WebSocket(url);
  } catch {
    return null;
  }
}

function closeQuietly(socket: WebSocket | null): void {
  try {
    socket?.close(1000);
  } catch {
    // Closing is best effort.
  }
}
