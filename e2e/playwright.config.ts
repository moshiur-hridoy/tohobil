import { defineConfig } from '@playwright/test';
import { API_PORT, BASE_URL, E2E_APP_URL, E2E_MIGRATOR_URL, WEB_PORT } from './env';

/**
 * End-to-end scenarios (spec 14.3). `pnpm e2e` prepares a throwaway database first (prepare.ts), then
 * Playwright starts the API and the web dev server against it. By default it drives the installed
 * Google Chrome; set PW_CHANNEL=chromium after `pnpm exec playwright install chromium` (CI does).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
    trace: 'retain-on-failure',
    ...(process.env.PW_CHANNEL === 'chromium' ? {} : { channel: 'chrome' }),
  },
  webServer: [
    {
      command: 'pnpm --filter @barakah/api exec tsx src/index.ts',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        NODE_ENV: 'development',
        DATABASE_URL: E2E_APP_URL,
        MIGRATOR_DATABASE_URL: E2E_MIGRATOR_URL,
        PUBLIC_ORIGIN: BASE_URL,
        LOG_LEVEL: 'warn',
        AUTH_RATE_LIMIT_PER_MINUTE: '1000',
        RATE_LIMIT_PER_MINUTE: '10000',
        FILES_DIR: 'data/e2e-files',
      },
    },
    {
      command: `pnpm --filter @barakah/web exec vite --port ${WEB_PORT} --strictPort`,
      url: BASE_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
    },
  ],
});
