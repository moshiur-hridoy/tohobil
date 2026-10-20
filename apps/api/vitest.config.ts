import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database tests may have to pull and start a Postgres container on first run.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
