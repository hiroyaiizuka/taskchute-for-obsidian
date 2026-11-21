import fs from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import { PLUGIN_ID, TASK_FOLDER, openTaskChute, taskRow, todayKey } from "../../helpers/aiTask"
import { expect, test } from "../fixtures"
import { createNotes } from "../helpers"

// LEV-319: a task's project is picked like Obsidian's quick switcher, and a
// name no project has is created and linked in the same step — one modal,
// nothing stacked on it. Recorded in Obsidian's own mobile emulation at a
// phone's size; the emulation has no on-screen keyboard and no IME.

const PROJECTS = "Projects"
const PHONE = { width: 430, height: 880 }
const ARTICLE = `${TASK_FOLDER}/記事を書く.md`
const PHOTOS = `${TASK_FOLDER}/写真を選ぶ.md`

const read = (vaultDir: string, file: string) => fs.readFileSync(path.join(vaultDir, file), "utf8")

async function setProjectsFolder(page: Page, folder: string | null): Promise<void> {
  await page.evaluate(
    ([id, value]) => {
      const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
      plugin.settings.projectsFolder = value
    },
    [PLUGIN_ID, folder] as const,
  )
}

test("project-picker-mobile", async ({ obsidian, recorder }) => {
  const { page, vaultDir } = obsidian
  // Phone, not tablet: Obsidian decides by the window's width, so size it first.
  await page.evaluate(([width, height]) => {
    const host = window as unknown as {
      electron?: { remote?: { getCurrentWindow?: () => { setContentSize?: (w: number, h: number) => void } } }
    }
    host.electron?.remote?.getCurrentWindow?.()?.setContentSize?.(width, height)
  }, [PHONE.width, PHONE.height] as const)
  await page.evaluate(() => (window.app as unknown as { emulateMobile(on: boolean): void }).emulateMobile(true))
  await page.waitForFunction(() => document.body.classList.contains("is-phone"), undefined, { timeout: 15_000 })
  // Turning the emulation on reloads the plugins.
  await page.waitForFunction((id) => !!window.app.plugins.plugins[id], PLUGIN_ID, { timeout: 15_000 })
  await setProjectsFolder(page, PROJECTS)
  const today = await todayKey(page)
  const task = (date: string) => ["---", "tags:", "  - task", `target_date: "${date}"`, "---", ""].join("\n")
  await createNotes(page, { [ARTICLE]: task(today), [PHOTOS]: task(today) })
  await openTaskChute(page)
  await expect(taskRow(page, ARTICLE)).toBeVisible()

  const picker = page.locator(".taskchute-project-picker")
  const input = picker.locator(".prompt-input")
  const rows = picker.locator(".suggestion-item")
  const openPicker = async (taskPath: string) => {
    await recorder.click(taskRow(page, taskPath).locator(".settings-task-button"))
    await recorder.click(page.locator(".task-settings-tooltip .tooltip-item", { hasText: "プロジェクトを設定" }))
    await expect(picker).toBeVisible()
  }

  await recorder.start("タスクから、新しいプロジェクトを作って紐づける", {
    sub: "Obsidian のスマホ表示（モバイルのエミュレーション）で操作します。プロジェクトはまだ0件です",
    size: PHONE,
  })

  await recorder.chapter("① ⚙ から「プロジェクトを設定」を開く", {
    sub: "クイックスイッチャーと同じ一覧が開く。スマホでは入力欄が下。まだ0件なので、名前を打てば作れると出る",
  })
  await openPicker(ARTICLE)
  await expect(picker).toContainText("まだプロジェクトがありません")
  await recorder.pause(1500)

  await recorder.chapter("② 新しい名前を打って「作成」を押す", {
    sub: "一覧に「作成」が出る。押すとプロジェクトを作って、そのままタスクに紐づく",
  })
  await input.pressSequentially("ブログ連載", { delay: 140 })
  await expect(rows).toHaveText(["＋「ブログ連載」を作成"])
  await recorder.pause(800)
  await recorder.click(rows.first())
  await expect(picker).toHaveCount(0)
  await expect.poll(() => read(vaultDir, ARTICLE)).toContain("[[Project - ブログ連載]]")
  expect(read(vaultDir, `${PROJECTS}/Project - ブログ連載.md`)).toMatch(/status: todo/)
  await expect(taskRow(page, ARTICLE).locator(".taskchute-project-name")).toHaveText("ブログ連載")
  await recorder.pause(1500)

  await recorder.chapter("③ 別のタスクで、作ったプロジェクトを選ぶ", {
    sub: "途中まで打つと絞られる。似た名前が先頭に出て（Enter で選ばれる）、「作成」はその次",
  })
  await openPicker(PHOTOS)
  await expect(rows).toHaveText(["ブログ連載"])
  await input.pressSequentially("ブログ", { delay: 140 })
  await expect(rows).toHaveText(["ブログ連載", "＋「ブログ」を作成"])
  await recorder.pause(1200)
  await recorder.click(rows.first())
  await expect.poll(() => read(vaultDir, PHOTOS)).toContain("[[Project - ブログ連載]]")
  await expect(taskRow(page, PHOTOS).locator(".taskchute-project-name")).toHaveText("ブログ連載")
  await recorder.pause(1500)

  await recorder.chapter("④ もう一度開いて、閉じる", {
    sub: "いまのプロジェクトに ✓ が付く。閉じれば何も変わらない",
  })
  await openPicker(PHOTOS)
  await expect(rows.filter({ hasText: "ブログ連載" })).toContainText("✓")
  await recorder.pause(1500)
  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
  expect(fs.readdirSync(path.join(vaultDir, PROJECTS))).toEqual(["Project - ブログ連載.md"])

  await recorder.chapter("⑤ プロジェクトボードを開く", {
    sub: "作ったプロジェクトは「未着手」の列に出る",
  })
  const view = page.locator(".taskchute-view-root")
  await recorder.click(view.locator(".drawer-toggle"))
  await recorder.click(view.locator('.navigation-nav-item[data-section="projects"]'))
  await expect(
    page.locator('.project-board-column[data-status="todo"] .project-board-card', { hasText: "ブログ連載" }),
  ).toBeVisible()
  await recorder.pause(2500)
})
