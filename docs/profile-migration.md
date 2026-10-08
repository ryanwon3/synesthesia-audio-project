# Personal profile preservation and migration

The local profile remains user-owned. October 8's source checkpoint adds safe
calibration persistence and local JSON transfer; it does not publish a hosted
app, synchronize settings, or replace the personal bundled pitch palette.
`profiles/synesthesia.json` is unchanged.

## Moving your settings

When the Windows app can be opened for acceptance:

1. Open Calibration in the existing desktop renderer and choose **Export profile**.
   Keep the downloaded JSON privately. Export the bundled default too if you have
   never saved calibration changes: it can contain your personal colors.
2. Back up that file independently before changing origins or installing a new
   public-default bundle. Browser storage belongs to its origin; the hosted page
   cannot automatically read the desktop WebView's settings.
3. On the target origin, choose **Import profile**, select the local JSON file,
   and confirm replacement. Compare all twelve pitch colors, response values,
   layer controls, and palette mode with the source.
4. Verify cancel, reset, and **Restore backup** on disposable test settings before
   relying on migration. Do not clear the source browser storage or delete the
   original export until the comparison succeeds.

Import and export are local operations: no profile or raw audio is uploaded.
The UI can request a download, but automated tests do not establish that a real
browser completed it. The current manual transfer checkpoint is **unverified**:
the user requested keeping the Windows app closed.

## Validation and failure behavior

Imports must be complete schema-version-1 profiles, no larger than 64 KiB in
UTF-8. All twelve colors must be six-digit hexadecimal colors; every required
response field must be finite and within its UI range. Response weights are
0–1, attack is 10–300 ms, and release is 100–1500 ms. Existing valid optional
layer and palette-mode settings are retained; unknown fields are rejected.

The later local spatial-source checkpoint accepts explicitly present, versioned
spatial preferences: finite 0–1 controls and at most 32 validated local song
overrides. Optional absence is preserved for legacy profiles. No association or
pitch-color replacement is automatically saved; the same backup/export boundary
owns these values, not a second settings store.

Canceling import, reset, or restore changes nothing. A failed import/reset/restore
keeps the current runtime profile. Ordinary slider edits may remain visible for
the current session when storage fails; the UI warns that they were not saved
and recommends exporting them. An older asynchronous file read cannot overwrite
a newer calibration edit or a reopened/disposed panel.

If saved JSON cannot be read, the renderer uses the bundled profile for that
session and shows a warning. Loading does not erase the unreadable bytes.
Before changing saved settings, the store preserves the prior raw bytes; a
failed preservation write prevents replacement/reset. Never treat a displayed
fallback as proof that the original settings have been repaired or saved.

## Local recovery records

The original key remains `spotify-synesthesia.profile.v1`. Three bounded local
recovery entries support failure-safe changes:

- `.backup` keeps the previous raw profile before replacement or reset. Restore
  exchanges it with the current saved profile, allowing a return to that version.
- `.recovery` retains a validated restore target if the multi-write operation is
  interrupted. Use **Restore backup** again before attempting other saved edits.
- `.damaged` retains one unreadable original, up to 64 KiB, across subsequent
  slider events and backup rotation. It is not automatically deleted or repaired.

If a distinct second damaged original or an oversized original cannot be safely
retained, saved edits are blocked instead of discarding data. Export the valid
session separately and retain browser storage for an explicit recovery decision.
An unreadable backup is not imported automatically. These records are not a
general repair tool or cross-tab synchronization system; concurrent same-origin
documents retain last-writer behavior.

## Verification and publishing gate

The October 8 automated checkpoint passed 162 frontend tests, strict frontend
build, both complete Debug/Release builds, and 345 .NET tests (507 combined).
Coverage includes full round trips, malformed input, storage-write failures,
interrupted restore, repeated edits retaining damaged bytes, cancellation,
stale file reads, and bounded download-object cleanup. Independent source review
found one important damaged-backup rotation issue; a failing composed regression
was observed and the correction passed the full suite.

Actual desktop-to-other-origin transfer and the saved/default-palette comparison
remain prerequisites for public-template replacement or hosted publication.
Real dialogs, downloads, reloads, and browser storage behavior remain manual
acceptance checks. Do not infer visual accuracy or browser-loopback compatibility
from these profile tests.
