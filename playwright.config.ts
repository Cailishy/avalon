import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 240000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  outputDir: ".media/e2e-results",
  reporter: [["list"], ["html", { outputFolder: ".media/playwright-report", open: "never" }]],
  use: { browserName: "chromium", ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
