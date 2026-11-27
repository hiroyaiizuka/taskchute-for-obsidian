import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureAppAsar, ensureObsidian } from "./install"
import { ensureSharedLibraries } from "./libs"

export interface ObsidianLocation {
  executable: string
  /** Extra shared libraries for the extracted AppImage; empty elsewhere. */
  ldLibraryPath: string
  /**
   * The pinned app (obsidian-<version>.asar) to put in each config dir, so an
   * installed Obsidian runs the same version as the Linux AppImage. Empty
   * when the executable already is the pinned build.
   */
  appAsar: string
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate))
}

/**
 * Finds an Obsidian to drive on this machine.
 *
 * - Linux x64 (WSL included): the pinned AppImage, downloaded on first use,
 *   exactly as the E2E suite does.
 * - macOS and Windows: the Obsidian that is installed, running the pinned app
 *   (see ensureAppAsar). Its installer's own app can be older than the plugin
 *   supports, and a fresh config dir never sees the updates the user's
 *   Obsidian downloaded. An installer newer than the pin runs its own app.
 *
 * TASKCHUTE_E2E_OBSIDIAN_PATH overrides the lookup on every platform, and runs
 * that executable's own app.
 */
export async function locateObsidian(): Promise<ObsidianLocation> {
  const override = process.env.TASKCHUTE_E2E_OBSIDIAN_PATH
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`TASKCHUTE_E2E_OBSIDIAN_PATH points at ${override}, which does not exist.`)
    }
    return { executable: override, ldLibraryPath: "", appAsar: "" }
  }

  if (process.platform === "linux") {
    const executable = await ensureObsidian()
    return { executable, ldLibraryPath: ensureSharedLibraries(executable), appAsar: "" }
  }

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Obsidian.app/Contents/MacOS/Obsidian",
          path.join(os.homedir(), "Applications/Obsidian.app/Contents/MacOS/Obsidian"),
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe"),
            path.join(process.env.LOCALAPPDATA ?? "", "Obsidian", "Obsidian.exe"),
            path.join(process.env.ProgramFiles ?? "", "Obsidian", "Obsidian.exe"),
          ]
        : []
  const executable = firstExisting(candidates)
  if (!executable) {
    throw new Error(
      `Obsidian was not found (looked in ${candidates.join(", ") || "nowhere: unsupported platform"}). ` +
        "Install it, or set TASKCHUTE_E2E_OBSIDIAN_PATH to its executable.",
    )
  }
  return { executable, ldLibraryPath: "", appAsar: await ensureAppAsar() }
}
