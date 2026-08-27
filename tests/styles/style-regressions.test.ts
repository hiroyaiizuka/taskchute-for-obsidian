import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const styles = () => fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')

const readRule = (css: string, selectorStart: string): string => {
  const start = css.indexOf(selectorStart)
  expect(start).toBeGreaterThanOrEqual(0)

  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)

  return css.slice(start, end + 1)
}

const readRuleAfter = (css: string, selectorStart: string, after: string): string => {
  const afterIndex = css.indexOf(after)
  expect(afterIndex).toBeGreaterThanOrEqual(0)

  const start = css.indexOf(selectorStart, afterIndex)
  expect(start).toBeGreaterThan(afterIndex)

  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)

  return css.slice(start, end + 1)
}

const readRuleAtOrAfter = (css: string, selectorStart: string, afterIndex: number): string => {
  const start = css.indexOf(selectorStart, afterIndex)
  expect(start).toBeGreaterThanOrEqual(afterIndex)

  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)

  return css.slice(start, end + 1)
}

/**
 * The AI pane's terminal/editor surface keeps a fixed dark palette in both
 * themes, declared as `--tc-code-*` custom properties on `.ai-run-pane`.
 * Resolve a token back to its literal so the assertions below still pin the
 * concrete reference colour rather than just the token name.
 */
const codeToken = (css: string, token: string): string => {
  const match = new RegExp(`^\\s*${token}:\\s*([^;]+);`, 'm').exec(css)
  expect(match).not.toBeNull()

  return (match as RegExpExecArray)[1].trim()
}

