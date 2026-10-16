import { execSync } from "node:child_process"
import { ensureObsidian } from "./obsidian/install"
import { ensureSharedLibraries } from "./obsidian/libs"
import { REPO_ROOT } from "./obsidian/paths"

/**
 * Runs once before the suite. Values handed to the tests travel through
 * process.env, which Playwright's workers inherit.
 */
export default async function globalSetup(): Promise<void> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Obsidian needs a display. Run under WSLg or a desktop session, or wrap the command in `xvfb-run -a`.",
    )
  }

  // Test what the source says now, not whatever main.js was last built.
  // TASKCHUTE_E2E_PLUGIN_DIR points the suite at prebuilt artifacts instead.
  if (!process.env.TASKCHUTE_E2E_PLUGIN_DIR && process.env.TASKCHUTE_E2E_SKIP_BUILD !== "1") {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" })
  }

  const executable = await ensureObsidian()
  process.env.TASKCHUTE_E2E_OBSIDIAN = executable
  process.env.TASKCHUTE_E2E_LD_LIBRARY_PATH = ensureSharedLibraries(executable)
}
