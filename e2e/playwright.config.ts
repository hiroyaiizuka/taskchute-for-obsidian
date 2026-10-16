import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./specs",
  outputDir: "../e2e-results/output",
  globalSetup: "./global-setup.ts",
  // Each test starts its own Obsidian; running them side by side just
  // competes for the display and the GPU process.
  workers: 1,
  fullyParallel: false,
  // A cold start is about a second, but the first run also downloads Obsidian
  // inside globalSetup, which has no timeout of its own.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["html", { outputFolder: "../e2e-results/report", open: "never" }],
  ],
})