describe('style regressions', () => {
  test('AI runs participates in vertical layout so the task list remains scrollable', () => {
    const css = styles()
    const main = readRule(css, '.main-container {')
    expect(main).toMatch(/flex-direction:\s*column;/)
    expect(main).toMatch(/min-height:\s*0;/)

    const taskList = readRule(css, '.task-list-container {')
    expect(taskList).toMatch(/min-height:\s*0;/)
    expect(taskList).toMatch(/overflow-y:\s*auto;/)

    const pane = readRule(css, '.ai-pane-container {')
    expect(pane).not.toMatch(/position:\s*absolute;/)
    expect(pane).toMatch(/flex-shrink:\s*0;/)
    expect(pane).toMatch(/display:\s*none;/)

    const visiblePane = readRule(css, '.ai-pane-container--visible {')
    expect(visiblePane).toMatch(/display:\s*flex;/)
  })

  test('AI terminal close controls reveal on hover/focus and remain usable on touch', () => {
    const css = styles()
    const runClose = readRule(css, '.ai-run-pane__run-close {')
    const tabClose = readRule(css, '.ai-run-pane__work-tab-close {')
    expect(runClose).toMatch(/opacity:\s*0;/)
    expect(runClose).toMatch(/pointer-events:\s*none;/)
    expect(tabClose).toMatch(/opacity:\s*0;/)
    expect(tabClose).toMatch(/pointer-events:\s*none;/)
    expect(css).toContain('.ai-run-pane__run:hover .ai-run-pane__run-close,')
    expect(css).toContain(
      '.ai-run-pane__work-tab:hover .ai-run-pane__work-tab-close',
    )
    expect(css).toContain(
      '.ai-run-pane__work-tab-close:is(:hover, :focus-visible)',
    )
    expect(css).toContain('@media (hover: none)')
  })

  test('AI terminal add button is a plain icon without chrome', () => {
    const css = styles()
    const rule = readRule(css, '.ai-run-pane__expand,')
    expect(rule).toMatch(/border:\s*none;/)
    expect(rule).toMatch(/background:\s*none;/)
    expect(rule).toMatch(/box-shadow:\s*none;/)
    const add = readRule(css, '.ai-run-pane__add {')
    expect(add).toMatch(/border:\s*none;/)
    expect(add).toMatch(/background:\s*none;/)
    expect(add).toMatch(/box-shadow:\s*none;/)
    expect(add).toMatch(/font-size:\s*14px;/)
    expect(add).toMatch(/line-height:\s*20px;/)
    const override = readRule(css, '.ai-run-pane button.ai-run-pane__split,')
    expect(override).toContain('.ai-run-pane button.ai-run-pane__add')
    expect(override).toMatch(/background-color:\s*transparent;/)
    expect(override).toMatch(/border-radius:\s*0;/)
    expect(override).toMatch(/min-height:\s*0;/)
    expect(override).toMatch(
      /line-height:\s*var\(--ai-run-control-line-height, 16px\);/,
    )
    const splitIcon = readRule(
      css,
      '.ai-run-pane button.ai-run-pane__split svg {',
    )
    expect(splitIcon).toMatch(/width:\s*14px;/)
    expect(splitIcon).toMatch(/height:\s*14px;/)
    const expand = readRule(css, '.ai-run-pane button.ai-run-pane__expand {')
    expect(expand).toMatch(/min-height:\s*0;/)
    expect(expand).toMatch(/background-color:\s*transparent;/)
  })

  test('Obsidian-linked AI task icon keeps space from the task title', () => {
    const linkIcon = readRule(styles(), '.ai-task-obsidian-link-icon {')

    expect(linkIcon).toMatch(/padding-left:\s*5px;/)
  })

  test('AI task automatic reasoning keeps the budget field visually hidden', () => {
    const hiddenBudget = readRule(
      styles(),
      '.ai-task-reasoning-budget-field.hidden {',
    )

    expect(hiddenBudget).toMatch(/display:\s*none;/)
  })

  test('AI task dropdowns stay scrollable and directory rows keep compact two-line spacing', () => {
    const css = styles()
    const directoryMenu = readRule(css, '.ai-working-directory-select__menu {')
    const directoryUpward = readRule(
      css,
      '.ai-working-directory-select__menu.is-open-upward {',
    )
    const directoryOption = readRule(
      css,
      '.ai-working-directory-select__option {',
    )
    const separator = readRule(css, '.ai-working-directory-select__separator {')
    const recentHeader = readRule(
      css,
      '.ai-working-directory-select__recent-header {',
    )
    const hiddenReset = readRule(
      css,
      '.ai-working-directory-select__reset.is-hidden {',
    )
    const modelMenu = readRule(css, '.ai-model-select__menu {')
    const modelUpward = readRule(css, '.ai-model-select__menu.is-open-upward {')

    expect(directoryMenu).toMatch(/top:\s*calc\(100% \+ 4px\);/)
    expect(directoryMenu).toMatch(/overflow-y:\s*auto;/)
    expect(directoryMenu).toMatch(/overscroll-behavior:\s*contain;/)
    expect(directoryUpward).toMatch(/top:\s*auto;/)
    expect(directoryUpward).toMatch(/bottom:\s*calc\(100% \+ 4px\);/)
    expect(directoryOption).toMatch(/height:\s*auto;/)
    expect(directoryOption).toMatch(/min-height:\s*48px;/)
    expect(directoryOption).toMatch(/line-height:\s*1\.25;/)
    expect(separator).toMatch(/margin:\s*0 3px;/)
    expect(recentHeader).toMatch(/padding:\s*6px 8px;/)
    expect(recentHeader).toMatch(/line-height:\s*1\.2;/)
    expect(hiddenReset).toMatch(/display:\s*none;/)

    expect(modelMenu).toMatch(/overflow-y:\s*auto;/)
    expect(modelMenu).toMatch(/overscroll-behavior:\s*contain;/)
    expect(modelUpward).toMatch(/top:\s*auto;/)
    expect(modelUpward).toMatch(/bottom:\s*calc\(100% \+ 4px\);/)
  })

  test('AI terminal expanded and xterm surfaces fill the available area', () => {
    const css = styles()
    const expanded = readRule(css, '.ai-pane-container--expanded {')
    expect(expanded).toMatch(/height:\s*100%;/)
    expect(expanded).toMatch(/max-height:\s*100%;/)
    const terminalBody = readRule(css, '.ai-run-pane__body--terminal {')
    expect(terminalBody).toMatch(/background:\s*var\(--tc-code-surface\);/)
    expect(codeToken(css, '--tc-code-surface')).toBe('#1e1e1e')
    const xterm = readRule(css, '.ai-run-pane__body--terminal .xterm {')
    expect(xterm).toMatch(/box-sizing:\s*border-box;/)
  })

  test('AI workspace editor divides the work area evenly and fills its CM6 surface', () => {
    const css = styles()
    const workarea = readRule(css, '.ai-run-pane__workarea {')
    expect(workarea).toMatch(/display:\s*flex;/)
    expect(workarea).toMatch(/min-height:\s*0;/)

    const split = readRule(css, '.ai-run-pane.has-file-panel .ai-run-pane__panels {')
    expect(split).toMatch(/flex:\s*1 1 50%;/)
    expect(split).toMatch(/width:\s*50%;/)
    const filePanel = readRule(css, '.ai-run-pane__file-panel-container {')
    expect(filePanel).toMatch(/flex:\s*1 1 50%;/)
    expect(filePanel).toMatch(/width:\s*50%;/)

    const editor = readRule(css, '.ai-run-pane__file-editor {')
    expect(editor).toMatch(/flex:\s*1;/)
    expect(editor).toMatch(/min-height:\s*0;/)
  })

  test('AI terminal and workspace file tabs share the compact reference chrome', () => {
    const css = styles()
    const bar = readRule(css, '.ai-run-pane__work-tabbar {')
    const tab = readRule(css, '.ai-run-pane__work-tab {')
    const active = readRule(css, '.ai-run-pane__work-tab.is-active {')
    const close = readRule(css, '.ai-run-pane__work-tab-close {')

    expect(bar).toMatch(/min-height:\s*25px;/)
    expect(bar).not.toMatch(/(?:^|\n)\s*height:\s*25px;/)
    expect(bar).toMatch(/padding:\s*0;/)
    expect(bar).toMatch(/background:\s*var\(--tc-code-tabbar-bg\);/)
    expect(codeToken(css, '--tc-code-tabbar-bg')).toBe('#1a2332')
    expect(bar).toMatch(/border-bottom:\s*1px solid var\(--tc-code-border\);/)
    expect(codeToken(css, '--tc-code-border')).toBe('#374151')
    expect(tab).toMatch(/gap:\s*4px;/)
    expect(tab).toMatch(/padding:\s*2px 8px;/)
    expect(tab).toMatch(/border-radius:\s*0;/)
    expect(tab).toMatch(/font-family:\s*var\(--font-monospace\);/)
    expect(tab).toMatch(/font-size:\s*12px;/)
    expect(tab).toMatch(/line-height:\s*16px;/)
    expect(active).toMatch(/background:\s*var\(--tc-code-tab-active-bg\);/)
    expect(codeToken(css, '--tc-code-tab-active-bg')).toBe('#111827')
    expect(active).toMatch(/color:\s*var\(--tc-code-text-strong\);/)
    expect(codeToken(css, '--tc-code-text-strong')).toBe('#e5e7eb')
    const separator = readRule(css, '.ai-run-pane__work-tab::after {')
    expect(separator).toMatch(/width:\s*1px;/)
    expect(separator).toMatch(/background:\s*var\(--tc-code-border\);/)
    // The content-tab status dot is the same CSS circle the sidebar rows use
    // (declared once on `.ai-run-pane__tab-dot, .ai-run-pane__run-dot`); the
    // tab strip only opts out of the pulse so it stays calmer.
    const sharedDot = readRule(
      css,
      '.ai-run-pane__tab-dot,\n.ai-run-pane__run-dot {',
    )
    expect(sharedDot).toMatch(/border-radius:\s*50%;/)
    expect(sharedDot).toMatch(/width:\s*8px;/)
    const terminalDot = readRule(
      css,
      '.ai-run-pane__work-tab .ai-run-pane__tab-dot {',
    )
    expect(terminalDot).toMatch(/animation:\s*none;/)
    expect(close).toMatch(/opacity:\s*0;/)
    expect(close).toMatch(/pointer-events:\s*none;/)
    expect(close).toMatch(/cursor:\s*pointer;/)
    expect(close).toMatch(
      /transition:\s*opacity 150ms cubic-bezier\(0\.4, 0, 0\.2, 1\);/,
    )
    expect(css).toContain(
      '.ai-run-pane__work-tab:hover .ai-run-pane__work-tab-close {',
    )
    expect(css).toContain(
      '.ai-run-pane__work-tab-close:is(:hover, :focus-visible)',
    )
    expect(css).not.toContain('.ai-run-pane__work-tab:focus-within')
  })

  test('AI file tabs have no nested native selection button chrome', () => {
    const css = styles()
    expect(css).not.toContain('.ai-run-pane__file-tab-select')
  })

  test('routine edit frequency sections stay hidden when is-hidden is applied', () => {
    const css = styles()
    const routineDisplayRuleIndex = css.indexOf('.routine-form__weekly,\n.routine-form__monthly')
    const routineHiddenRuleIndex = css.indexOf('.routine-form__weekly.is-hidden')

    expect(routineDisplayRuleIndex).toBeGreaterThanOrEqual(0)
    expect(routineHiddenRuleIndex).toBeGreaterThan(routineDisplayRuleIndex)

    const hiddenRule = readRule(css, '.routine-form__weekly.is-hidden')

    expect(hiddenRule).toContain('.routine-form__monthly.is-hidden')
    expect(hiddenRule).toContain('.routine-form__monthly-date.is-hidden')
    expect(hiddenRule).toContain('.routine-monthly-date-group.is-hidden')
    expect(hiddenRule).toMatch(/display:\s*none;/)
  })

  test('routine edit monthly heading stays hidden over generic form labels', () => {
    const css = styles()
    const lastFormLabelRuleIndex = css.lastIndexOf('.form-label {')
    expect(lastFormLabelRuleIndex).toBeGreaterThanOrEqual(0)

    const hiddenRule = readRuleAtOrAfter(
      css,
      '.routine-form__weekly.is-hidden',
      lastFormLabelRuleIndex,
    )

    expect(hiddenRule).toContain('.routine-monthly-group__heading.is-hidden')
    expect(hiddenRule).toMatch(/display:\s*none;/)
  })

  test('heatmap weekday labels keep the same row gap as heatmap cells', () => {
    const weekdayRule = readRule(styles(), '.heatmap-weekdays {')

    expect(weekdayRule).toMatch(/row-gap:\s*var\(--heatmap-week-gap\);/)
  })

  test('touch devices keep the no-comment button override stronger than hover', () => {
    const mobileNoCommentRule = readRuleAfter(
      styles(),
      '.comment-button.no-comment,',
      '@media (hover: none)',
    )

    expect(mobileNoCommentRule).toContain('.task-item:hover .comment-button.no-comment:not(:active)')
    expect(mobileNoCommentRule).toMatch(/opacity:\s*0;/)
    expect(mobileNoCommentRule).toMatch(/visibility:\s*visible;/)
    expect(mobileNoCommentRule).not.toContain('!important')

    const mobileNoCommentActiveRule = readRuleAfter(
      styles(),
      '.comment-button.no-comment:active,',
      '@media (hover: none)',
    )

    expect(mobileNoCommentActiveRule).toMatch(/opacity:\s*0\.8;/)
    expect(mobileNoCommentActiveRule).toContain('.task-item:hover .comment-button.no-comment:active')
    expect(mobileNoCommentActiveRule).not.toContain('!important')
  })

  test('future task play button keeps disabled styling over generic play-stop styles', () => {
    const css = styles()
    const lastGenericPlayStopIndex = css.lastIndexOf('.play-stop-button {')
    expect(lastGenericPlayStopIndex).toBeGreaterThanOrEqual(0)

    const futurePlayStopRule = readRuleAtOrAfter(
      css,
      '.play-stop-button.future-task-button {',
      lastGenericPlayStopIndex,
    )

    expect(futurePlayStopRule).toMatch(/background:\s*var\(--background-modifier-border\);/)
    expect(futurePlayStopRule).toMatch(/color:\s*transparent;/)
    expect(futurePlayStopRule).toMatch(/cursor:\s*not-allowed;/)
  })

  test('direct hover feedback stays stronger than row hover for task controls', () => {
    const css = styles()
    const rowDragRuleIndex = css.indexOf('.task-item:hover .drag-handle {')
    const rowCommentRuleIndex = css.indexOf('.task-item:hover .comment-button:not(.disabled) {')
    expect(rowDragRuleIndex).toBeGreaterThanOrEqual(0)
    expect(rowCommentRuleIndex).toBeGreaterThanOrEqual(0)

    const dragHoverRule = readRuleAtOrAfter(
      css,
      '.task-item:hover .drag-handle:hover {',
      rowDragRuleIndex,
    )
    const commentHoverRule = readRuleAtOrAfter(
      css,
      '.task-item:hover .comment-button:not(.disabled):hover {',
      rowCommentRuleIndex,
    )

    expect(dragHoverRule).toMatch(/opacity:\s*1;/)
    expect(commentHoverRule).toMatch(/opacity:\s*1;/)
  })

  test('recipe step handle direct hover stays stronger than recipe row hover', () => {
    const css = styles()
    const rowHoverRuleIndex = css.indexOf('.recipe-step-row:hover .recipe-step-drag-handle,')
    expect(rowHoverRuleIndex).toBeGreaterThanOrEqual(0)

    const recipeHandleHoverRule = readRuleAtOrAfter(
      css,
      '.recipe-step-row:hover .recipe-step-drag-handle:hover,',
      rowHoverRuleIndex,
    )

    expect(recipeHandleHoverRule).toContain('.recipe-run-step:hover .recipe-step-drag-handle:hover')
    expect(recipeHandleHoverRule).toMatch(/opacity:\s*1;/)
  })

  test('touch devices explicitly suppress sticky row hover for hidden controls', () => {
    const css = styles()
    const mobileMediaIndex = css.indexOf('@media (hover: none)')
    expect(mobileMediaIndex).toBeGreaterThanOrEqual(0)

    const mobileHoverTimeRule = readRuleAtOrAfter(
      css,
      '.task-item:hover .task-time-range.time-hidden:not(:active),',
      mobileMediaIndex,
    )
    const mobileHoverDragRule = readRuleAtOrAfter(
      css,
      '.task-item:hover .drag-handle:not(.disabled):not(:active) {',
      mobileMediaIndex,
    )
    const mobileHoverDisabledDragRule = readRuleAtOrAfter(
      css,
      '.task-item:hover .drag-handle.disabled {',
      mobileMediaIndex,
    )

    expect(mobileHoverTimeRule).toMatch(/opacity:\s*0;/)
    expect(mobileHoverDragRule).toMatch(/opacity:\s*0;/)
    expect(mobileHoverDisabledDragRule).toMatch(/opacity:\s*0;/)
  })

  test('touch devices suppress sticky hover for routine and settings buttons', () => {
    const css = styles()
    const mobileMediaIndex = css.indexOf('@media (hover: none)')
    expect(mobileMediaIndex).toBeGreaterThanOrEqual(0)

    const routineHoverRule = readRuleAtOrAfter(
      css,
      '.routine-button:hover:not(:active):not(.active),',
      mobileMediaIndex,
    )

    expect(routineHoverRule).toContain('.settings-task-button:hover:not(:active)')
    expect(routineHoverRule).toMatch(/opacity:\s*0\.6;/)
    expect(routineHoverRule).toMatch(/background:\s*transparent;/)
  })

  test('closed navigation panel stays out of the focus tree', () => {
    const hiddenPanelRule = readRule(styles(), '.navigation-panel-hidden {')

    expect(hiddenPanelRule).toMatch(/display:\s*none;/)
  })

  test('project board drop indicators keep pseudo-elements outside :is selectors', () => {
    const css = styles()

    expect(css).not.toMatch(/:is\([^{}]*::(?:before|after)[^{}]*\)\s*\{/)
  })

  test('mobile touch-action covers non-button tap targets', () => {
    const touchActionRule = readRule(styles(), '.taskchute-container button,')

    expect(touchActionRule).toContain('.taskchute-container .task-time-start.editable')
    expect(touchActionRule).toContain('.taskchute-container .task-time-stop.editable')
    expect(touchActionRule).toContain('.taskchute-container .drag-handle')
    expect(touchActionRule).toContain('.taskchute-container .taskchute-project-button')
    expect(touchActionRule).toContain('.taskchute-tooltip .tooltip-item')
    expect(touchActionRule).toContain('.taskchute-comment-modal button')
    expect(touchActionRule).toContain('[class~="drawer-toggle"]')
    expect(touchActionRule).toContain('[class~="date-nav-arrow"]')
    expect(touchActionRule).toContain('[class~="add-task-button"]')
    expect(touchActionRule).toContain('[class~="calendar-btn"]')
    expect(touchActionRule).toContain('[class~="form-button"]')
    expect(touchActionRule).toContain('[class~="taskchute-button-save"]')
    expect(touchActionRule).toContain('[class~="taskchute-button-cancel"]')
    expect(touchActionRule).toContain('[class~="taskchute-button-primary"]')
    expect(touchActionRule).toContain('[class~="taskchute-button-secondary"]')
    expect(touchActionRule).toContain('[class~="taskchute-nav-button"]')
    expect(touchActionRule).toContain('[class~="task-button"]')
    expect(touchActionRule).toContain('[class~="tooltip-close-button"]')
    expect(touchActionRule).toContain('[class~="modal-close-button"]')
    expect(touchActionRule).toMatch(/touch-action:\s*manipulation;/)
  })

  test('mobile task list reserves space above Obsidian bottom controls', () => {
    const css = styles()
    const mobileTaskListRule = readRule(css, '.is-mobile .task-list {')

    expect(css).toContain('--taskchute-mobile-bottom-obstruction')
    expect(mobileTaskListRule).toMatch(
      /padding-bottom:\s*var\(--taskchute-mobile-bottom-obstruction\);/,
    )
    expect(mobileTaskListRule).toMatch(
      /scroll-padding-bottom:\s*var\(--taskchute-mobile-bottom-obstruction\);/,
    )
  })

  test('mobile navigation reserves top and bottom safe areas', () => {
    const navigationRule = readRule(styles(), '.is-mobile .navigation-nav {')

    expect(navigationRule).toMatch(
      /padding-top:\s*var\(--taskchute-mobile-top-obstruction\);/,
    )
    expect(navigationRule).toMatch(
      /padding-bottom:\s*var\(--taskchute-mobile-bottom-obstruction\);/,
    )
  })

  test('mobile project board uses page scrolling with bottom clearance', () => {
    const css = styles()
    const viewRule = readRule(css, '.is-mobile .project-board-view {')
    const bodyRule = readRule(css, '.is-mobile .project-board-view__body {')
    const columnsRule = readRule(css, '.is-mobile .project-board-columns {')
    const cardsRule = readRule(css, '.is-mobile .project-board-column__cards {')

    expect(viewRule).toMatch(/overflow-y:\s*auto;/)
    expect(viewRule).toMatch(
      /padding-bottom:\s*var\(--taskchute-mobile-bottom-obstruction\);/,
    )
    expect(bodyRule).toMatch(/overflow:\s*visible;/)
    expect(columnsRule).toMatch(/grid-template-columns:\s*1fr;/)
    expect(cardsRule).toMatch(/overflow:\s*visible;/)
  })
})
