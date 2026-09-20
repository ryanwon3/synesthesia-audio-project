# Last.fm Metadata Setup and Verification

Last.fm enrichment is optional. Recognized tags now guide visual context, while
diagnostics exposes matching and recovery information. It reads public track and
artist top tags; it does not require a Last.fm user login and does not influence
`VisualContextEngine`, Three.js, colors, shaders, or calibration.

## Setup

1. Create a Last.fm API account and obtain an API key from the Last.fm API site.
2. Start Spotify Synesthesia and open diagnostics with `D` or the bug button.
3. In the Last.fm section, choose `Configure`.
4. Enter the API key in the native Windows dialog and choose `Save`.

The key is encrypted for the current Windows user with DPAPI and stored at
`%LOCALAPPDATA%\SpotifySynesthesia\auth\lastfm-api-key.dat`. It is never sent to
the WebView, `/song-context`, diagnostics, or application logs. The provider
receives it over HTTPS as required by its API. Use `Remove` in the same dialog to
delete the local credential.

Review Last.fm's current terms before commercial or research use. Song titles,
artist names, and the API key are sent to Last.fm when an uncached lookup runs.
Last.fm tags are user-generated and may be noisy or objectionable.

## Data and cache behavior

- Track tags describe the specific recording; artist tags describe the primary
  Spotify artist. The collections remain separate.
- Tag names are normalized for Unicode, case, and whitespace. Provider counts are
  normalized independently per collection to `0..1`; missing counts remain null.
- Successful results remain cached until matching inputs or the enrichment schema
  change. `NoMatch` is cached for 30 days. Transient failures are not valid cache.
- The data lives inside `metadata_json` in the existing SongProfile database at
  `%LOCALAPPDATA%\SpotifySynesthesia\data\song-profiles.db`.
- Manual cache refresh is intentionally deferred. Replacing the key retries the
  active uncached profile; ordinary transient failures retry on later activation.
- Rate limits pause all Last.fm lookups for the provider's `Retry-After` period,
  or 60 seconds when none is supplied. The still-active uncached profile is
  requeued once after that provider-wide cooldown.

## Diagnostic states

`Not configured`, `Not attempted`, `Insufficient identity`, `Fetching`,
`Succeeded`, `No match`, `Unavailable`, `Rate limited`, `Invalid credentials`,
and `Error` distinguish setup, matching, provider, and persistence conditions.
A successful response with no useful tags is still `Succeeded`. Diagnostics also
show whether the result was fetched or cached, matched identity, retrieval time,
sanitized error category, and a rate-limit retry time when applicable.

## Manual scenarios

### A. First uncached song

Play Song A after configuration. Confirm `Fetching` becomes `Succeeded`, source is
`Fetched`, separate track/artist tags appear, and the SongProfile remains loaded.

### B. Replay Song A

Leave and return to Song A. Confirm source is `Cached` and no new fetch is shown.

### C. Song B

Play an uncached Song B. Confirm its matched names and tags correspond to Song B.

### D. Rapid A to B

Switch quickly while A is fetching. A may finish caching, but diagnostics must
remain on B and later show only B's completion.

### E. Internet disconnect

Disconnect before playing an uncached song. Confirm Last.fm reports `Unavailable`
while capture, `/audio` sequence, DSP diagnostics, and the painting continue.

### F. Invalid credential

Replace the key with an invalid value. Confirm `Invalid credentials`, no secret
text in diagnostics, and unchanged Spotify metadata/audio. Restore the valid key
to recover. If no real key or internet access is available, report these scenarios
as unverified rather than inferring success from mocked tests.
