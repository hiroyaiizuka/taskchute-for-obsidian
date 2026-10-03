import fs from "node:fs"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"

// Helpers for the AI task specs. The plugin internals they reach (license
// manager, AI task manager, settings) are not public API, so they are typed
// here, locally, instead of in globals.d.ts.

export const PLUGIN_ID = "taskchute-plus"
export const TASK_FOLDER = "TaskChute/Task"

/** How the fake `claude` behaves once spawned. */
export type FakeClaudeBehaviour =
  /** Keeps running until it is killed (a long AI job). */
  | "runs-until-killed"
  /** Works for a moment, then reports success and exits 0. */
  | "finishes-on-its-own"

/**
 * Writes a stand-in for the Claude Code CLI. The headless dispatcher runs
 * `claude -p --output-format stream-json --verbose -- PROMPT` and maps exit 0
 * without an error `result` line to "succeeded"; that is all it has to fake.
 */
export function writeFakeClaude(dir: string, behaviour: FakeClaudeBehaviour): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `claude-${behaviour}`)
  const init = `{"type":"system","subtype":"init","session_id":"e2e-session","model":"fake"}`
  const result = `{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"e2e-session"}`
  const body =
    behaviour === "runs-until-killed"
      ? `echo '${init}'\nexec sleep 600\n`
      : // Long enough for the test to see the run (and both timers) running.
        `echo '${init}'\nsleep 3\necho '${result}'\nexit 0\n`
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 })
  return file
}

/**
 * Turns the AI task feature on in the running plugin: settings first, then a
 * stubbed active license, then the plugin's own license-change listeners,
 * which build the AiTaskManager (syncAiTaskManagerToLicense) and tell open
 * views about it — the same path a real license activation takes.
 */
export async function enableAiTasks(page: Page, claudePath: string): Promise<void> {
  await page.evaluate(
    ([id, claude]) => {
      const plugin = window.app.plugins.plugins[id] as {
        settings: Record<string, unknown>
        licenseManager: {
          isActive: () => boolean
          state: unknown
          listeners: Set<(state: unknown) => void>
        }
      }
      plugin.settings.aiTaskEnabled = true
      // Headless: the run is a plain child process, no terminal broker.
      plugin.settings.aiTaskRunMode = "headless"
      plugin.settings.aiTaskClaudePath = claude

      const license = plugin.licenseManager
      const active = { status: "active" }
      license.state = active
      license.isActive = () => true
      for (const listener of license.listeners) listener(active)
    },
    [PLUGIN_ID, claudePath] as const,
  )
  await page.waitForFunction(
    (id) => !!(window.app.plugins.plugins[id] as { aiTaskManager?: unknown }).aiTaskManager,
    PLUGIN_ID,
  )
}

/** Today in the Obsidian process' local time, as the plugin keys days. */
export async function todayKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
}

export interface LinkedPair {
  humanPath: string
  aiPath: string
}

/**
 * Creates a human task for today and a daily AI routine linked to it by
 * `obsidian_sync` (exact title match), then waits for the metadata cache.
 */
export async function createLinkedPair(page: Page): Promise<LinkedPair> {
  const today = await todayKey(page)
  const humanTitle = "Write report"
  const humanPath = `${TASK_FOLDER}/${humanTitle}.md`
  const aiPath = `${TASK_FOLDER}/AI review.md`
  const human = ["---", "tags:", "  - task", `target_date: "${today}"`, "---", ""].join("\n")
  const ai = [
    "---",
    "tags:",
    "  - task",
    "isRoutine: true",
    "routine_type: daily",
    "routine_interval: 1",
    "routine_enabled: true",
    `routine_start: "${today}"`,
    "ai_task: true",
    "ai_task_host: claude",
    "obsidian_sync:",
    "  enabled: true",
    `  taskTitle: "${humanTitle}"`,
    "  matchType: exact",
    "---",
    "",
    "## Prompt",
    "",
    "Review the report.",
    "",
  ].join("\n")

  await page.evaluate(
    async ([folder, files]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      if (!vault.getAbstractFileByPath(folder)) {
        await vault.createFolder(folder).catch(() => undefined)
      }
      for (const [path, content] of files) await vault.create(path, content)
    },
    [TASK_FOLDER, [[humanPath, human], [aiPath, ai]]] as const,
  )
  await page.waitForFunction(
    (paths) =>
      paths.every((p) => {
        const app = window.app as unknown as {
          metadataCache: { getCache(path: string): { frontmatter?: unknown } | null }
        }
        return !!app.metadataCache.getCache(p)?.frontmatter
      }),
    [humanPath, aiPath],
  )
  return { humanPath, aiPath }
}

