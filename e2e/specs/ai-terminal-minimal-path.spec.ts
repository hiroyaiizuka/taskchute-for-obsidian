import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute, writeFakeClaude } from "../helpers/aiTask"

// LEV-377: Obsidian launched from the Dock or Finder inherits launchd's PATH,
// which has no `node`. The terminal broker was spawned as a bare `node`, so a
// + terminal opened before any AI task had captured the login shell's PATH
// went red after five seconds with nothing on the screen. Obsidian here gets
// exactly that PATH, and no AI task runs before the terminals open.
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

test.use({ isolatedHome: true, processPath: LAUNCHD_PATH })

interface ManagerHandle {
  startShellSession(options: { name?: string; cols?: number; rows?: number }): { id: string }
  onTerminalData(runId: string, listener: (chunk: string) => void): () => void
  sendTerminalInput(runId: string, data: string): void
  getRun(runId: string): { status: string; errorMessage?: string } | undefined
  getRuns(): Array<{ id: string; host: string }>
  disposeAndWait(): Promise<void>
}

declare global {
  interface Window {
    __lev377Output?: Record<string, string>
  }
}

/** Mirror every chunk a shell run prints into window.__lev377Output[runId]. */
async function recordOutput(page: Page, runId: string): Promise<void> {
  await page.evaluate(
    ([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      window.__lev377Output ??= {}
      window.__lev377Output[run] = ""
      manager.onTerminalData(run, (chunk) => {
        window.__lev377Output![run] += chunk
      })
    },
    [PLUGIN_ID, runId] as const,
  )
}

async function outputOf(page: Page, runId: string): Promise<string> {
  return page.evaluate((run) => window.__lev377Output?.[run] ?? "", runId)
}

function brokerDescriptorPath(vault: string): string {
  const hash = crypto.createHash("sha256").update(`taskchute-plus:${vault}`).digest("hex").slice(0, 24)
  return path.join(os.tmpdir(), `taskchute-plus-ai-broker-${hash}.json`)
}

test("a + terminal opens and takes input on launchd's minimal PATH, with no AI task run first", async ({ obsidian, home }, testInfo) => {
  const { page } = obsidian
  expect(await page.evaluate(() => process.env.PATH)).toBe(LAUNCHD_PATH)
  // A login shell with no startup files of its own, so the prompt is quick
  // and zsh's new-user wizard never swallows the typed command.
  for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".zprofile"]) {
    fs.writeFileSync(path.join(home!, rc), "PS1='$ '\n")
  }
  const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "runs-until-killed"), "terminal")
  await openTaskChute(page)

  try {
    // The first terminal, opened the way the pane's + opens one.
    const first = await page.evaluate((id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      return manager.startShellSession({ name: "Terminal", cols: 80, rows: 24 }).id
    }, PLUGIN_ID)
    await recordOutput(page, first)
    await page.locator(".ai-run-pane .xterm").first().waitFor()

    await page.evaluate(([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      manager.sendTerminalInput(run, "echo LEV377_$((40+2))\r")
    }, [PLUGIN_ID, first] as const)
    await expect.poll(() => outputOf(page, first), { timeout: 30_000 }).toContain("LEV377_42")

    const run = await page.evaluate(([id, runId]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      return manager.getRun(runId)
    }, [PLUGIN_ID, first] as const)
    expect(run?.status).toBe("running")

    // The broker runs on an absolute Node.js, never the bare name the minimal
    // PATH cannot resolve.
    const descriptor = JSON.parse(fs.readFileSync(brokerDescriptorPath(vault), "utf8")) as { pid: number }
    const brokerCommand = execFileSync("/bin/ps", ["-o", "command=", "-p", String(descriptor.pid)], { encoding: "utf8" })
    expect(brokerCommand.trim().startsWith("/")).toBe(true)

    // A second terminal from the pane's own + button, typed into from the keyboard.
    const before = await page.evaluate((id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
      return manager.getRuns().filter((r) => r.host === "shell").map((r) => r.id)
    }, PLUGIN_ID)
    await page.locator(".ai-run-pane__add").first().click()
    const second = await page.waitForFunction(
      ([id, known]) => {
        const manager = (window.app.plugins.plugins[id] as { aiTaskManager: ManagerHandle }).aiTaskManager
        return manager.getRuns().find((r) => r.host === "shell" && !known.includes(r.id))?.id ?? null
      },
      [PLUGIN_ID, before] as const,
    ).then((handle) => handle.jsonValue() as Promise<string>)
    await recordOutput(page, second)
    await page.locator(`.ai-run-pane__tab[data-run-id="${second}"]`).waitFor()
    await page.locator(".ai-run-pane .xterm:visible").last().click()
    await page.keyboard.type("echo PLUS_$((50+8))")
    await page.keyboard.press("Enter")
    await expect.poll(() => outputOf(page, second), { timeout: 30_000 }).toContain("PLUS_58")

    // Nothing failed: no red tab, no TaskChute notice in either terminal.
    for (const runId of [first, second]) {
      expect(await outputOf(page, runId)).not.toContain("[TaskChute Plus]")
    }
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
