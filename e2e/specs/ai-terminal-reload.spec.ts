import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute, writeFakeClaude } from "../helpers/aiTask"

// LEV-404: a terminal outlives a reload of the Obsidian window. Its shell runs
// in the broker, not in the window, so after the reload the plugin finds the
// same session, shows what it printed before, and takes input again. Windows
// joined the other platforms here; before, its terminals ended with the window.
test.use({ isolatedHome: true })

const windows = process.platform === "win32"

/** A command whose output differs from its echo, in PowerShell or a POSIX shell. */
function printCommand(marker: string, a: number, b: number): string {
  return windows ? `echo "${marker}_$(${a}+${b})"\r` : `echo "${marker}_$((${a}+${b}))"\r`
}

interface ManagerHandle {
  startShellSession(options: { name?: string; cols?: number; rows?: number }): { id: string }
  onTerminalData(runId: string, listener: (chunk: string) => void): () => void
  sendTerminalInput(runId: string, data: string): void
  getRun(runId: string): { status: string } | undefined
  settleShellSessionSupport(): Promise<void>
  disposeAndWait(): Promise<void>
}

declare global {
  interface Window {
    __lev404Output?: string
  }
}

/** Collect the run's output, starting with the replay of what it printed so far. */
async function recordOutput(page: Page, runId: string): Promise<void> {
  await page.evaluate(
    ([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      window.__lev404Output = ""
      manager.onTerminalData(run, (chunk) => {
        window.__lev404Output += chunk
      })
    },
    [PLUGIN_ID, runId] as const,
  )
}

async function output(page: Page): Promise<string> {
  return page.evaluate(() => window.__lev404Output ?? "")
}

async function type(page: Page, runId: string, data: string): Promise<void> {
  await page.evaluate(
    ([id, run, text]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      manager.sendTerminalInput(run, text)
    },
    [PLUGIN_ID, runId, data] as const,
  )
}

async function runStatus(page: Page, runId: string): Promise<string | undefined> {
  return page.evaluate(
    ([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
      return manager?.getRun(run)?.status
    },
    [PLUGIN_ID, runId] as const,
  )
}

test("a + terminal keeps running across a window reload and takes input after it", async ({ obsidian, home }, testInfo) => {
  test.setTimeout(120_000)
  const { page } = obsidian
  if (!windows) {
    // No startup files of its own, so the prompt is quick and zsh's
    // new-user wizard never swallows the typed command.
    for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".zprofile"]) {
      fs.writeFileSync(path.join(home!, rc), "PS1='$ '\n")
    }
  }
  const cli = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  await enableAiTasks(page, cli, "terminal")
  await openTaskChute(page)

  try {
    const runId = await page.evaluate(async (id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      // Windows knows whether ConPTY works only once its probe has run.
      await manager.settleShellSessionSupport()
      return manager.startShellSession({ name: "Terminal", cols: 100, rows: 30 }).id
    }, PLUGIN_ID)
    await recordOutput(page, runId)
    await type(page, runId, printCommand("BEFORE", 40, 2))
    await expect.poll(() => output(page), { timeout: 30_000 }).toContain("BEFORE_42")

    await page.reload()
    await page.waitForFunction(() => window.app?.workspace?.layoutReady === true, undefined, { timeout: 60_000 })
    await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, { timeout: 60_000 })
    // The license stub lives in memory, so it goes again; the manager it
    // builds restores the session from what the window saved before.
    await enableAiTasks(page, cli, "terminal")

    await expect.poll(() => runStatus(page, runId), { timeout: 30_000 }).toBe("running")
    // What the shell printed before the reload comes back first.
    await recordOutput(page, runId)
    await expect.poll(() => output(page), { timeout: 30_000 }).toContain("BEFORE_42")
    // And the same shell still answers.
    await type(page, runId, printCommand("AFTER", 50, 8))
    await expect.poll(() => output(page), { timeout: 30_000 }).toContain("AFTER_58")
    expect(await runStatus(page, runId)).toBe("running")
  } finally {
    // The broker outlives the Obsidian process group the fixture kills; shut
    // it down so it does not linger for its 30-minute TTL.
    await page
      .evaluate(async (id) => {
        const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
        await manager?.disposeAndWait()
      }, PLUGIN_ID)
      .catch(() => undefined)
  }
})