export async function openTaskChute(page: Page): Promise<void> {
  await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-taskchute-view`)
  await page.locator(".taskchute-view-root").waitFor()
}

/** The row of the task note at `taskPath` (the first instance, if several). */
export function taskRow(page: Page, taskPath: string): Locator {
  return page.locator(`.taskchute-view-root .task-item[data-task-path="${taskPath}"]`).first()
}

export type RowState = "idle" | "running" | "done"

/** Reads a row's state from its play/stop button, as the user sees it. */
export async function rowState(row: Locator): Promise<RowState | "missing"> {
  if ((await row.count()) === 0) return "missing"
  const done = await row.evaluate((el) => el.classList.contains("completed"))
  if (done) return "done"
  const running = await row
    .locator(".play-stop-button")
    .evaluate((el) => el.classList.contains("stop"))
  return running ? "running" : "idle"
}

export interface RunSummary {
  taskPath: string
  status: string
}

/** Every AI run the live AiTaskManager knows, shell sessions excluded. */
export async function aiRuns(page: Page): Promise<RunSummary[]> {
  return page.evaluate((id) => {
    const plugin = window.app.plugins.plugins[id] as {
      aiTaskManager?: { getRuns(): Array<{ taskPath: string; status: string; host: string }> }
    }
    return (plugin.aiTaskManager?.getRuns() ?? [])
      .filter((run) => run.host !== "shell")
      .map((run) => ({ taskPath: run.taskPath, status: run.status }))
  }, PLUGIN_ID)
}

/** Task paths in TaskChute/Log/running-task.json (empty when the file is absent). */
export function readRunningTaskPaths(vaultDir: string): string[] {
  const file = path.join(vaultDir, "TaskChute", "Log", "running-task.json")
  if (!fs.existsSync(file)) return []
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  return (Array.isArray(parsed) ? parsed : [])
    .map((entry) => (entry as { taskPath?: unknown }).taskPath)
    .filter((p): p is string => typeof p === "string")
}

/** Task paths with an entry in any TaskChute/Log/YYYY-MM-tasks.json execution log. */
export function completedTaskPaths(vaultDir: string): string[] {
  const dir = path.join(vaultDir, "TaskChute", "Log")
  if (!fs.existsSync(dir)) return []
  const paths: string[] = []
  for (const name of fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-tasks\.json$/.test(n))) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as {
      taskExecutions?: Record<string, Array<{ taskPath?: string }>>
    }
    for (const entries of Object.values(parsed.taskExecutions ?? {})) {
      for (const entry of entries) if (entry.taskPath) paths.push(entry.taskPath)
    }
  }
  return paths
}

/**
 * The final status of each AI run, from the run log notes the AiTaskManager
 * writes under TaskChute/AI/Logs once a run has ended (keyed by task path).
 */
export function aiRunLogStatuses(vaultDir: string): Record<string, string> {
  const root = path.join(vaultDir, "TaskChute", "AI", "Logs")
  const statuses: Record<string, string> = {}
  if (!fs.existsSync(root)) return statuses
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")
    const taskPath = /^task_path: "?(.*?)"?$/m.exec(text)?.[1]
    const status = /^status: (\S+)$/m.exec(text)?.[1]
    if (taskPath && status) statuses[taskPath] = status
  }
  return statuses
}
