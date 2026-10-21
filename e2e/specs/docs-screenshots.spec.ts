import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Locator, Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { PLUGIN_ID, TASK_FOLDER, enableAiTasks, openTaskChute, rowState, taskRow, todayKey } from "../helpers/aiTask"

// Screenshots for the official documentation (not a test of behaviour).
// Runs only with TASKCHUTE_DOCS_SHOTS_DIR set; writes PNGs there, one set per
// UI language. The AI pane and session history use the real Claude Code
// (TASKCHUTE_DOCS_CLAUDE), started with no user settings, on Sonnet.

const OUT = process.env.TASKCHUTE_DOCS_SHOTS_DIR ?? ""
const REAL_CLAUDE = process.env.TASKCHUTE_DOCS_CLAUDE ?? ""
/** Hidden from the screen: keeps the answer on the topic, in the page's language. */
const INSTRUCTION = {
  ja: "作業フォルダの名前や中身には触れず、人名や由来・歴史にも触れず、考え方と使い方だけを短く、日本語で答えてください。",
  en: "Answer briefly in English, with the idea and how it is used only. Do not mention the working folder, people, or history.",
} as const

type Lang = "ja" | "en"
const TEXT = {
  ja: {
    plan: "企画書を書く", research: "タスクシュートを調べる", blog: "ブログを書く", weekly: "週次レビュー",
    headings: "ブログの見出し案を出す", recipe: "ブログ記事の下書き",
    prompt: "タスクシュートとは何なのか、3行で教えて", search: "何なのか",
    comment: "見出しは3つに決めた", dayComment: "午前は集中できた",
    goal: "見出しと要約のある下書きが1本できている",
    steps: ["読者と伝えたいことを1行で書く", "見出しを3つ決める", "見出しごとに本文を書く"],
    checks: ["見出しだけで内容がわかる", "2000字以内"], constraint: "公開はしない（下書きまで）",
    headingsPrompt: "タスクシュートについてのブログ記事の見出し案を3つ出して",
    changeType: "種別を変更", recipesNav: "レシピ", newRecipe: "新規",
  },
  en: {
    plan: "Write the proposal", research: "Research TaskChute", blog: "Write a blog post", weekly: "Weekly review",
    headings: "Draft blog headings", recipe: "Blog post draft",
    prompt: "What is TaskChute? Answer in three lines.", search: "TaskChute",
    comment: "Settled on three headings", dayComment: "Focused well this morning",
    goal: "One draft with headings and a summary is done",
    steps: ["Write the reader and the message in one line", "Decide three headings", "Write the body for each heading"],
    checks: ["The headings alone tell the content", "Under 800 words"], constraint: "Do not publish (draft only)",
    headingsPrompt: "Suggest three headings for a blog post about TaskChute",
    changeType: "Change task type", recipesNav: "Recipes", newRecipe: "New",
  },
} as const

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g")
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?<>=]*[A-Za-z]`, "g")

function writeClaude(dir: string, lang: "ja" | "en"): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "claude")
  const real = REAL_CLAUDE.replace(/'/g, "'\\''")
  fs.writeFileSync(
    file,
    `#!/bin/sh\nexec '${real}' --setting-sources project,local --model sonnet --append-system-prompt '${INSTRUCTION[lang]}' "$@"\n`,
    { mode: 0o755 },
  )
  return file
}

function removeSessionsOf(vault: string): void {
  const project = path.join(os.homedir(), ".claude", "projects", vault.replace(/[^a-zA-Z0-9]/g, "-"))
  if (fs.existsSync(project)) fs.rmSync(project, { recursive: true, force: true })
}

async function terminalText(page: Page, taskPath: string): Promise<string> {
  const transcript = await page.evaluate(
    ([id, task]) => {
      const plugin = window.app.plugins.plugins[id] as {
        aiTaskManager?: { getRuns(): Array<{ taskPath: string; transcriptPath?: string }> }
      }
      return (plugin.aiTaskManager?.getRuns() ?? []).filter((run) => run.taskPath === task).pop()?.transcriptPath ?? null
    },
    [PLUGIN_ID, taskPath] as const,
  )
  if (!transcript || !fs.existsSync(transcript)) return ""
  return fs.readFileSync(transcript, "utf8").replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(/\s+/g, "")
}

