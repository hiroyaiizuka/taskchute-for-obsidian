import os from "node:os"
import path from "node:path"

/**
 * The Obsidian desktop build the suite runs against. Pinned so a run is
 * reproducible; bump it deliberately. Only releases that ship an AppImage
 * qualify — some tags (v1.13.8) are Android-only.
 */
export const OBSIDIAN_VERSION = "1.13.7"

export const PLUGIN_ID = "taskchute-plus"

export const REPO_ROOT = path.resolve(__dirname, "../..")

/** Downloads and extracted libraries live here, shared across runs. */
export function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return process.env.TASKCHUTE_E2E_CACHE ?? path.join(base, "taskchute-e2e")
}

/** Where main.js, manifest.json and styles.css are copied from. */
export function pluginArtifactsDir(): string {
  return process.env.TASKCHUTE_E2E_PLUGIN_DIR ?? REPO_ROOT
}
