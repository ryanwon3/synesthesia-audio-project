# MVP Verification

Verified on Windows 11 on August 12, 2026.

## Automated

- Complete solution builds in Debug and Release with zero warnings and errors.
- 17 TestTonePlayer tests cover finite bounded PCM, sine frequency, white-noise
  variance, burst timing, stereo routing, transitions, and controller state.
- 16 audio-engine tests cover normalized DSP features, chroma, stereo behavior,
  typed WebSocket delivery, reconnect, health, clean stop, and protected static
  content delivery.
- 2 visualizer tests cover bounded `VisualState` output and user-owned pitch-color
  selection.
- The Vite production build completes successfully with zero npm vulnerabilities.

## Live audio path

- A 440 Hz TestTonePlayer process produced 143,520 captured frames over 2.99
  seconds with RMS 0.1055, peak 0.15, and estimated frequency about 435.8 Hz.
- While an unrelated 1000 Hz TestTonePlayer played, the target capture remained
  about 435.5 Hz.
- When only the target was stopped, its capture became all zeroes while the
  unrelated process continued playing. This verifies process isolation.
- The live DSP frame reported RMS 0.1061, dominant pitch A, confidence 0.959,
  and approximately 0.19 ms capture-to-DSP processing.
- A local WebSocket client received protocol version 1 frames end to end.

## Visual and desktop

- Desktop canvas checked at 1440x900 and narrow canvas at 390x844.
- WebGL rendered a nonblank evolving scene without framework or browser errors.
- No horizontal overflow or control overlap was observed at either viewport.
- All 12 pitch colors and 12 response sliders were available on desktop and
  narrow layouts; the narrow panel scrolls vertically.
- Changing A from its default to green immediately changed a live 440 Hz scene
  and persisted to local storage; Reset removed the saved override.
- Diagnostics measured about 30 AudioFrame messages per second and exposed the
  expected A chroma values.
- The Release WPF/WebView2 app served its embedded bundle, found seven running
  Spotify processes, connected its WebView, and published frames at 30 Hz.
- Normal window close stopped the localhost server and left no WebView2 child
  process from the app.

## Still manual

- Spotify was running but paused during the final native-app screenshot, so the
  auto-selected Spotify stream was silent. Play Spotify and confirm the debug
  values and painting react to a real song.
- For the final real-world isolation check, play Spotify and an unrelated browser
  video together and confirm only Spotify changes the debug values.
- Long-duration playback, sleep/resume, output-device changes, and a Spotify
  update/restart should receive an extended soak test before a signed release.
- Spotify metadata, Last.fm, lyrics, OpenAI, SQLite, and song calibration are not
  part of this audio-first MVP and have not been claimed as implemented.
