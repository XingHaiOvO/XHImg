import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:9522',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    browserName: 'chromium',
  },
  webServer: {
    command: 'node tests/serve.mjs',
    url: 'http://127.0.0.1:9522/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
