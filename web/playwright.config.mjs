import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: true,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
  },
});
