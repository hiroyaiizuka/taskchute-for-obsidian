import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Locator, Page } from "@playwright/test"
import { PLUGIN_ID } from "../helpers/aiTask"

// Terminal helpers for recordings with a real AI CLI (Windows). Output is read
// from the run's own buffer, which replays what the terminal printed so far:
// there is no transcript file on Windows, and xterm draws on a canvas.

interface ManagerHandle {
  getRuns(): Array<{ id: string; taskPath: string; host: string; status: string }>
  onTerminalData(runId: string, listener: (chunk: string) => void): () => void
  disposeAndWait(): Promise<void>
}

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, "g")
const OTHER_ESCAPE = new RegExp(`${ESC}[()][0-9A-Za-z]|${ESC}[=>78MDEHc]`, "g")

/** The run id of the task's run, or of the running + terminal when taskPath is null. */
export async function runIdOf(page: Page, taskPath: string | null): Promise<string | null> {
  return page.evaluate(
    ([id, task]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
      const runs = manager?.getRuns() ?? []
      const run = task
        ? runs.find((candidate) => candidate.taskPath === task)
        : runs.find((candidate) => candidate.host === "shell" && candidate.status === "running")
      return run?.id ?? null
    },
    [PLUGIN_ID, taskPath] as const,
  )
}

export async function runStatusOf(page: Page, runId: string): Promise<string | null> {
  return page.evaluate(
    ([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
      return manager?.getRuns().find((candidate) => candidate.id === run)?.status ?? null
    },
    [PLUGIN_ID, runId] as const,
  )
}

/** Everything the run printed so far, escape sequences and spacing removed. */
export async function printed(page: Page, runId: string): Promise<string> {
  const raw = await page.evaluate(
    ([id, run]) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
      let text = ""
      manager?.onTerminalData(run, (chunk) => {
        text += chunk
      })()
      return text
    },
    [PLUGIN_ID, runId] as const,
  )
  return raw.replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(OTHER_ESCAPE, "").replace(/\s+/g, "")
}

/** The tab of a run in the AI run pane. */
export function tabOf(page: Page, runId: string): Locator {
  return page.locator(`.ai-run-pane__tab[data-run-id="${runId}"]`)
}

/** The run's terminal (its body in the pane). */
export function terminalOf(page: Page, runId: string): Locator {
  return page.locator(`.ai-run-pane__body[data-run-id="${runId}"] .xterm`).first()
}

/** Stops the broker the recording's terminals ran in; it outlives Obsidian. */
export async function disposeAiRuns(page: Page): Promise<void> {
  await page
    .evaluate(async (id) => {
      const manager = (window.app.plugins.plugins[id] as { aiTaskManager?: ManagerHandle }).aiTaskManager
      await manager?.disposeAndWait()
    }, PLUGIN_ID)
    .catch(() => undefined)
}

/** The real Claude Code CLI on PATH; the recordings drive it as a user would. */
export async function realClaudePath(): Promise<string> {
  const finder = process.platform === "win32" ? "where" : "which"
  const found = await promisify(execFile)(finder, ["claude"]).catch(() => ({ stdout: "" }))
  const claudePath = found.stdout.split(/\r?\n/)[0]?.trim() ?? ""
  if (!claudePath) throw new Error("This scenario needs the Claude Code CLI (`claude`) on PATH, signed in.")
  return claudePath
}

/**
 * Waits until Claude Code's screen is up in the run's terminal. A fresh vault
 * first asks whether to trust the folder; `onTrust` is told before Enter
 * accepts it, so the caption can say so.
 */
export async function waitForClaude(page: Page, runId: string, onTrust?: () => Promise<void>): Promise<void> {
  const ready = /trustthisfolder|ClaudeCodev\d/
  const deadline = Date.now() + 60_000
  while (!ready.test(await printed(page, runId))) {
    if (Date.now() > deadline) throw new Error("Claude Code's screen never appeared.")
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if ((await printed(page, runId)).includes("trustthisfolder")) {
    await onTrust?.()
    // Its tab first: the pane may be showing another run.
    await tabOf(page, runId).click()
    await terminalOf(page, runId).click()
    await page.keyboard.press("Enter")
    const welcome = Date.now() + 60_000
    while (!/ClaudeCodev\d/.test(await printed(page, runId))) {
      if (Date.now() > welcome) throw new Error("Claude Code did not start after the folder was trusted.")
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
}
