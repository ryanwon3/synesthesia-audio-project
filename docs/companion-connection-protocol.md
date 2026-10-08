# Companion Connection Protocol (v1)

## Current status (2026-10-08)

This document describes the v1 connection contract. Server enforcement,
browser connection primitives, and desktop/main-UI composition have passed
source review and automated verification. Real-browser and desktop acceptance
are still pending:

- Implemented: the exact-origin allowlist configuration
  (`AudioFrameWebSocketServerOptions.OriginPolicy`), the explicit native
  diagnostic policy setting, and the data-only protocol constants and message
  shapes in `Server/CompanionConnectionProtocol.cs`.
- Implemented and unit-tested: one-time challenges, origin-bound memory-only
  credentials, rotation, expiry, attempt limits, and the four-session capacity.
- Implemented and integration-tested: `/pair`, and authentication before
  payloads or commands on both `/audio` and `/song-context`. Initial messages
  have byte/deadline bounds; admitted sockets are bounded and tracked.
- Implemented and fake-socket-tested: memory-only browser pairing, renewal,
  authenticated stream acknowledgements, stale-event rejection, and bounded
  reconnect attempts.
- Implemented and build-tested: desktop pairing controls, main-UI composition,
  exact-source WebView bootstrap, and navigation restrictions. The bootstrap
  helper is covered by fake-bridge tests, not a real WebView run.
- Independent review identified renewal/disconnect, stalled-send, and repeated
  bootstrap edge cases. Their corrections passed focused regressions and
  source re-review. Actual local-socket tests also cover admission capacity,
  pending-auth shutdown/restart, and idle expiry; simulated browser tests cover
  repeated bootstrap and duplicate/invalid pairing-dialog submissions.
- Historical foundation verification: complete Debug and Release builds passed with zero .NET
  warnings/errors; Release solution tests passed 328 audio-engine and 17
  TestTonePlayer cases, and the frontend suite passed 62 cases. This is a
  source/automated checkpoint, not end-to-end acceptance.
- **Not accepted end to end:** real Chrome/Edge permission and bundled desktop
  fallback checks have not been performed. The user subsequently permitted
  opening the app, and deferred music/visual user testing. The companion is open
  for the exact protected pilot origin; do not infer acceptance from that fact.

At the October8,17:08 source checkpoint, full frontend355, cloud190,
audio-engine364 and diagnostic17 tests passed; seven real PostgreSQL tests were
skipped. Debug Windows and a separate-output Release build passed. The normal
Release replacement failed because the open app locked its executable; it was
not force-closed. Earlier nine live handshake checks admitted only the exact
configured Origin for `/pair`, `/audio` and `/song-context` (101 vs foreign/absent
Origin403); no credentials or application messages were sent/read. Those checks
do not establish browser pairing or actual Spotify isolation. See
[current pilot evidence](mvp-pilot.md) for source-versus-deployed boundaries.

The AudioFrame and song-context payloads and their versions are unchanged. This
is a separate connection protocol.

## Origins

- A browser connection is accepted only if its WebSocket upgrade `Origin` header
  matches the allowlist exactly (scheme, host, and port). The origin always comes
  from the validated upgrade header and never from a JSON field.
- The allowlist contains the bundled origin `http://127.0.0.1:{port}` plus any
  exact origins that are explicitly configured: public HTTPS origins and
  explicitly configured loopback HTTP development origins. There is no implicit
  `localhost`, development, or wildcard trust. Configured entries that contain
  paths, credentials, queries, fragments, or wildcards fail at startup.
- A missing `Origin` header (a native client) is denied by default
  (`NativeDiagnosticPolicy.RequireAuthentication`). The opt-in
  `AllowUnauthenticatedLoopbackDiagnostics` policy is loopback-only, is meant
  for diagnostics, and is never the shipping default.
- When an origin is denied, the companion allocates no session state and counts
  nothing against rate limits.

## Pairing: `/pair`

`ws://127.0.0.1:{port}/pair` uses the same origin gate. The client must send one
text message within 5 seconds. The message is limited to 1024 bytes, measured
across all fragments combined. After replying, the companion closes the socket.

Requests (`protocolVersion` must be `1`):

```json
{ "protocolVersion": 1, "type": "pair", "code": "<one-time-code>" }
{ "protocolVersion": 1, "type": "renew", "token": "<ephemeral-token>" }
{ "protocolVersion": 1, "type": "disconnect", "token": "<ephemeral-token>" }
```

Responses:

