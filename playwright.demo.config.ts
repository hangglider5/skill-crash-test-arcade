import { defineConfig, devices } from "@playwright/test";

const recordingViewport = { width: 1600, height: 900 } as const;

export default defineConfig({
  testDir: "./recording",
  testMatch: "demo-record.spec.ts",
  outputDir: "artifacts/demo/.playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:5173",
    colorScheme: "dark",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: { mode: "on", size: recordingViewport },
    viewport: recordingViewport
  },
  projects: [{
    name: "demo-chromium",
    use: { ...devices["Desktop Chrome"], viewport: recordingViewport }
  }],
  webServer: {
    command: "pnpm demo",
    url: "http://127.0.0.1:5173/?token=dev-token",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
