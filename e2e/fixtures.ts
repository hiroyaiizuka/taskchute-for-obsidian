import fs from "node:fs"
import { test as base, expect } from "@playwright/test"
import { type ObsidianLanguage, type ObsidianSession, launchObsidian } from "./obsidian/launch"

export { expect }

interface Fixtures {
  /** Obsidian's UI language for the test; override with test.use(). */
  language: ObsidianLanguage
  /** true gives Obsidian a fresh, empty home folder of its own (see `home`). */
  isolatedHome: boolean
  /** That home folder, when isolatedHome is on. */
  home: string | undefined
  /** A fresh Obsidian with the built plugin loaded, closed after the test. */
  obsidian: ObsidianSession
}

export const test = base.extend<Fixtures>({
  language: ["en", { option: true }],
  isolatedHome: [false, { option: true }],
  home: async ({ isolatedHome }, use, testInfo) => {
    if (!isolatedHome) {
      await use(undefined)
      return
    }
    const dir = testInfo.outputPath("home")
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    await use(dir)
  },

  obsidian: async ({ language, home }, use, testInfo) => {
    const obsidianExecutable = process.env.TASKCHUTE_E2E_OBSIDIAN
    if (!obsidianExecutable) throw new Error("global-setup did not locate Obsidian")

    const session = await launchObsidian({
      workDir: testInfo.outputPath("run"),
      language,
      obsidianExecutable,
      ldLibraryPath: process.env.TASKCHUTE_E2E_LD_LIBRARY_PATH ?? "",
      home,
    })
    try {
      await use(session)

      // Every test also asserts the plugin logged no errors while it ran.
      expect(session.errors, "console errors / uncaught exceptions in Obsidian").toEqual([])
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("screenshot", {
          body: await session.page.screenshot().catch(() => Buffer.alloc(0)),
          contentType: "image/png",
        })
        await testInfo.attach("console", {
          body: session.consoleLines.join("\n"),
          contentType: "text/plain",
        })
      }
      await session.close()
    }
  },
})
