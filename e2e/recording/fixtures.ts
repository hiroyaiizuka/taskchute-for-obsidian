import path from "node:path"
import { test as base, expect } from "@playwright/test"
import { type ObsidianLanguage, type ObsidianSession, launchObsidian } from "../obsidian/launch"
import { PLUGIN_ID, REPO_ROOT } from "../obsidian/paths"
import { Recorder } from "./recorder"

export { expect }

/** Finished recordings land here (gitignored), one folder per scenario. */
export const RECORDINGS_DIR = path.join(REPO_ROOT, "e2e-results", "recordings")

interface Fixtures {
  /** Obsidian's UI language. Recordings are for Japanese readers by default. */
  language: ObsidianLanguage
  /** A fresh Obsidian with the built plugin loaded. */
  obsidian: ObsidianSession
  /** Captions, narration, pointing and clicking; see Recorder. */
  recorder: Recorder
}

function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "recording"
}

export const test = base.extend<Fixtures>({
  language: ["ja", { option: true }],

  obsidian: async ({ language }, use, testInfo) => {
    const obsidianExecutable = process.env.TASKCHUTE_E2E_OBSIDIAN
    if (!obsidianExecutable) throw new Error("global-setup did not locate Obsidian")
    const session = await launchObsidian({
      workDir: testInfo.outputPath("run"),
      language,
      obsidianExecutable,
      ldLibraryPath: process.env.TASKCHUTE_E2E_LD_LIBRARY_PATH ?? "",
    })
    try {
      await use(session)
    } finally {
      // Terminal runs live in a broker that outlasts the window; stop them
      // first, or their shells stay behind when Obsidian is killed.
      await session.page
        .evaluate(async (id) => {
          const plugin = window.app.plugins.plugins[id] as {
            aiTaskManager?: {
              getRuns(): Array<{ id: string; status: string }>
              stopRun(runId: string): void
            }
          }
          const manager = plugin.aiTaskManager
          if (!manager) return
          const live = manager.getRuns().filter((run) => run.status === "running")
          for (const run of live) manager.stopRun(run.id)
          if (live.length > 0) await new Promise((resolve) => setTimeout(resolve, 1500))
        }, PLUGIN_ID)
        .catch(() => undefined)
      await session.close()
    }
  },

  // The scenario's title names the output: test("ai-link-sync", …) writes
  // e2e-results/recordings/ai-link-sync/ai-link-sync.mp4.
  recorder: async ({ obsidian }, use, testInfo) => {
    const name = slug(testInfo.title)
    const recorder = new Recorder(obsidian.page, path.join(RECORDINGS_DIR, name), name)
    await use(recorder)

    // A recording of a run that went wrong is worse than none.
    if (testInfo.status !== testInfo.expectedStatus || !recorder.started) return
    expect(obsidian.errors, "console errors / uncaught exceptions in Obsidian").toEqual([])
    const result = await recorder.finish()
    console.log(
      `[record] ${path.relative(REPO_ROOT, result.video)} ` +
        `(${result.duration.toFixed(1)} s, ${result.narrated ? "narrated" : "captions only"})`,
    )
  },
})
