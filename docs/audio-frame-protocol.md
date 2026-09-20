# AudioFrame WebSocket Protocol

The backend listens only on `127.0.0.1`. Protocol version 1 uses:

```text
ws://127.0.0.1:8765/audio
```

Messages are UTF-8 JSON envelopes:

```json
{
  "protocolVersion": 1,
  "type": "audioFrame",
  "payload": {
    "sequence": 1,
    "timestampUnixMilliseconds": 0,
    "captureTimestamp": 0,
    "dspCompletedTimestamp": 0,
    "rms": 0,
    "bassEnergy": 0,
    "midEnergy": 0,
    "trebleEnergy": 0,
    "spectralCentroid": 0,
    "spectralFlux": 0,
    "onsetStrength": 0,
    "stereoBalance": 0.5,
    "stereoWidth": 0,
    "chroma": {
      "c": 0,
      "cSharp": 0,
      "d": 0,
      "dSharp": 0,
      "e": 0,
      "f": 0,
      "fSharp": 0,
      "g": 0,
      "gSharp": 0,
      "a": 0,
      "aSharp": 0,
      "b": 0
    },
    "dominantPitchClass": null,
    "chromaConfidence": 0
  }
}
```

All feature values are finite and normalized to `0..1`. Stereo balance uses `0`
for left, `0.5` for centered, and `1` for right. Pitch classes serialize as enum
names such as `A` and `CSharp`.

New v1 frames also include additive `bass`, `mid`, and `treble` objects, each
containing `chroma` (the same twelve-key shape), `chromaConfidence`, and `attack`.
These values are normalized and computed from the existing FFT. Bands are
below 250 Hz, 250–4000 Hz, and above 4000 Hz; pitch estimates use 50–12000 Hz.
This is spectral analysis, not source separation. Clients support older frames
without band objects using whole-mix chroma and energy-weighted onset fallback.

The server maintains a two-frame queue per client and discards stale frames for a
slow client. Network sends never run on the capture/DSP caller. A client should
reconnect with backoff after disconnection. `GET /health` reports protocol version,
client count, published-frame count, and server state.

When a static content root is configured, `GET /` and hashed asset paths serve
the production visualizer. Static paths are resolved beneath that root and
requests that escape it return `404`. The WPF shell uses this mode so its WebView
and WebSocket share the same loopback origin.