/**
 * The docs' screenshots use the look of the Levers vault: the Atom theme,
 * dark, accent #f0848a. The theme is copied from that vault (read only).
 */
const THEME_SOURCE = process.env.TASKCHUTE_DOCS_THEME_DIR ?? ""
const ACCENT = "#f0848a"

async function applyAppearance(page: Page, vault: string): Promise<void> {
  if (!THEME_SOURCE) return
  const configDir = await page.evaluate(() => (window.app.vault as unknown as { configDir: string }).configDir)
  const target = path.join(vault, configDir, "themes", "Atom")
  fs.mkdirSync(target, { recursive: true })
  for (const name of ["manifest.json", "theme.css"]) fs.copyFileSync(path.join(THEME_SOURCE, name), path.join(target, name))
  await page.evaluate(async (accent) => {
    const app = window.app as unknown as {
      changeTheme?: (theme: string) => void
      customCss?: { setTheme?: (name: string) => void; readThemes?: () => Promise<void> }
      vault: { setConfig?: (key: string, value: unknown) => void }
      updateAccentColor?: () => void
    }
    await app.customCss?.readThemes?.()
    app.changeTheme?.("obsidian")
    app.customCss?.setTheme?.("Atom")
    app.vault.setConfig?.("accentColor", accent)
    app.updateAccentColor?.()
  }, ACCENT)
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("theme-dark"))).toBe(true)
  await expect
    .poll(() => page.evaluate(() => (window.app as unknown as { customCss?: { theme?: string } }).customCss?.theme ?? ""))
    .toBe("Atom")
  await page.waitForTimeout(800)
}

async function sizeWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as {
      electron?: { remote?: { getCurrentWindow?: () => { setContentSize?: (w: number, h: number) => void } } }
    }
    host.electron?.remote?.getCurrentWindow?.()?.setContentSize?.(1280, 800)
  })
  await page.waitForTimeout(600)
}

/** One element, or the box around several, with a margin. */
async function shot(page: Page, lang: Lang, name: string, targets: Locator[], margin = 12): Promise<void> {
  const boxes = []
  for (const target of targets) {
    const box = await target.boundingBox()
    if (box) boxes.push(box)
  }
  if (boxes.length === 0) throw new Error(`nothing to capture for ${name}`)
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin)
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin)
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + margin
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + margin
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, lang, `${name}.png`), clip: { x, y, width: right - x, height: bottom - y } })
}

