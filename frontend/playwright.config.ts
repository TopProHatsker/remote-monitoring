import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8080',
    launchOptions: { executablePath: process.env.BROWSER_EXECUTABLE || undefined },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
