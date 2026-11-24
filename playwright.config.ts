import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  reporter: 'list',
  outputDir: '.runtime/browser-test-results',
  use: {
    baseURL: 'http://127.0.0.1:5177',
    actionTimeout: 10000,
    headless: true,
    trace: 'off',
    screenshot: 'off',
    launchOptions: process.env.WEB_BROWSER_EXECUTABLE
      ? { executablePath: process.env.WEB_BROWSER_EXECUTABLE }
      : {},
  },
  webServer: [
    {
      command: 'node apps/api/dist/server.js',
      url: 'http://127.0.0.1:4017/health/live',
      env: { API_HOST: '127.0.0.1', API_PORT: '4017' },
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npm run preview --workspace @scholarproof/web -- --port 5177',
      url: 'http://127.0.0.1:5177',
      env: { WEB_API_PORT: '4017' },
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
