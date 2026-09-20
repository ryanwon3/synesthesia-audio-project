import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Three.js is the renderer core; the production bundle is about 137 KB gzip.
    chunkSizeWarningLimit: 600,
  },
});
