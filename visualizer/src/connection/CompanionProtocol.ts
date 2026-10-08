// Network-free validation for the v1 companion connection protocol. See
// docs/companion-connection-protocol.md. Values passed through here may be
// secrets: never log them or include them in errors.

export const companionProtocolVersion = 1;
export const companionAuthenticationCloseCode = 4401;
export const companionRequestTimeoutMs = 5_000;
export const companionHandshakeMaxBytes = 1024;
export const companionMaxLeaseMs = 8 * 60 * 60_000;
export const streamReconnectMaxAttempts = 5;

export type CompanionStreamPath = "/audio" | "/song-context";

export type CompanionRequest =
  | { protocolVersion: 1; type: "pair"; code: string }
  | { protocolVersion: 1; type: "renew" | "disconnect"; token: string };

export type CompanionReply =
  | { type: "paired" | "renewed"; token: unknown; expiresAtUtc: unknown }
  | { type: "disconnected" | "authenticationFailed" };

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const codePattern = /^[A-Za-z0-9_-]{22}$/;
const isoInstantPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/;
const streamUrlPattern = /^ws:\/\/127\.0\.0\.1:([1-9]\d{3,4})(\/[a-z-]{1,32})$/;

export function isCompanionToken(value: unknown): value is string {
  return typeof value === "string" && value.length === 43 && tokenPattern.test(value);
}

export function isPairingCode(value: unknown): value is string {
  return typeof value === "string" && value.length === 22 && codePattern.test(value);
}

export function isCompanionPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function companionPairUrl(port: unknown): string {
  if (!isCompanionPort(port)) {
    throw new RangeError("Companion port must be an integer from 1024 to 65535.");
  }

  return `ws://127.0.0.1:${port}/pair`;
}

// Accepts only the exact loopback literal, a numeric port, and the expected
// path. Queries, fragments, userinfo, other hosts, and other schemes fail.
export function loopbackStreamUrl(url: unknown, path: CompanionStreamPath): string | null {
  if (typeof url !== "string" || url.length > 64) {
    return null;
  }

  const match = streamUrlPattern.exec(url);
  if (match === null || match[2] !== path || !isCompanionPort(Number(match[1]))) {
    return null;
  }

  return url;
}

// Returns the lease end in epoch milliseconds when it is a strict ISO-8601
// instant in the future and within the absolute session bound.
export function parseLeaseExpiry(value: unknown, now: number): number | null {
  if (typeof value !== "string" || value.length > 40) {
    return null;
  }

  const match = isoInstantPattern.exec(value);
  if (match === null) {
    return null;
  }

  const fraction = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const expiresAt = Date.parse(`${match[1]}.${fraction}${match[3]}`);
  return Number.isFinite(expiresAt) && expiresAt > now && expiresAt - now <= companionMaxLeaseMs
    ? expiresAt
    : null;
}

// Parses a bounded handshake text message; returns undefined for non-text,
// oversized, or malformed input.
export function parseHandshakeText(data: unknown): unknown {
  if (typeof data !== "string" || data.length > companionHandshakeMaxBytes ||
    utf8ByteLength(data) > companionHandshakeMaxBytes) {
    return undefined;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

export function parseCompanionReply(data: unknown): CompanionReply | null {
  const value = parseHandshakeText(data);
  if (!isRecord(value) || value.protocolVersion !== companionProtocolVersion) {
    return null;
  }

  const type = value.type;
  if (type === "paired" || type === "renewed") {
    return { type, token: value.token, expiresAtUtc: value.expiresAtUtc };
  }

  if (type === "disconnected" || type === "authenticationFailed") {
    return { type };
  }

  return null;
}

export function isStreamAuthenticated(value: unknown, now: number): boolean {
  return isRecord(value) &&
    value.protocolVersion === companionProtocolVersion &&
    value.type === "authenticated" &&
    parseLeaseExpiry(value.expiresAtUtc, now) !== null;
}

export function isAuthenticationFailedMessage(value: unknown): boolean {
  return isRecord(value) &&
    value.protocolVersion === companionProtocolVersion &&
    value.type === "authenticationFailed";
}

export function authenticateMessage(token: string): string {
  return JSON.stringify({ protocolVersion: companionProtocolVersion, type: "authenticate", token });
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(5000, 500 * 2 ** attempt);
}

export function closeEventCode(event: Event): number {
  const code: unknown = (event as Partial<CloseEvent>).code;
  return typeof code === "number" ? code : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}
