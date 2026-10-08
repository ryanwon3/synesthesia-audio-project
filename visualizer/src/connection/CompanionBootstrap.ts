import type { CompanionClient } from "./CompanionClient";
import {
  companionProtocolVersion,
  isCompanionPort,
  isCompanionToken,
  parseLeaseExpiry,
} from "./CompanionProtocol";

// Delivers the bundled renderer's short-lived companion credential from the
// trusted WebView2 host bridge. See docs/companion-connection-protocol.md.
export interface CompanionWebViewBridge {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

type BridgeListener = (event: { data: unknown }) => void;

interface CompanionBootstrap {
  token: string;
  expiresAtUtc: string;
}

// Registers the bridge listener before posting the ready request so a reply
// delivered during postMessage is not lost. Only the exact bundled root or
// index source on the expected loopback port is trusted. Fails closed without
// throwing or surfacing native errors; cleanup is idempotent and late
// callbacks have no effect.
export function attachCompanionBootstrap(
  client: CompanionClient,
  bridge: CompanionWebViewBridge | undefined,
  source: string,
  port: number,
): () => void {
  if (bridge === undefined || !isTrustedSource(source, port)) {
    return () => {};
  }

  let active = true;
  const listener: BridgeListener = (event) => {
    if (!active) {
      return;
    }

    const bootstrap = readBootstrap(event, port);
    if (bootstrap !== null) {
      client.acceptBootstrap(bootstrap.token, bootstrap.expiresAtUtc);
    }
  };
  const cleanup = (): void => {
    if (!active) {
      return;
    }

    active = false;
    try {
      bridge.removeEventListener("message", listener);
    } catch {
      // Removal is best effort; the listener is already inactive.
    }
  };

  try {
    bridge.addEventListener("message", listener);
  } catch {
    cleanup();
    return cleanup;
  }

  try {
    bridge.postMessage({ protocolVersion: companionProtocolVersion, type: "companionBootstrapReady" });
  } catch {
    cleanup();
  }

  return cleanup;
}

// Exact string match only; no URL parsing or normalization.
function isTrustedSource(source: string, port: number): boolean {
  if (!isCompanionPort(port)) {
    return false;
  }

  const root = `http://127.0.0.1:${port}/`;
  return source === root || source === `${root}index.html`;
}

// Reads each field once so accessor-backed values cannot change between
// validation and adoption. Anything unexpected, including a throwing
// accessor, is ignored without surfacing native error text.
function readBootstrap(event: { data: unknown }, port: number): CompanionBootstrap | null {
  try {
    const data = event.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }

    const { protocolVersion, type, port: payloadPort, token, expiresAtUtc } = data as Record<string, unknown>;
    if (protocolVersion !== companionProtocolVersion || type !== "companionBootstrap" ||
      payloadPort !== port || !isCompanionToken(token) || typeof expiresAtUtc !== "string" ||
      parseLeaseExpiry(expiresAtUtc, Date.now()) === null) {
      return null;
    }

    return { token, expiresAtUtc };
  } catch {
    return null;
  }
}
