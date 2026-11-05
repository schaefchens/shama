import { defineConfig, devices } from '@playwright/test';

// The example built and served; the self-test in every engine.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: 'http://localhost:4181' },
  webServer: { command: 'npm run build && npm run preview', url: 'http://localhost:4181', reuseExistingServer: false, timeout: 120_000 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
