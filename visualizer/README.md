# Visualizer

The Vite/TypeScript/Three.js renderer consumes typed `AudioFrame` messages from
`ws://127.0.0.1:8765/audio`. It remains animated when the backend is unavailable,
reconnects automatically, and stores personal calibration changes in local
browser/WebView storage.

```powershell
npm install
npm run dev
npm test
npm run build
```

The renderer receives only `VisualState`; backend service responses never reach
Three.js directly. Press `D` to toggle the developer overlay.
