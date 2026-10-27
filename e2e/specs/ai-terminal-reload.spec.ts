import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute, writeFakeClaude } from "../helpers/aiTask"

// LEV-404: a terminal outlives a reload of the Obsidian window. Its shell runs
// in the broker, not in the window, so after the reload the plugin finds the
// same session, shows what it printed before, and takes input again. Windows
// joined the other platforms here; before, its terminals ended with the window.
//
// LEV-405: because the broker outlives the window, "Restart AI terminals" is
// the way to a new one; the second test checks that.
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

/** The pid of the broker this vault's terminals run in, or null when none runs. */
async function brokerPid(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const req = (window as unknown as { require: (name: string) => unknown }).require
    const crypto = req("crypto") as typeof import("crypto")
    const fs = req("fs") as typeof import("fs")
    const os = req("os") as typeof import("os")
    const path = req("path") as typeof import("path")
    const basePath = (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath()
    const hash = crypto.createHash("sha256").update(`taskchute-plus:${basePath}`).digest("hex").slice(0, 24)
    try {
      const descriptor = JSON.parse(
        fs.readFileSync(path.join(os.tmpdir(), `taskchute-plus-ai-broker-${hash}.json`), "utf8"),
      ) as { pid: number }
      return descriptor.pid
    } catch {
      return null
    }
  })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startTerminal(page: Page): Promise<string> {
  return page.evaluate(async (id) => {
    const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
    // Windows knows whether ConPTY works only once its probe has run.
    await manager.settleShellSessionSupport()
    return manager.startShellSession({ name: "Terminal", cols: 100, rows: 30 }).id
  }, PLUGIN_ID)
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
    const runId = await startTerminal(page)
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

test("Restart AI terminals ends the terminals and the next one runs on a new broker", async ({ obsidian, home }, testInfo) => {
  test.setTimeout(120_000)
  const { page } = obsidian
  if (!windows) {
    for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".zprofile"]) {
      fs.writeFileSync(path.join(home!, rc), "PS1='$ '\n")
    }
  }
  const cli = writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed")
  await enableAiTasks(page, cli, "terminal")
  await openTaskChute(page)

  try {
    const before = await startTerminal(page)
    await recordOutput(page, before)
    await type(page, before, printCommand("BEFORE", 40, 2))
    await expect.poll(() => output(page), { timeout: 30_000 }).toContain("BEFORE_42")
    const oldBroker = await brokerPid(page)
    expect(oldBroker).not.toBeNull()

    const listed = await page.evaluate(
      (id) => window.app.commands.executeCommandById(`${id}:restart-ai-terminals`),
      PLUGIN_ID,
    )
    expect(listed).toBe(true)
    // One terminal is running, so it asks first.
    const dialog = page.locator(".modal").filter({ hasText: "1 running terminal" })
    await expect(dialog).toBeVisible()
    await dialog.getByRole("button", { name: "Restart" }).click()

    await expect.poll(() => runStatus(page, before), { timeout: 30_000 }).not.toBe("running")
    await expect.poll(() => processAlive(oldBroker!), { timeout: 30_000 }).toBe(false)

    const after = await startTerminal(page)
    await recordOutput(page, after)
    await type(page, after, printCommand("AFTER", 50, 8))
    await expect.poll(() => output(page), { timeout: 30_000 }).toContain("AFTER_58")
    const newBroker = await brokerPid(page)
    expect(newBroker).not.toBeNull()
    expect(newBroker).not.toBe(oldBroker)
  } finally {
    await page
      .evaluate(async (id) => {
        const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
        await manager?.disposeAndWait()
      }, PLUGIN_ID)
      .catch(() => undefined)
  }
})
