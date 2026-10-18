import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, taskRow, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-345: ⚙ "レシピを変更・解除" opens the same edit dialog as the recipe
// popover's ✏, with the recipe's contents, plus "レシピを解除" at the bottom.
// "レシピを設定" and the popover flow are unchanged. On a phone the reorder
// grip shows and "+ 手順を追加" lines up with the step inputs.
// Nothing is faked; the recipe and tasks are written before the recording.

const RECIPE = "TaskChute/Recipes/週次レビュー.md"
const WEEKLY = `${TASK_FOLDER}/週次の振り返り.md`
const EMAIL = `${TASK_FOLDER}/メール処理.md`

function recipeDocument(): string {
  const steps = ["今週の完了タスクを振り返る", "やり残しを来週へ移す", "来週の優先タスクを 3 つ決める"]
  return [
    "---",
    "taskchute_recipe: true",
    "taskchute_recipe_version: 2",
    'title: "週次レビュー"',
    "---",
    "",
    "<!-- taskchute-recipe:goal:start -->",
    "## 完了基準",
    "",
    "来週の優先タスク 3 つが決まり、カレンダーに入っている",
    "<!-- taskchute-recipe:goal:end -->",
    "",
    "<!-- taskchute-recipe:checklist:start -->",
    "## 手順チェックリスト",
    "",
    ...steps.map((s, i) => `- [ ] ${s} <!-- taskchute-step-id: step-${i} -->`),
    "<!-- taskchute-recipe:checklist:end -->",
    "",
    "<!-- taskchute-recipe:quality-checklist:start -->",
    "## 品質基準チェックリスト",
    "",
    "- [ ] 優先タスクに期限がある <!-- taskchute-quality-check-id: quality-0 -->",
    "<!-- taskchute-recipe:quality-checklist:end -->",
    "",
    "<!-- taskchute-recipe:constraints:start -->",
    "## 制約・ルール",
    "",
    "- 30 分以内に終える",
    "<!-- taskchute-recipe:constraints:end -->",
    "",
  ].join("\n")
}

async function setUp(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown>; saveSettings(): Promise<void> }
    plugin.settings.recipeFeatureEnabled = true
    await plugin.saveSettings()
  }, PLUGIN_ID)
  const today = await todayKey(page)
  const task = (recipe?: string) =>
    ["---", "tags:", "  - task", `target_date: "${today}"`, ...(recipe ? [`recipe: "[[${recipe}]]"`] : []), "---", ""].join("\n")
  await createNotes(page, {
    [RECIPE]: recipeDocument(),
    [WEEKLY]: task(RECIPE),
    [EMAIL]: task(),
    [`${TASK_FOLDER}/企画書を書く.md`]: task(),
  })
  await openTaskChute(page)
  await expect(taskRow(page, WEEKLY).locator(".recipe-task-badge")).toBeVisible()
}

const dialog = (page: Page) => page.locator(".modal.recipe-modal-content")
const menuItem = (page: Page, label: string) => page.locator(".task-settings-tooltip .tooltip-item", { hasText: label })

