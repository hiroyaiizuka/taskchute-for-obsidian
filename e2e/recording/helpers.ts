import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"

// Internal members of Obsidian's vault adapter, typed here because only the
// recording helpers reach them.
interface AdapterInternals {
  files: Record<string, unknown>
  list(folder: string): Promise<{ folders: string[]; files: string[] }>
  reconcileFolderCreation(realPath: string, path: string): Promise<void>
}

/**
 * Makes sure every top-level folder on disk is in the vault's file tree.
 *
 * On macOS (Obsidian 1.14.4) a fresh vault leaves out the `TaskChute` folder
 * the plugin creates while loading: the adapter knows it, the tree does not,
 * and notes created under it never reach the task list. Dropping the adapter's
 * entries and reconciling the folder again indexes it. A no-op where the tree
 * is already complete.
 */
export async function reindexVault(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const vault = window.app.vault as unknown as {
      adapter: AdapterInternals
      getAbstractFileByPath(path: string): unknown
    }
    const { adapter } = vault
    const listed = await adapter.list("/")
    for (const folder of listed.folders) {
      if (folder.startsWith(".") || vault.getAbstractFileByPath(folder)) continue
      for (const key of Object.keys(adapter.files)) {
        if (key === folder || key.startsWith(`${folder}/`)) delete adapter.files[key]
      }
      await adapter.reconcileFolderCreation(folder, folder)
    }
  })
}

/** Creates notes through the vault and waits until their frontmatter is read. */
export async function createNotes(page: Page, notes: Record<string, string>): Promise<void> {
  await reindexVault(page)
  await page.evaluate(async (entries) => {
    const vault = window.app.vault as unknown as {
      getAbstractFileByPath(path: string): unknown
      createFolder(path: string): Promise<unknown>
      create(path: string, data: string): Promise<unknown>
    }
    for (const [file, content] of entries) {
      const folder = file.slice(0, file.lastIndexOf("/"))
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder)
      await vault.create(file, content)
    }
  }, Object.entries(notes))
  await page.waitForFunction((paths) => {
    const app = window.app as unknown as {
      metadataCache: { getCache(path: string): { frontmatter?: unknown } | null }
    }
    return paths.every((p) => !!app.metadataCache.getCache(p)?.frontmatter)
  }, Object.keys(notes))
}

export type FakeAgentMode =
  /** Keeps running until it is killed (a long AI job). */
  | "runs-until-killed"
  /** Works for a few seconds, then reports success and exits 0. */
  | "finishes-on-its-own"

/**
 * A stand-in for the Claude Code CLI whose behaviour can change between
 * scenes: it reads the mode from a file each time it starts.
 *
 * A POSIX shell script, so it runs on macOS, Linux and WSL. On native Windows
 * record AI scenes with the real CLI instead.
 */
export function writeSwitchableFakeClaude(dir: string): {
  file: string
  setMode(mode: FakeAgentMode): void
} {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "claude-fake")
  const modeFile = path.join(dir, "mode")
  const setMode = (mode: FakeAgentMode) => fs.writeFileSync(modeFile, mode)
  setMode("runs-until-killed")
  const init = `{"type":"system","subtype":"init","session_id":"rec-session","model":"fake"}`
  const result = `{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"rec-session"}`
  const body = [
    "#!/bin/sh",
    `MODE=$(cat '${modeFile}')`,
    // In a terminal the CLI is a screen someone reads; headless, it is the
    // stream-json the dispatcher parses.
    "if [ -t 1 ]; then",
    "  printf '\\n  Fake Claude Code (recording stand-in)\\n\\n  > %s\\n\\n  Working...\\n' \"$2\"",
    `  if [ "$MODE" = "finishes-on-its-own" ]; then sleep 4; printf '  Done.\\n'; exit 0; fi`,
    "  exec sleep 600",
    "fi",
    `echo '${init}'`,
    `if [ "$MODE" = "finishes-on-its-own" ]; then sleep 4; echo '${result}'; exit 0; fi`,
    "exec sleep 600",
    "",
  ].join("\n")
  fs.writeFileSync(file, body, { mode: 0o755 })
  return { file, setMode }
}

/** What the fake CLI prints first when it runs in a terminal. */
export const FAKE_CLAUDE_BANNER = "Fake Claude Code"

/**
 * Waits until the terminal run of `taskPath` has printed `text`.
 *
 * A terminal run starts the user's login shell before the CLI, which takes a
 * moment; without this a short scene moves on while the terminal is still
 * blank. Reads the run's transcript file, since the terminal itself is drawn
 * on a canvas.
 */
export async function waitForTerminalOutput(page: Page, taskPath: string, text: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const transcript = await page.evaluate(
      ([id, task]) => {
        const plugin = window.app.plugins.plugins[id] as {
          aiTaskManager?: {
            getRuns(): Array<{ taskPath: string; status: string; transcriptPath?: string }>
          }
        }
        const run = plugin.aiTaskManager
          ?.getRuns()
          .find((candidate) => candidate.taskPath === task && candidate.status === "running")
        return run?.transcriptPath ?? null
      },
      ["taskchute-plus", taskPath] as const,
    )
    if (transcript && fs.existsSync(transcript) && fs.readFileSync(transcript, "utf8").includes(text)) {
      // One more beat for the terminal to paint what the file already has.
      await new Promise((resolve) => setTimeout(resolve, 600))
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`The terminal run of ${taskPath} never printed "${text}".`)
}
