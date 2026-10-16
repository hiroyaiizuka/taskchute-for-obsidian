import { defineConfig } from "@playwright/test"

// Recordings, not tests: `npm run record:video -- -g "<scenario>"`. A scenario
// still fails like a test when the app does not end up in the state it shows.
export default defineConfig({
  testDir: "./scenarios",
  outputDir: "../../e2e-results/recording-output",
  globalSetup: "./global-setup.ts",
  workers: 1,
  fullyParallel: false,
  // A scenario runs at reading speed and is encoded afterwards.
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
})