for (const lang of ["ja", "en"] as const) {
  test.describe(`docs screenshots (${lang})`, () => {
    test.use({ language: lang })
    test(`docs-shots-${lang}`, async ({ obsidian }, testInfo) => {
      test.skip(!OUT || !REAL_CLAUDE, "Set TASKCHUTE_DOCS_SHOTS_DIR and TASKCHUTE_DOCS_CLAUDE to take the documentation screenshots.")
      test.setTimeout(10 * 60_000)
      fs.mkdirSync(path.join(OUT, lang), { recursive: true })
      const t = TEXT[lang]
      const { page } = obsidian
      const vault = await page.evaluate(() => (window.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath())
      removeSessionsOf(vault)
      const today = await todayKey(page)
      const p = (name: string) => `${TASK_FOLDER}/${name}.md`

      await sizeWindow(page)
      await applyAppearance(page, vault)
      await enableAiTasks(page, writeClaude(testInfo.outputPath("bin"), lang), "terminal")
      await page.evaluate((id) => {
        const plugin = window.app.plugins.plugins[id] as { settings: Record<string, unknown> }
        plugin.settings.recipeFeatureEnabled = true
        plugin.settings.dayCommentsEnabled = true
      }, PLUGIN_ID)
      const fm = (lines: string[], body: string[] = []) => ["---", "tags:", "  - task", ...lines, "---", "", ...body].join("\n")
      const routine = ["isRoutine: true", "routine_type: daily", "routine_interval: 1", "routine_enabled: true", `routine_start: "${today}"`]
      const recipePath = `TaskChute/Recipes/${t.recipe}.md`
      const recipe = [
        "---", "taskchute_recipe: true", "taskchute_recipe_version: 2", `title: "${t.recipe}"`, "---", "",
        "<!-- taskchute-recipe:goal:start -->", "## 完了基準", "", t.goal, "<!-- taskchute-recipe:goal:end -->", "",
        "<!-- taskchute-recipe:checklist:start -->", "## 手順チェックリスト", "",
        ...t.steps.map((s, i) => `- [ ] ${s} <!-- taskchute-step-id: step-${i + 1} -->`),
        "<!-- taskchute-recipe:checklist:end -->", "",
        "<!-- taskchute-recipe:quality-checklist:start -->", "## 品質基準チェックリスト", "",
        ...t.checks.map((s, i) => `- [ ] ${s} <!-- taskchute-quality-check-id: quality-${i + 1} -->`),
        "<!-- taskchute-recipe:quality-checklist:end -->", "",
        "<!-- taskchute-recipe:constraints:start -->", "## 制約・ルール", "", `- ${t.constraint}`, "<!-- taskchute-recipe:constraints:end -->", "",
      ].join("\n")
      await page.evaluate(
        async (files) => {
          const v = window.app.vault as unknown as {
            getAbstractFileByPath(path: string): unknown
            createFolder(path: string): Promise<unknown>
            create(path: string, data: string): Promise<unknown>
          }
          for (const folder of ["TaskChute", "TaskChute/Task", "TaskChute/Recipes"]) {
            if (!v.getAbstractFileByPath(folder)) await v.createFolder(folder).catch(() => undefined)
          }
          for (const [file, content] of files) await v.create(file, content)
        },
        [
          [p(t.plan), fm([`target_date: "${today}"`, 'scheduled_time: "09:00"'])],
          [p(t.blog), fm([`target_date: "${today}"`, 'scheduled_time: "10:00"'])],
          [p(t.weekly), fm([`target_date: "${today}"`, 'scheduled_time: "17:00"'])],
          [p(t.headings), fm([...routine, "ai_task: true", "ai_task_host: claude", `recipe: "[[${recipePath}]]"`,
            "obsidian_sync:", "  enabled: true", `  taskTitle: "${t.blog}"`, "  matchType: exact"], ["## Prompt", "", t.headingsPrompt, ""])],
          [recipePath, recipe],
        ] as Array<[string, string]>,
      )
      await page.evaluate(() => {
        const workspace = window.app.workspace as unknown as { leftSplit?: { collapse?: () => void } }
        workspace.leftSplit?.collapse?.()
      })
      await openTaskChute(page)
      await expect.poll(() => rowState(taskRow(page, p(t.headings))), { timeout: 30_000 }).toBe("idle")
      // The first session-history listing reads every local session; do it before any shot.
      await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-session-history`)
      await expect(page.locator(".ai-session-history__message")).toBeVisible({ timeout: 300_000 })
      await expect(page.locator(".ai-session-history__list .ai-session-history__message")).not.toHaveText(/…|\.\.\./, { timeout: 300_000 })
      await page.locator(".ai-run-pane__sidebar-history").click()

      // 9. A comment on the running task.
      const plan = taskRow(page, p(t.plan))
      await plan.locator(".play-stop-button").click()
      await expect.poll(() => rowState(plan)).toBe("running")
      await plan.locator(".comment-button").click()
      const commentInput = page.locator(".taskchute-task-comments-popover textarea")
      await commentInput.fill(t.comment)
      await commentInput.press("Enter")
      await expect(page.locator(".taskchute-task-comments-popover .taskchute-comment-text")).toHaveCount(1)
      await shot(page, lang, "09-running-comment", [plan, page.locator(".taskchute-task-comments-popover")])
      await page.keyboard.press("Escape")

      // 10. Today's comments.
      await page.locator(".taskchute-day-comments-button").click()
      const dayWindow = page.locator(".taskchute-day-comments-window")
      await dayWindow.locator(".taskchute-day-comments-window__input textarea").fill(t.dayComment)
      await dayWindow.locator(".taskchute-day-comments-window__input textarea").press("Enter")
      await expect(dayWindow.locator(".taskchute-comment-text")).toHaveCount(1)
      await shot(page, lang, "10-day-comments", [dayWindow])
      await dayWindow.locator(".taskchute-day-comments-window__close").click()

      // 3. The ⚙ menu with "change task type".
      await taskRow(page, p(t.blog)).locator(".settings-task-button").click()
      const menu = page.locator(".task-settings-tooltip")
      await expect(menu.locator(".tooltip-item", { hasText: t.changeType })).toBeVisible()
      await shot(page, lang, "03-change-type-menu", [taskRow(page, p(t.blog)), menu])
      await page.keyboard.press("Escape")
      await page.mouse.click(5, 300)

      // 1–2. Creating an AI task.
      await page.locator(".taskchute-view-root .add-task-button").click()
      const modal = page.locator(".modal-container .modal").last()
      await modal.locator("input").first().fill(t.research)
      await modal.locator('.task-type-option[data-task-type="ai"]').click()
      await modal.locator('.ai-task-agent-card[data-ai-host="claude"]').click()
      await modal.locator(".ai-task-prompt-input").fill(t.prompt)
      await shot(page, lang, "01-create-ai-task", [modal], 0)
      await modal.locator(".ai-task-advanced > summary").click()
      await modal.locator(".ai-task-advanced").scrollIntoViewIfNeeded()
      // The working folder is this throwaway vault, whose path names the
      // person recording: blurred, not replaced.
      await modal.locator(".ai-task-cwd-input").evaluate((input: HTMLElement) => {
        input.style.filter = "blur(5px)"
      })
      await shot(page, lang, "02-create-advanced", [modal], 0)
      await modal.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit())
      await expect(modal).toHaveCount(0)
      const research = taskRow(page, p(t.research))
      await expect.poll(() => rowState(research)).toBe("idle")

      // 4. The AI pane with the real Claude Code.
      await research.locator(".play-stop-button").click()
      await expect.poll(() => rowState(research)).toBe("running")
      await page.locator(".ai-run-pane .xterm").first().waitFor()
      await expect.poll(async () => (await terminalText(page, p(t.research))).length, { timeout: 120_000 }).toBeGreaterThan(400)
      await page.waitForTimeout(12_000)
      await page.screenshot({ path: path.join(OUT, lang, "04-ai-run-pane.png") })

      // 5. Session history, searched.
      await page.evaluate((id) => window.app.commands.executeCommandById(id), `${PLUGIN_ID}:open-session-history`)
      const history = page.locator(".ai-run-pane__sidebar-history-view")
      await expect(history.locator(".ai-session-history__row").first()).toBeVisible({ timeout: 90_000 })
      await history.locator(".ai-session-history__search").fill(t.search)
      await expect(history.locator(".ai-session-history__row").first()).toBeVisible({ timeout: 60_000 })
      await shot(page, lang, "05-session-history", [page.locator(".ai-run-pane")], 0)
      await page.locator(".ai-run-pane__sidebar-history").click()

      // 7. A recipe opened from its icon.
      const headings = taskRow(page, p(t.headings))
      await headings.locator(".recipe-task-badge").click()
      const popover = page.locator(".recipe-run-popover")
      await expect(popover).toContainText(t.steps[1])
      await shot(page, lang, "07-recipe-popover", [headings, popover])
      await page.keyboard.press("Escape")

      // 8. The Obsidian link section of the AI routine.
      await headings.locator(".routine-button").click()
      const routineModal = page.locator(".modal-container .modal").last()
      const link = routineModal.locator(".obsidian-task-link-fields")
      await link.scrollIntoViewIfNeeded()
      await expect(link.locator(".obsidian-task-link-enabled")).toBeChecked()
      await shot(page, lang, "08-obsidian-link", [routineModal], 0)
      await page.keyboard.press("Escape")

      // 6. A new recipe.
      await page.locator(".drawer-toggle").first().click()
      await page.locator(".navigation-nav-item", { hasText: t.recipesNav }).first().click()
      const recipes = page.locator(".modal.recipe-modal-content")
      await recipes.getByRole("button", { name: t.newRecipe, exact: true }).click()
      await recipes.locator(".recipe-title-input").fill(t.recipe)
      await recipes.locator(".recipe-goal-input").fill(t.goal)
      await recipes.locator(".recipe-step-input").first().fill(t.steps[0])
      await shot(page, lang, "06-new-recipe", [recipes], 0)

      removeSessionsOf(vault)
    })
  })
}
