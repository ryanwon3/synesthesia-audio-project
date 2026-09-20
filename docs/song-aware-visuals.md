# Song-aware visual layers

Audio remains the immediate driver. Bass attacks launch expanding ripples with
an edge-trigger/rearm gate; a sustained tone does not repeatedly spawn rings.
Midrange and treble have independent energy, chroma, confidence, and attack.
These are spectral bands, not separated instruments or vocal stems.

The existing FFT supplies all three bands. The background service handles
Spotify, Last.fm, LRCLIB, OpenAI, and SQLite. No external I/O is introduced into
the capture/DSP callback. The renderer receives normalized layer colors,
energies, softness and effect weights, never lyrics, keys, or service bodies.

## Colors and effects

Personal pitch colors are preserved and selected by default to respect the
project's current ownership rule. A user can explicitly select Mood palette in
Calibration. That mode maps pitches C through B across a locally configured
OKLab-interpolated gradient; AI returns a mood category, never hex colors.
Each layer has slightly different lightness. Low-confidence bands use a stable
palette center. Personal mode keeps the previous layer color when confidence is low.

Editable mood/tag rules live in `visualizer/src/song/SongVisualProfile.ts`.
Sad uses blue/indigo/violet; dreamy uses lavender/cyan/pink; joyful uses
gold/peach/coral; tense uses crimson/amber/violet; calm uses teal/blue/jade;
dark uses indigo/plum/crimson. Pop alone does not imply sadness. Track tags
are weighted more strongly than artist tags. Unknown personal tags do not match.

Each band has one anchor family and one context-selected family from ripples,
ribbons, clouds, sparks, and fragments. A transition may temporarily contain
the outgoing and incoming families. Context and palettes settle approximately
95% within three seconds; audio energy responds in roughly 90 ms.

## Lyrics and analysis

LRCLIB exact lookup is accepted only when normalized title/artist match and
duration is within two seconds. Nonempty album names must also agree. No fuzzy
or ambiguous search result is accepted. Missing and instrumental lyrics are
normal fallbacks to audio and tags. LRC timestamps are parsed locally, including
repeated timestamps and offsets. Plain lyrics never acquire invented timestamps.

Automatic analysis is on by default but requires a configured key and ten seconds
of observed continuous playback. There is one serialized job, cancellation on
track change, and an attempt guard against repeated paid requests on failures.
Matched lyrics, song identity, and recognized tags are sent to the official
OpenAI Responses endpoint with `store:false`, strict Structured Outputs, a 24,000
character lyric limit, and a 5,000 output-token limit. Default model: gpt-5-mini;
the settings dialog also offers gpt-5. Saving an API key is separate from the
automatic-analysis preference. Refusals, incomplete/invalid output, quota and
authentication errors are safe fallback states. Provider rate/server errors get
at most two delayed retries, honoring Retry-After; delays over two minutes end
the attempt rather than retrying early. Ambiguous transport failures are not
automatically retried to avoid duplicate spending.

The model chooses section line indices, not times. Local validation rejects
out-of-range/overlapping sections and maps indices to provider timestamps. Gaps
beyond twelve seconds after a final lyric use whole-song traits. Playback uses
Spotify's observed position, respects pause/stale states, seeks, and replay.

The separate `lyrics_visual_cache` SQLite table stores lyrics and validated
analysis, keyed by track identity, lyric hash, model, prompt version and schema
version. Replay loads it without any network request, even when automation is
off. Manual Reanalyze refreshes lyrics and analysis after a credit-use confirmation.
The table does not overwrite Last.fm metadata or personal override columns.
An optional `reserved.personalOverrides.visualProfile` with the normalized
wholeSong/sections shape takes precedence in the mapping layer.

## Verification

`visualizer/verification.html` is a development-only synthetic preview with
separate bass, mid, treble, and silence cases; it makes no service requests and
is not part of the desktop production build. `tools/LyricsProbe` does a single
public LRCLIB diagnostic; `--analyze` explicitly adds one bounded paid OpenAI
request. It prints only result categories and counts, never lyrics or keys.

Automated coverage includes band isolation, sustained attack gating, mood
classification, palette bounds, timestamp parsing, section seeking/pausing,
malformed/refused/incomplete responses, provider identity rejection, API error
categories, cached replay, paused tracks, late-result isolation and preservation
of unrelated SQLite data. Real-world listening with multiple Spotify songs
remains necessary to tune this to the user's synesthesia; synthetic checks are
not a claim of instrument separation, audible output, or perceptual fidelity.

### Verification recorded 2026-09-19

- Full .NET suite: 134 engine tests and 17 diagnostic-player tests passed.
- Frontend: 15 tests passed; TypeScript and production Vite build passed.
- Live external check: Radiohead / Paranoid Android / OK Computer, 383 seconds,
  conservatively matched 54 timed LRCLIB lines. One bounded gpt-5-mini request
  returned a validated tense whole-song mood and nine timed sections. This
  diagnostic used API credits, did not print/store raw lyrics in logs, and did
  not alter the user's current song or song-profile cache.
- Browser verification at 1280×720: bass expanding rings, midrange clouds/ribbons,
  treble fragments/sparks, and fade-to-silence inspected independently. The
  preview's animation counter reported approximately 239–240 FPS. No browser
  warning/error entries were reported. This is observed browser frame cadence,
  not an independent GPU benchmark or a guarantee on other hardware.
- Production localhost stream: 90 silent frames, 29.97 Hz, median 0.239 ms and
  p95 0.345 ms capture-callback timestamp to DSP-completion timestamp. These are
  not end-to-end acoustic latencies. All three new band objects were present.
- Spotify was authorized but reported No Playback during the check. Multi-song
  listening, live lyric/beat alignment, and subjective appearance tuning remain
  unverified. The WPF key/model dialog was built but not manually operated;
  available UI automation exposed browser tabs, not native Windows app windows.
