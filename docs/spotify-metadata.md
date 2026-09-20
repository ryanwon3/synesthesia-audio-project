# Spotify Metadata Setup and Verification

This integration is for a personal local prototype. It uses Spotify Authorization
Code with PKCE and the minimum `user-read-currently-playing` scope. Review the
current Spotify developer terms before distributing or adding metadata-driven
visual synchronization.

## One-time dashboard setup

1. Sign in to the Spotify Developer Dashboard and create an app owned by the
   Spotify account used for testing.
2. Add the account to the app's allowlist if development mode requires it. The
   app owner/test account must satisfy Spotify's current account eligibility rules.
3. Register this exact redirect URI: `http://127.0.0.1:8765/spotify/callback`.
   Do not use `localhost`, another port, or a wildcard address.
4. Copy the app's client ID. Do not create, copy, or enter a client secret.

## A. First-time authentication

1. Start Spotify, play any song, and run `Start-SpotifySynesthesia.cmd`.
2. Select the link button, enter the client ID, and choose `Save and connect`.
3. Complete authorization in the normal browser and return to the desktop app.
4. Open diagnostics with `D`. Confirm metadata is connected, authorization is
   valid, SQLite is ready, and no token values appear.

## B. Playing Song A

Play Song A. Confirm its title, artists, album, Spotify ID, optional ISRC, and
play state are correct. Confirm `Profile` is loaded and the source is `New` the
first time the ID is seen.

## C. Let Song A continue

Let it play through several polls. Progress should advance and remain clamped to
duration. The profile must not be recreated and no repeated TrackChanged event
should occur.

## D. Pause and resume Song A

Pause, wait for diagnostics to report paused, then resume. Progress should freeze
while paused. Neither transition should create a TrackChanged event.

## E. Switch to Song B

Play a different Spotify track. Confirm exactly one TrackChanged transition and
a `New` profile when Song B was not previously cached.

## F. Return to Song A

Return to Song A. Confirm its profile source is `Cached`, the database still has
one row for that Spotify ID, and Spotify-owned title/album/artist fields reflect
the latest API response.

## G. Disconnect the internet

While Spotify music is already playing, disconnect the network. Metadata should
become unavailable/stale while retaining the last known track for diagnostics.
Confirm process capture continues, DSP values and `/audio` sequence numbers keep
changing, and the painting remains reactive. Restore the network and confirm
metadata recovers without restarting capture.

## Local files and recovery

- Client ID: `%LOCALAPPDATA%\SpotifySynesthesia\settings.json`
- DPAPI-protected authorization: `%LOCALAPPDATA%\SpotifySynesthesia\auth\`
- SongProfile SQLite database: `%LOCALAPPDATA%\SpotifySynesthesia\data\song-profiles.db`
- DPAPI-protected Last.fm key: `%LOCALAPPDATA%\SpotifySynesthesia\auth\lastfm-api-key.dat`

An expired or revoked refresh credential is deleted and diagnostics reports
`Reauthorization required`. Select the link button to authorize again. If port
8765 is unavailable, the app reports a callback error and does not open a browser.
Last.fm is separately optional and does not affect Spotify authorization or audio.
