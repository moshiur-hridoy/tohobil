import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

/**
 * Records the data of the public UI demo (docs/DEMO.md). Same throwaway stack as `pnpm e2e`, but
 * runs only record.demo.ts, which the normal e2e run never picks up.
 */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: /record\.demo\.ts/,
  timeout: 20 * 60_000,
});
