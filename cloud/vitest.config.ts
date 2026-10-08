import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)),
    include: ['cloud/tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
