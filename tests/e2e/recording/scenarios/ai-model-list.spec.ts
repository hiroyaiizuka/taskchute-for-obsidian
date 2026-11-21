import type { Locator, Page } from "@playwright/test"
import { enableAiTasks, openTaskChute } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"

// LEV-316: the AI model picker lists what the installed CLI offers and keeps
// it up to date. Recorded with the real Codex and Cursor CLIs (on Windows,
// where both are installed); Claude Code has no list, only its aliases.
//
// One thing is staged: the Codex list starts as if it had been fetched a day
// ago, without one model the CLI now has, so that the scene about the list
// refreshing on its own does not have to wait a day.

const DAY = 24 * 60 * 60 * 1000
const CATALOG_KEY = "taskchute-plus.ai-model-catalog"

/** The model of `codex debug models` (0.150.1) the staged list leaves out. */
const LEFT_OUT = "gpt-daybreak-blue-latest"

test("ai-model-list", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  await page.evaluate(
    ([key, fetchedAt]) => {
      const app = window.app as unknown as { saveLocalStorage(key: string, value: unknown): void }
      app.saveLocalStorage(key, {
        version: 1,
        hosts: {
          codex: {
            models: [
              { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
              { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", reasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
              { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", reasoningLevels: ["low", "medium", "high", "xhigh", "max"] },
            ],
            fetchedAt,
            firstSeen: { "gpt-5.6-sol": 0, "gpt-5.6-terra": 0, "gpt-5.6-luna": 0 },
            chosen: [],
          },
        },
      })
    },
    [CATALOG_KEY, Date.now() - DAY - 60_000] as const,
  )
  await enableAiTasks(page, "claude", "terminal")
  await page.evaluate(() => {
    const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
    workspace.leftSplit?.collapse?.()
  })
  await openTaskChute(page)

  await page.locator(".taskchute-view-root .add-task-button").click()
  const modal = page.locator(".modal-container")
  await modal.locator("input").first().fill("README を要約する")
  await modal.locator('.task-type-option[data-task-type="ai"]').click()
  await modal.locator(".ai-task-prompt-input").fill("README.md を読んで、3行でまとめて")
  await modal.locator(".ai-task-advanced > summary").click()
  const trigger = modal.locator(".ai-task-model-select")
  const menu = modal.locator(".ai-model-select__menu")
  const option = (id: string) => menu.locator(`.ai-model-select__option[data-model-id="${id}"]`)
  const preview = modal.locator(".ai-task-command-preview code")
  const reasoningModes = () =>
    modal.locator(".ai-task-reasoning-mode option").evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    )
  await trigger.scrollIntoViewIfNeeded()

  await recorder.start("AI モデルの一覧を、入っている CLI から取って新しく保つ", {
    sub: "本物の Codex と Cursor を使います。Codex の一覧は「1日前に取得した」状態から始めます",
  })

  await recorder.chapter("① Claude Code の AI モデルを開く", {
    sub: "Fable・Opus・Sonnet・Haiku の別名が並ぶ。別名はいつも最新の版を指すので、取り直しは要らない",
  })
  await recorder.click(trigger)
  await expect(menu.locator(".ai-model-select__option")).toHaveCount(5)
  await expect(option("opus").locator(".ai-model-select__option-id")).toHaveText("opus")
  await expect(menu.locator(".ai-model-select__refresh")).toHaveCount(0)
  await recorder.pause(2500)
  await recorder.click(trigger)

  await recorder.chapter("② Codex に切り替えて、1日前に取得した一覧を開く", {
    sub: "開いたときに CLI から取り直す。そのあいだも選べる。新しく出てきたモデルに「新しい」が付く",
  })
  await recorder.click(modal.locator('.ai-task-agent-card[data-ai-host="codex"]'))
  await trigger.scrollIntoViewIfNeeded()
  await recorder.click(trigger)
  await expect(option(LEFT_OUT)).toBeVisible({ timeout: 30_000 })
  await expect(option(LEFT_OUT).locator(".ai-model-select__new")).toBeVisible()
  await expect(option("gpt-5.6-sol").locator(".ai-model-select__new")).toHaveCount(0)
  await expect(menu.locator(".ai-model-select__banner")).toHaveCount(0)
  await recorder.hover(option(LEFT_OUT))
  await recorder.pause(2500)

  await recorder.chapter("③「最新のモデルを取得」を押す", {
    sub: "Codex の一覧を CLI から取り直し、取得した時刻が出る",
  })
  const before = await codexFetchedAt(page)
  await recorder.click(menu.locator(".ai-model-select__refresh"))
  await expect.poll(() => codexFetchedAt(page), { timeout: 30_000 }).toBeGreaterThan(before)
  await expect(menu.locator(".ai-model-select__refresh")).toBeEnabled()
  await expect(menu.locator(".ai-model-select__banner")).toHaveCount(0)
  await recorder.pause(2000)

  await recorder.chapter("④ 新しいモデルを選ぶ", {
    sub: "コマンドに --model で入り、推論モードに Ultra が出る。選んだので「新しい」は消える",
  })
  await recorder.click(option(LEFT_OUT))
  await expect(preview).toContainText(`--model=${LEFT_OUT}`)
  await expect.poll(reasoningModes).toEqual(["automatic", "specified", "ultra"])
  await showReasoningModes(recorder, modal)
  await trigger.scrollIntoViewIfNeeded()
  await recorder.click(trigger)
  await expect(option(LEFT_OUT).locator(".ai-model-select__new")).toHaveCount(0)
  await recorder.pause(2000)

  await recorder.chapter("⑤ GPT-5.6 Luna を選ぶ", {
    sub: "Codex の一覧で Luna は Ultra を受け付けないので、推論モードに Ultra は出ない",
  })
  await recorder.click(option("gpt-5.6-luna"))
  await expect(preview).toContainText("--model=gpt-5.6-luna")
  await expect.poll(reasoningModes).toEqual(["automatic", "specified"])
  await showReasoningModes(recorder, modal)

  await recorder.chapter("⑥ Cursor に切り替えて、AI モデルを開く", {
    sub: "まだ取得していないので CLI に聞く。モデルごとに1行、最新の版だけが並ぶ",
  })
  await recorder.click(modal.locator('.ai-task-agent-card[data-ai-host="cursor"]'))
  await trigger.scrollIntoViewIfNeeded()
  await recorder.click(trigger)
  await expect(menu.locator(".ai-model-select__banner.is-fetching")).toBeVisible()
  await expect(menu.locator(".ai-model-select__option")).not.toHaveCount(1, { timeout: 60_000 })
  await expect(menu.locator(".ai-model-select__banner")).toHaveCount(0)
  await expect(menu.locator('.ai-model-select__option[data-model-id="auto"]')).toHaveCount(0)
  await expect(menu.locator(".ai-model-select__new")).toHaveCount(0)
  await recorder.hover(menu.locator(".ai-model-select__option").nth(3))
  await menu.locator(".ai-model-select__list").evaluate((list) => {
    list.parentElement?.scrollBy({ top: 200, behavior: "smooth" })
  })
  await recorder.pause(3000)
})

/** When the Codex list on this device was fetched, as the plugin stored it. */
async function codexFetchedAt(page: Page): Promise<number> {
  return page.evaluate((key) => {
    const app = window.app as unknown as { loadLocalStorage(key: string): unknown }
    const stored = app.loadLocalStorage(key) as { hosts?: { codex?: { fetchedAt?: number } } } | null
    return stored?.hosts?.codex?.fetchedAt ?? 0
  }, CATALOG_KEY)
}

/** Opens the reasoning mode list long enough to read it, then closes it. */
async function showReasoningModes(
  recorder: { hover(target: Locator): Promise<void>; pause(ms: number): Promise<void> },
  modal: Locator,
): Promise<void> {
  const select = modal.locator(".ai-task-reasoning-mode")
  await select.scrollIntoViewIfNeeded()
  await recorder.hover(select)
  // A native <select> list is drawn outside the page and does not show in the
  // recording; show its options as the page's own list instead.
  await select.evaluate((element) => {
    const el = element as HTMLSelectElement
    el.size = el.options.length
    el.style.height = "auto"
  })
  await recorder.pause(2500)
  await select.evaluate((element) => {
    const el = element as HTMLSelectElement
    el.size = 0
    el.style.height = ""
  })
}
