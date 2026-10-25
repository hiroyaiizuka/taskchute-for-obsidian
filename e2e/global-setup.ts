import { execSync } from "node:child_process"
import { locateObsidian } from "./obsidian/locate"
import { REPO_ROOT } from "./obsidian/paths"

/**
 * Runs once before the suite. Values handed to the tests travel through
 * process.env, which Playwright's workers inherit.
 *
 * Linux uses the pinned AppImage; macOS and Windows use the installed Obsidian
 * (see locateObsidian).
 */
export default async function globalSetup(): Promise<void> {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Obsidian needs a display. Run under WSLg or a desktop session, or wrap the command in `xvfb-run -a`.",
    )
  }

  // Test what the source says now, not whatever main.js was last built.
  // TASKCHUTE_E2E_PLUGIN_DIR points the suite at prebuilt artifacts instead.
  if (!process.env.TASKCHUTE_E2E_PLUGIN_DIR && process.env.TASKCHUTE_E2E_SKIP_BUILD !== "1") {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" })
  }

  const { executable, ldLibraryPath } = await locateObsidian()
  process.env.TASKCHUTE_E2E_OBSIDIAN = executable
  process.env.TASKCHUTE_E2E_LD_LIBRARY_PATH = ldLibraryPath
}