```json
{ "protocolVersion": 1, "type": "paired", "token": "<ephemeral-token>", "expiresAtUtc": "2026-10-08T12:30:00+00:00" }
{ "protocolVersion": 1, "type": "renewed", "token": "<ephemeral-token>", "expiresAtUtc": "2026-10-08T13:00:00+00:00" }
{ "protocolVersion": 1, "type": "disconnected" }
{ "protocolVersion": 1, "type": "authenticationFailed" }
```

`authenticationFailed` is deliberately generic. It never contains a secret, a
reason, or an echo of the request.

## Streams: `/audio` and `/song-context`

Before the companion sends any frame or snapshot, or accepts any command, the
first message must be:

```json
{ "protocolVersion": 1, "type": "authenticate", "token": "<ephemeral-token>" }
```

On success the reply contains only the expiry. It never includes the token or a
session ID:

```json
{ "protocolVersion": 1, "type": "authenticated", "expiresAtUtc": "2026-10-08T12:30:00+00:00" }
```

On failure, an oversized message, or a missed 5-second deadline, the socket
closes with status `4401`.

Values shown in angle brackets are placeholders, not usable secrets.

## Lifetimes and limits

- Pairing challenge: valid for 5 minutes, single use.
- Token lease: 30 minutes. Renewal rotates the token and keeps the session.
  Browsers renew at 25 minutes. Old tokens cannot open new sockets.
- To handle disconnect racing a lost renewal reply, only the immediately prior
  token may disconnect its own same-origin session for less than 10 seconds
  after rotation. It still cannot authenticate or renew. The manager zeroes
  the prior hash on the next rotation, grace expiry, session expiry, or revoke.
- Absolute session lifetime: 8 hours.
- At most 4 live sessions in total, including the bundled renderer's session.
- At most 32 simultaneous admitted WebSockets, including pending initial
  authentication and pairing requests. Excess attempts are rejected before
  upgrade; this is separate from the four-session capacity.
- Failed attempts: 5 per origin and 20 globally per minute, in fixed windows.
- An explicit `disconnect` or a companion restart revokes sessions. A transient
  socket close does not. `RevokeAll` clears pending challenges and keeps
  failure history, so revoking cannot be used to reset rate limits.
- The server session manager stores secrets hashed and compares them in fixed
  time.

## Secret handling

- Codes and tokens never appear in URLs.
- Browsers keep tokens in memory only: no `localStorage`, `sessionStorage`,
  IndexedDB, Cache Storage, logs, or other persistence.
- Raw PCM never leaves the machine. Only normalized frames and context are
  streamed locally.

## Bundled WebView bootstrap

The bundled renderer registers a bridge-specific listener before sending:

```json
{ "protocolVersion": 1, "type": "companionBootstrapReady" }
```

The desktop synchronously validates both the requesting source and the
WebView's current document as exactly `http://127.0.0.1:{port}/` or
`/index.html`, with no query or fragment. Only then does it send
`PostWebMessageAsJson`:

```json
{ "protocolVersion": 1, "type": "companionBootstrap", "token": "<ephemeral-token>", "expiresAtUtc": "2026-10-08T12:30:00+00:00", "port": 8765 }
```

The desktop retains the internal session ID only in memory. A reload replaces
only that local session, even after browser renewal, without consuming another
slot or revoking hosted sessions. Neither the ID nor API keys enter the message.
Credentials are never injected through scripts or posted to arbitrary frames.
Unexpected navigation and new WebView windows are blocked.

The optional nonsecret `SYNESTHESIA_HOSTED_ORIGIN` startup variable selects one
validated exact HTTPS origin. It is not an API-key setting. No value means
bundled-only mode. Changing it requires restarting the app; opening the hosted
page uses only the active validated origin. The diagnostic Host supports up to
eight explicit `--allowed-origin` values, but does not display codes or mint
browser credentials through a route.

Stream payload sends have a one-second cancellation deadline. A stalled
transport is aborted rather than retaining admission indefinitely; it may not
be able to receive a `4401` close frame. Cooperative revoked/expired streams
receive `4401`. A transport drop does not revoke an otherwise valid lease.

## Other routes

- `/health` reports non-sensitive health only. It is not an authentication or
  credential-issuance route.
- The Spotify OAuth callback `state` is verified by the independent Spotify
  subsystem. This protocol does not change or audit that flow.
- Static file routes do not serve pairing or bootstrap credentials.

## Browser loopback permission

Connecting from a hosted HTTPS page to a loopback WebSocket is subject to
browser local-network-access permission. See the Microsoft Edge 147 release
notes:
[Local Network Access restrictions for WebSockets](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/147#local-network-access-restrictions-for-websockets).
No runtime browser check has been performed. Verification requires real
Chrome/Edge accept and deny runs without disabled-security flags. When the
companion is unreachable, the page must show a clear, bounded "unavailable"
state rather than retrying forever.
