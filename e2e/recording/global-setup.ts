import { execSync } from "node:child_process"
import { locateObsidian } from "../obsidian/locate"
import { REPO_ROOT } from "../obsidian/paths"
import { assertFfmpeg } from "./encode"

/**
 * Runs once before the scenarios. Unlike the E2E suite's setup this one also
 * runs on macOS and Windows, against the Obsidian installed there.
 */
export default async function globalSetup(): Promise<void> {
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "Obsidian needs a display. Run under WSLg or a desktop session, or wrap the command in `xvfb-run -a`.",
    )
  }
  assertFfmpeg()

  // A recording started from inside an AI agent's own session (Claude Code
  // running this command) must not hand that session's markers to the CLIs it
  // records: a real `claude` that inherits them runs as a child session and
  // does not show the conversation it resumes. Workers inherit this env.
  for (const name of Object.keys(process.env)) {
    if (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_") || name === "CLAUDE_PID" || name === "CLAUDE_EFFORT") {
      delete process.env[name]
    }
  }

  // Record what the source says now, not whatever main.js was last built.
  if (!process.env.TASKCHUTE_E2E_PLUGIN_DIR && process.env.TASKCHUTE_E2E_SKIP_BUILD !== "1") {
    execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" })
  }

  const { executable, ldLibraryPath } = await locateObsidian()
  process.env.TASKCHUTE_E2E_OBSIDIAN = executable
  process.env.TASKCHUTE_E2E_LD_LIBRARY_PATH = ldLibraryPath
}
