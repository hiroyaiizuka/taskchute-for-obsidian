import fs from "node:fs"
import path from "node:path"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, enableAiTasks, openTaskChute, writeFakeClaude, writeNodeCli } from "../helpers/aiTask"

// LEV-316: the AI model picker lists what the installed CLI offers. Cursor's
// list comes from `cursor-agent models` (a stand-in here whose answer the test
// changes); Claude Code has no such list, only its aliases.

const FIRST_LIST = [
  "Available models",
  "",
  "auto - Auto (current, default)",
  "composer-2.5 - Composer 2.5",
  "claude-opus-5-low - Claude Opus 5 1M Low",
  "claude-opus-5-medium - Claude Opus 5 1M",
  "claude-opus-5-high-fast - Claude Opus 5 1M High Fast",
]

const SECOND_LIST = [
  ...FIRST_LIST,
  "claude-opus-5-5-low - Claude Opus 5.5 1M Low",
  "claude-opus-5-5-medium - Claude Opus 5.5 1M",
  "gemini-4-argon-medium - Gemini 4 Argon Medium",
]

/** A stand-in for `cursor-agent` that prints the model list in `listFile` for `models`. */
function writeFakeCursor(dir: string): { bin: string; listFile: string; callsFile: string } {
  fs.mkdirSync(dir, { recursive: true })
  const listFile = path.join(dir, "models.txt")
  const callsFile = path.join(dir, "calls.txt")
  fs.writeFileSync(listFile, `${FIRST_LIST.join("\n")}\n`)
  const bin = writeNodeCli(
    dir,
    "cursor-agent",
    [
      `const fs = require("node:fs")`,
      `if (process.argv[2] === "models") {`,
      `  fs.appendFileSync(${JSON.stringify(callsFile)}, "models\\n")`,
      // A real list asks the account and takes a moment.
      `  setTimeout(() => { process.stdout.write(fs.readFileSync(${JSON.stringify(listFile)}, "utf8")); process.exit(0) }, 1_000)`,
      `} else process.exit(0)`,
    ].join("\n"),
  )
  return { bin, listFile, callsFile }
}

test("the model picker lists the CLI's models, refreshes them, and marks the new ones", async ({ obsidian }, testInfo) => {
  const { page } = obsidian
  await enableAiTasks(page, writeFakeClaude(testInfo.outputPath("bin"), "finishes-on-its-own"))
  const cursor = writeFakeCursor(testInfo.outputPath("cursor-bin"))
  await page.evaluate(
    ([id, bin]) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
      plugin.settings.aiTaskCursorPath = bin
    },
    [PLUGIN_ID, cursor.bin] as const,
  )
  await openTaskChute(page)

  await page.locator(".taskchute-view-root .add-task-button").click()
  const modal = page.locator(".modal-container")
  await modal.locator(".task-type-option[data-task-type=\"ai\"]").click()
  await modal.locator(".ai-task-advanced > summary").click()
  const trigger = modal.locator(".ai-task-model-select")
  const menu = modal.locator(".ai-model-select__menu")
  const option = (id: string) => menu.locator(`.ai-model-select__option[data-model-id="${id}"]`)

  // Claude Code: its aliases, which never go stale, so nothing to refresh.
  await trigger.click()
  await expect(menu.locator(".ai-model-select__option")).toHaveCount(5)
  await expect(option("opus").locator(".ai-model-select__option-id")).toHaveText("opus")
  await expect(menu.locator(".ai-model-select__refresh")).toHaveCount(0)
  await trigger.click()

  // Cursor: opening asks the CLI, and the list can be used meanwhile.
  await modal.locator(".ai-task-agent-card[data-ai-host=\"cursor\"]").click()
  await trigger.click()
  await expect(menu.locator(".ai-model-select__banner.is-fetching")).toBeVisible()
  await expect(option("claude-opus-5-medium")).toBeVisible({ timeout: 15_000 })
  await expect(menu.locator(".ai-model-select__banner")).toHaveCount(0)
  // One row per model (its plain or medium variant), without "auto".
  await expect(menu.locator(".ai-model-select__option")).toHaveCount(3)
  await expect(option("claude-opus-5-medium").locator(".ai-model-select__option-title")).toHaveText("Claude Opus 5")
  await expect(menu.locator(".ai-model-select__fetched-at")).not.toHaveText(/まだ|Not fetched/)
  // The first list marks nothing new.
  await expect(menu.locator(".ai-model-select__new")).toHaveCount(0)

  // The CLI now offers more; refreshing shows only the newest of each model, marked new.
  fs.writeFileSync(cursor.listFile, `${SECOND_LIST.join("\n")}\n`)
  await menu.locator(".ai-model-select__refresh").click()
  await expect(option("claude-opus-5-5-medium")).toBeVisible({ timeout: 15_000 })
  await expect(option("claude-opus-5-medium")).toHaveCount(0)
  await expect(option("claude-opus-5-5-medium").locator(".ai-model-select__new")).toBeVisible()
  await expect(option("gemini-4-argon-medium").locator(".ai-model-select__new")).toBeVisible()
  await expect(option("composer-2.5").locator(".ai-model-select__new")).toHaveCount(0)

  // Choosing one passes it to the CLI and it is no longer new.
  await option("claude-opus-5-5-medium").click()
  await modal.locator(".ai-task-prompt-input").fill("Go")
  await expect(modal.locator(".ai-task-command-preview code")).toContainText("--model=claude-opus-5-5-medium")
  await trigger.click()
  await expect(option("claude-opus-5-5-medium").locator(".ai-model-select__new")).toHaveCount(0)
  await expect(option("gemini-4-argon-medium").locator(".ai-model-select__new")).toBeVisible()

  // A fresh list is not asked again when the picker opens.
  await trigger.click()
  await trigger.click()
  await expect(menu.locator(".ai-model-select__banner")).toHaveCount(0)
  expect(fs.readFileSync(cursor.callsFile, "utf8").trim().split("\n")).toHaveLength(2)
})
