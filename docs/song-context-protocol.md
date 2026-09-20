# Song Context Protocol

Song context uses `ws://127.0.0.1:8765/song-context`. It is independent from the
30 Hz `/audio` transport. The backend retains one latest snapshot and sends it
immediately to a reconnecting client.

Server messages use protocol version 1 and type `songContext`. The payload has
strongly typed `metadataStatus` and `authenticationStatus` values plus current
track identity, stale/update/retry timing, active SongProfile, profile source,
SQLite state/path, and the active polling interval.

Protocol v1 also permits an additive nullable `lastFm` object. It contains the
typed enrichment status, `cached`/`fetched` source, separate track and artist tag
arrays, matched names and optional MusicBrainz IDs, match quality, retrieval time,
sanitized error category, and retry time. Older v1 snapshots may omit this field.
The additive `openAiConfigured` boolean reports only whether a protected key is
present. Older v1 snapshots may omit it and clients treat omission as `false`.

The browser may send this command with a new client ID or `null` to reuse the
stored ID:

```json
{
  "protocolVersion": 1,
  "type": "configureAndConnectSpotify",
  "clientId": "spotify-client-id"
}
```

Access tokens, refresh tokens, authorization codes, PKCE values, raw API bodies,
raw exceptions, Last.fm or OpenAI API keys, and provider request URLs are never
part of this protocol. Secret setup uses native WPF dialogs rather than WebSocket
commands.
The additive nullable `lyricsAnalysis` object reports status, source, `timed`,
`cached`, sanitized `error`, and a normalized `profile`. The profile contains
`wholeSong` mood/energy/tension/softness/imagery/effect preferences and zero or
more `sections` with `startMs`, `endMs`, and the same traits. No raw lyric text
crosses this protocol. `lyricsSettings` reports `automatic` and `model`; it
contains no credentials. Legacy clients can ignore both fields.

The native WebView bridge additionally accepts `openOpenAiSetup` and
`reanalyzeLyrics` messages (protocolVersion 1) only from the trusted local page.
The latter opens a native credit-use confirmation; it is not a WebSocket command.
The `/audio` channel separately adds optional per-band pitch/attack objects.