test("recipe-edit-from-menu", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  await setUp(page)

  await recorder.start("⚙ の「レシピを変更・解除」で、レシピの中身を直せるようになった", {
    sub: "LEV-345 · Mac 版（デスクトップ）",
  })

  await recorder.chapter("① ⚙ →「レシピを変更・解除」", { sub: "アイコンの ✏ と同じ「レシピ編集」が、中身入りで開く" })
  await recorder.click(taskRow(page, WEEKLY).locator(".settings-task-button"))
  await recorder.click(menuItem(page, "レシピを変更・解除"))
  await expect(dialog(page).locator(".modal-title")).toHaveText("レシピ編集")
  await expect(dialog(page).locator(".recipe-title-input")).toHaveValue("週次レビュー")
  await expect(dialog(page).locator(".recipe-step-input")).toHaveCount(3)
  await expect(dialog(page).locator(".modal-button-container button")).toHaveText(["レシピを解除", "キャンセル", "保存"])

  await recorder.chapter("② 手順を足して保存する", { sub: "レシピの中身が変わる" })
  const addStep = dialog(page).locator(".recipe-add-step-button").first()
  await addStep.scrollIntoViewIfNeeded()
  await recorder.click(addStep)
  const newStep = dialog(page).locator(".recipe-step-input").nth(3)
  await newStep.pressSequentially("カレンダーに時間を確保する", { delay: 40 })
  await recorder.click(dialog(page).getByRole("button", { name: "保存" }))
  await expect(dialog(page)).toHaveCount(0)

  await recorder.chapter("③ アイコンのポップオーバーにも反映", { sub: "✏ からは同じダイアログ（解除ボタンはない）" })
  await recorder.click(taskRow(page, WEEKLY).locator(".recipe-task-badge"))
  await expect(page.getByText("カレンダーに時間を確保する")).toBeVisible()
  await recorder.click(page.locator(".recipe-run-edit-button"))
  await expect(dialog(page).locator(".modal-title")).toHaveText("レシピ編集")
  await expect(dialog(page).locator(".modal-button-container button")).toHaveText(["キャンセル", "保存"])
  await recorder.click(dialog(page).getByRole("button", { name: "キャンセル" }))
  await expect(dialog(page)).toHaveCount(0)

  await recorder.chapter("④ 一番下の「レシピを解除」", { sub: "タスクからレシピが外れ、アイコンが消える（レシピは残る）" })
  await recorder.click(taskRow(page, WEEKLY).locator(".settings-task-button"))
  await recorder.click(menuItem(page, "レシピを変更・解除"))
  await recorder.click(dialog(page).locator(".recipe-unassign-button"))
  await expect(dialog(page)).toHaveCount(0)
  await expect(taskRow(page, WEEKLY).locator(".recipe-task-badge")).toHaveCount(0)

  await recorder.chapter("⑤ レシピなしは「レシピを設定」", { sub: "いまと同じ、選ぶ画面のまま" })
  await recorder.click(taskRow(page, EMAIL).locator(".settings-task-button"))
  await recorder.click(menuItem(page, "レシピを設定"))
  await expect(dialog(page).locator(".modal-title")).toHaveText("レシピを設定")
  await expect(dialog(page).locator(".recipe-search-input")).toBeVisible()
  await recorder.pause(1500)
})

test("recipe-edit-from-menu-phone", async ({ obsidian, recorder }) => {
  const { page } = obsidian
  await page.evaluate(() => (window.app as unknown as { emulateMobile(on: boolean): void }).emulateMobile(true))
  await page.waitForTimeout(1500)
  await setUp(page)

  await recorder.start("スマホでも同じダイアログ", { sub: "LEV-345 · モバイル表示", size: { width: 390, height: 844 } })
  await expect(page.locator("body.is-phone")).toHaveCount(1)
  await openTaskChute(page)

  await recorder.chapter("① ⚙ →「レシピを変更・解除」", { sub: "並べ替えのつまみが見える" })
  await recorder.click(taskRow(page, WEEKLY).locator(".settings-task-button"))
  await recorder.click(menuItem(page, "レシピを変更・解除"))
  await expect(dialog(page).locator(".modal-title")).toHaveText("レシピ編集")
  const grip = dialog(page).locator(".recipe-step-drag-handle").first()
  await expect.poll(() => grip.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.5)

  await recorder.chapter("②「+ 手順を追加」が手順の欄とそろう", { sub: "左端・幅・高さが同じ" })
  const add = dialog(page).locator(".recipe-add-step-button").first()
  await add.scrollIntoViewIfNeeded()
  const aligned = await page.evaluate(() => {
    const input = document.querySelector(".modal .recipe-step-input")!.getBoundingClientRect()
    const button = document.querySelector(".modal .recipe-add-step-button")!.getBoundingClientRect()
    return [input.left, input.width, input.height].map(Math.round).join() === [button.left, button.width, button.height].map(Math.round).join()
  })
  expect(aligned).toBe(true)
  await recorder.hover(add)

  await recorder.chapter("③ 一番下に「レシピを解除」", { sub: "保存・キャンセルの下" })
  const remove = dialog(page).locator(".recipe-unassign-button")
  await remove.scrollIntoViewIfNeeded()
  const below = await page.evaluate(() => {
    const cancel = document.querySelector(".modal .modal-button-container .mod-cancel")!.getBoundingClientRect()
    const button = document.querySelector(".modal .recipe-unassign-button")!.getBoundingClientRect()
    return button.top > cancel.top
  })
  expect(below).toBe(true)
  await recorder.click(remove)
  await expect(dialog(page)).toHaveCount(0)
  await expect(taskRow(page, WEEKLY).locator(".recipe-task-badge")).toHaveCount(0)
  await recorder.pause(1200)
})
