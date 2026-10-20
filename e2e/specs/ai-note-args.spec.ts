import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, enableAiTasks, openTaskChute, taskRow, todayKey } from "../helpers/aiTask"

// LEV-386: a task note can come from anyone who can write to a synced vault,
// so what it says is a request. Only what the task settings can choose
// reaches the CLI; skip permissions runs only where this device allowed it,
// asked once when the user starts such a task.

/** A stand-in CLI that appends the arguments of each run as one line. */
function writeArgvRecorder(dir: string): { bin: string; argvFile: string } {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, "claude")
  const argvFile = path.join(dir, "argv.txt")
  fs.writeFileSync(
    bin,
    `#!/bin/sh\n{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\n'; } >> '${argvFile}'\nexec sleep 60\n`,
    { mode: 0o755 },
  )
  return { bin, argvFile }
}

function recordedRuns(argvFile: string): string[][] {
  if (!fs.existsSync(argvFile)) return []
  return fs
    .readFileSync(argvFile, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\u001f").filter((arg) => arg.length > 0))
}

/** An AI task note for today whose ai_task_args the test chooses. */
async function createAiTask(page: Page, name: string, args: string[]): Promise<string> {
  const taskPath = `${TASK_FOLDER}/${name}.md`
  const note = [
    "---",
    "tags:",
    "  - task",
    `target_date: "${await todayKey(page)}"`,
    "ai_task: true",
    "ai_task_host: claude",
    "ai_task_args:",
    ...args.map((arg) => `  - ${JSON.stringify(arg)}`),
    "---",
    "",
    "## Prompt",
    "",
    `${name}.`,
    "",
  ].join("\n")
  await page.evaluate(
    async ([folder, file, content]) => {
      const vault = window.app.vault as unknown as {
        getAbstractFileByPath(path: string): unknown
        createFolder(path: string): Promise<unknown>
        create(path: string, data: string): Promise<unknown>
      }
      if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined)
      await vault.create(file, content)
    },
    [TASK_FOLDER, taskPath, note] as const,
  )
  await page.waitForFunction((p) => {
    const app = window.app as unknown as {
      metadataCache: { getCache(path: string): { frontmatter?: unknown } | null }
    }
    return !!app.metadataCache.getCache(p)?.frontmatter
  }, taskPath)
  return taskPath
}

test("a note's arguments are a request: skip permissions is asked once, other arguments are left out", async ({ obsidian }, testInfo) => {
  const { page } = obsidian
  const recorder = writeArgvRecorder(testInfo.outputPath("bin"))
  await enableAiTasks(page, recorder.bin)
  const asked = ["--dangerously-skip-permissions", "--settings", "hooks.json"]
  const first = await createAiTask(page, "Weekly cleanup", asked)
  const second = await createAiTask(page, "Inbox triage", asked)
  const third = await createAiTask(page, "Journal digest", asked)
  await openTaskChute(page)

  const dialog = page.locator(".modal-container .taskchute-confirm-modal")
  const notices = page.locator(".notice")

  // ▶ on a skip-permissions task: asked first. Auto mode this time.
  await taskRow(page, first).locator(".play-stop-button").click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Run "Weekly cleanup" with skip permissions?')
  await dialog.getByRole("button", { name: "Run in auto mode this time" }).click()
  await expect.poll(() => recordedRuns(recorder.argvFile).length, { timeout: 20_000 }).toBe(1)
  const [auto] = recordedRuns(recorder.argvFile)
  expect(auto).toEqual(expect.arrayContaining(["--permission-mode", "auto"]))
  expect(auto).not.toContain("--dangerously-skip-permissions")
  // An argument the task settings cannot set never reaches the CLI.
  expect(auto).not.toContain("--settings")
  expect(auto).not.toContain("hooks.json")
  await expect(notices.filter({ hasText: "--settings hooks.json" }).first()).toBeVisible()

  // The next one: allowed, and remembered on this device.
  await taskRow(page, second).locator(".play-stop-button").click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Use it (remember on this device)" }).click()
  await expect.poll(() => recordedRuns(recorder.argvFile).length, { timeout: 20_000 }).toBe(2)
  const allowed = recordedRuns(recorder.argvFile)[1]
  expect(allowed).toContain("--dangerously-skip-permissions")
  expect(allowed).not.toContain("--settings")

  // Not asked again.
  await taskRow(page, third).locator(".play-stop-button").click()
  await expect.poll(() => recordedRuns(recorder.argvFile).length, { timeout: 20_000 }).toBe(3)
  await expect(dialog).toHaveCount(0)
  expect(recordedRuns(recorder.argvFile)[2]).toContain("--dangerously-skip-permissions")

  // The choice lives on this device, not in the plugin's synced settings.
  const stored = await page.evaluate((id) => {
    const app = window.app as unknown as { loadLocalStorage(key: string): unknown }
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
    return {
      device: app.loadLocalStorage("taskchute-plus-ai-skip-permissions"),
      synced: JSON.stringify(plugin.settings).includes("skip"),
    }
  }, PLUGIN_ID)
  expect(stored).toEqual({ device: true, synced: false })
})
