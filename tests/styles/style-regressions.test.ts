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

/**
 * Index of the last rule for `selectorStart` that paints -- one declaring
 * `background`, `color` or `cursor`. Placement-only rules (grid-area and
 * friends) cannot override the disabled styling the callers guard, so they are
 * skipped rather than counted as the last word on the selector.
 */
const lastPaintingRuleIndex = (css: string, selectorStart: string): number => {
  let found = -1
  for (let i = css.indexOf(selectorStart); i >= 0; i = css.indexOf(selectorStart, i + 1)) {
    const end = css.indexOf('}', i)
    if (end < 0) break
    if (/(?:^|\s)(?:background|color|cursor):/.test(css.slice(i, end))) {
      found = i
    }
  }

  return found
}

/** Resolves one of the `--tc-z-*` stacking tokens back to its number. */
const layerToken = (css: string, token: string): number => {
  const match = new RegExp(`^\\s*${token}:\\s*(-?\\d+);`, 'm').exec(css)
  expect(match).not.toBeNull()

  return Number((match as RegExpExecArray)[1])
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

  test('the AI pane splitter is a row-resize handle that hides while collapsed', () => {
    const css = styles()
    const resizer = readRule(css, '.ai-pane-resizer {')
    expect(resizer).toMatch(/cursor:\s*row-resize;/)
    expect(resizer).toMatch(/flex-shrink:\s*0;/)

    // A resting grip keeps the splitter discoverable, and the active states
    // stay translucent — a solid accent band is too loud at 6px.
    const grip = readRule(css, '.ai-pane-resizer::after {')
    expect(grip).toMatch(/background:\s*var\(--background-modifier-border\);/)
    const dragging = readRule(css, '.ai-pane-resizer.is-dragging {')
    expect(dragging).toMatch(/color-mix\(in srgb, var\(--interactive-accent\)/)
    expect(dragging).not.toMatch(/background:\s*var\(--interactive-accent\);/)
    // The handle sits inside the container so it inherits --visible; it must
    // still disappear when the pane is collapsed to its header row. It keeps
    // its 6px box while doing so, so the collapsed header is separated from
    // the task list by the same gap it has while expanded — `display: none`
    // would close that gap and butt the header against the last task row.
    const collapsed = readRule(css, '.ai-pane-container--collapsed .ai-pane-resizer {')
    expect(collapsed).toMatch(/visibility:\s*hidden;/)
    expect(collapsed).not.toMatch(/display:\s*none;/)
  })

  test('a drag-resized AI pane height beats the terminal share but loses to expanded', () => {
    const css = styles()
    const sized = readRule(css, '.ai-pane-container--sized {')
    expect(sized).toMatch(/height:\s*var\(--tc-ai-pane-height\);/)
    expect(sized).toMatch(/flex-basis:\s*var\(--tc-ai-pane-height\);/)

    // Same specificity throughout, so source order decides the winner.
    const terminalIndex = css.indexOf('.ai-pane-container--terminal {')
    const sizedIndex = css.indexOf('.ai-pane-container--sized {')
    const expandedIndex = css.indexOf('.ai-pane-container--expanded {')
    expect(terminalIndex).toBeLessThan(sizedIndex)
    expect(sizedIndex).toBeLessThan(expandedIndex)
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

  test('the comment button stays visible whenever it can be clicked', () => {
    const css = styles()

    // A pointer device no longer waits for row hover to reveal it, and a done
    // task without a comment is as clickable as one with a comment.
    const baseRule = readRule(css, '.comment-button {')
    expect(baseRule).toMatch(/opacity:\s*0\.6;/)

    const noCommentRule = readRule(css, '.comment-button.no-comment {')
    expect(noCommentRule).toMatch(/opacity:\s*0\.6;/)
    expect(noCommentRule).toMatch(/visibility:\s*visible;/)

    // What is not clickable is still hidden, so visible means pressable.
    const disabledRule = readRule(css, '.comment-button.disabled {')
    expect(disabledRule).toMatch(/visibility:\s*hidden;/)
  })

  test('touch devices keep the no-comment button visible over a sticky hover', () => {
    const mobileNoCommentRule = readRuleAfter(
      styles(),
      '.comment-button.no-comment,',
      '@media (hover: none)',
    )

    expect(mobileNoCommentRule).toContain('.task-item:hover .comment-button.no-comment:not(:active)')
    expect(mobileNoCommentRule).toMatch(/opacity:\s*0\.6;/)
    expect(mobileNoCommentRule).toMatch(/visibility:\s*visible;/)
    expect(mobileNoCommentRule).not.toContain('!important')

    const mobileNoCommentActiveRule = readRuleAfter(
      styles(),
      '.comment-button.no-comment:active,',
      '@media (hover: none)',
    )

    expect(mobileNoCommentActiveRule).toMatch(/opacity:\s*1;/)
    expect(mobileNoCommentActiveRule).toContain('.task-item:hover .comment-button.no-comment:active')
    expect(mobileNoCommentActiveRule).not.toContain('!important')
  })

  test('future task play button keeps disabled styling over generic play-stop styles', () => {
    const css = styles()
    // Only a rule that repaints the button can undo the disabled look, so the
    // narrow-container rules that merely place it in the grid do not count.
    const lastGenericPlayStopIndex = lastPaintingRuleIndex(css, '.play-stop-button {')
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

  test('form fields shrink to the dialog gutter instead of overflowing it', () => {
    // WebKit gives a form control an intrinsic minimum width that outranks
    // `width: 100%`, so inside the modal's padding the field grew past the
    // gutter on iOS. `time` was the last type still carrying the native
    // appearance that supplies that width.
    const fieldRule = readRule(styles(), '.form-input {');
    expect(fieldRule).toMatch(/min-width:\s*0;/);
    expect(fieldRule).toMatch(/max-width:\s*100%;/);
    expect(fieldRule).toMatch(/box-sizing:\s*border-box;/);

    const timeRule = readRule(styles(), '.form-input[type="time"] {');
    expect(timeRule).toMatch(/appearance:\s*none;/);
    expect(timeRule).toMatch(/-webkit-appearance:\s*none;/);
  });

  test('the drag grip claims the whole gesture instead of sharing it', () => {
    // `manipulation` leaves the browser free to take a vertical pan, which on
    // iOS scrolls the list out from under the grip so the pointer drag never
    // starts. The grip is deliberately absent from the shared rule below.
    const gripRule = readRule(styles(), '.drag-handle {')

    expect(gripRule).toMatch(/touch-action:\s*none;/)
    expect(gripRule).toMatch(/user-select:\s*none;/)

    const touchActionRule = readRule(styles(), '.taskchute-container button,')
    expect(touchActionRule).not.toContain('drag-handle')
  })

  test('the recipe grips claim the whole gesture too', () => {
    // The recipe checklists reorder on Pointer Events for the same reason the
    // task list does, so their grips need the same gesture ownership.
    const gripRule = readRule(styles(), '.recipe-list-drag-handle,')

    expect(gripRule).toMatch(/touch-action:\s*none;/)
    expect(gripRule).toMatch(/user-select:\s*none;/)
    expect(gripRule).toMatch(/-webkit-touch-callout:\s*none;/)
  })

  test('the recipe drop indicator is an accent line on the landing edge', () => {
    // A background wash said "something lands here" without saying where.
    // The rows are rounded, so a border or an inset shadow on the row itself
    // bends the line around the corner radius. The indicator is its own
    // zero-height element instead.
    const css = styles()
    const before = readRule(css, '.recipe-run-step--drop-before::after {')
    const after = readRule(css, '.recipe-run-step--drop-after::after {')

    for (const line of [before, after]) {
      expect(line).toMatch(/position:\s*absolute;/)
      expect(line).toMatch(/height:\s*0;/)
      expect(line).toMatch(/border-top:\s*2px solid var\(--interactive-accent\);/)
    }
    expect(before).toMatch(/top:\s*0;/)
    expect(after).toMatch(/bottom:\s*0;/)
  })

  test('the recipe reorder ghost stays out of its own hit test', () => {
    // `elementFromPoint` has to report the row underneath, not the clone that
    // is following the pointer.
    const ghostRule = readRule(styles(), '.recipe-reorder-drag-ghost {')

    expect(ghostRule).toMatch(/position:\s*fixed;/)
    expect(ghostRule).toMatch(/pointer-events:\s*none;/)
    // The run popover sits on --tc-z-popover; anything lower hides the ghost
    // behind the list it was dragged out of.
    expect(ghostRule).toMatch(/z-index:\s*var\(--tc-z-drag-ghost\);/)
    expect(layerToken(styles(), '--tc-z-drag-ghost')).toBeGreaterThan(
      layerToken(styles(), '--tc-z-popover'),
    )
  })

  test('mobile touch-action covers non-button tap targets', () => {
    const touchActionRule = readRule(styles(), '.taskchute-container button,')

    expect(touchActionRule).toContain('.taskchute-container .task-time-start.editable')
    expect(touchActionRule).toContain('.taskchute-container .task-time-stop.editable')
    expect(touchActionRule).toContain('.taskchute-container .taskchute-project-button')
    expect(touchActionRule).toContain('.taskchute-tooltip .tooltip-item')
    // Every migrated dialog carries `.taskchute-modal`, so one selector covers
    // the plugin's dialog buttons without reaching into core modals.
    expect(touchActionRule).toContain('.taskchute-modal button')
    expect(touchActionRule).toContain('[class~="drawer-toggle"]')
    expect(touchActionRule).toContain('[class~="date-nav-arrow"]')
    expect(touchActionRule).toContain('[class~="add-task-button"]')
    expect(touchActionRule).toContain('[class~="calendar-btn"]')
    expect(touchActionRule).toContain('[class~="form-button"]')
    expect(touchActionRule).toContain('[class~="taskchute-button-primary"]')
    expect(touchActionRule).toContain('[class~="taskchute-button-secondary"]')
    expect(touchActionRule).toContain('[class~="taskchute-nav-button"]')
    expect(touchActionRule).toContain('[class~="task-button"]')
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

  test('tokens built out of Obsidian variables are declared where those exist', () => {
    const css = styles()

    // Obsidian publishes `--size-*`, `--icon-*` and the theme colours on
    // `body`. A `:root` token referencing one of them resolves against nothing
    // and drops every property that uses it, silently.
    const rootBlock = readRule(css, ':root {')
    expect(rootBlock).not.toMatch(/var\(--(?:size|icon|touch|interactive|text|background|color)-/)

    const bodyBlock = readRule(css, 'body {')
    expect(bodyBlock).toContain('--tc-modal-gutter')
    expect(bodyBlock).toContain('--tc-modal-close-size')
    expect(bodyBlock).toContain('--tc-modal-close-reserve')
    expect(bodyBlock).toContain('--tc-focus-ring')
  })

  test('every dialog floats its close button on the same gutter', () => {
    const css = styles()
    const closeRule = readRule(css, '.taskchute-modal .modal-close-button {')

    expect(closeRule).toMatch(/top:\s*var\(--tc-modal-gutter\);/)
    expect(closeRule).toMatch(/inset-inline-end:\s*var\(--tc-modal-gutter\);/)
    expect(codeToken(css, '--tc-modal-gutter')).toBe('var(--size-4-4)')

    // The reserve below is only as good as the box it assumes, so the size
    // token restates core's own arithmetic (--icon-m glyph + --size-2-2
    // padding on each side) rather than guessing a literal.
    expect(codeToken(css, '--tc-modal-close-size')).toBe(
      'calc(var(--icon-m) + var(--size-2-2) * 2)',
    )
    expect(readRule(css, 'body.is-phone {')).toMatch(
      /--tc-modal-close-size:\s*var\(--touch-size-m\);/,
    )

    // No dialog moves the glyph somewhere of its own: the only other rule is
    // the shared one that hides it. Selectors start at column 0; anything
    // indented is prose in a comment.
    expect(css.match(/^\.[^\n{]*\.modal-close-button[^\n{]*\{/gm)).toEqual([
      '.taskchute-modal .modal-close-button {',
      '.taskchute-modal--no-close .modal-close-button {',
    ])
  })

  test('everything sharing the close button row reserves its corner', () => {
    const css = styles()

    expect(codeToken(css, '--tc-modal-close-reserve')).toContain(
      'var(--tc-modal-gutter) + var(--tc-modal-close-size) + var(--size-4-2)',
    )

    // Only the dialogs that still float a glyph reserve the corner; the ones
    // that hide it behind `--no-close` keep the full width.
    const reserved = [
      '.taskchute-modal:not(.taskchute-modal--no-close) .modal-title {',
      '.taskchute-log-modal .taskchute-log-header {',
      '.recipe-modal-content:not(.taskchute-modal--no-close) > .modal-header {',
      '.routine-manager__header {',
    ]

    for (const selector of reserved) {
      expect(readRule(css, selector)).toContain('var(--tc-modal-close-reserve)')
    }

    for (const selector of ['.backup-restore-header {', '.taskchute-confirm-modal .modal-header,']) {
      expect(readRule(css, selector)).not.toContain('var(--tc-modal-close-reserve)')
    }
  })

  test('dialogs with a button row of their own hide the floating close glyph', () => {
    const css = styles()

    expect(readRule(css, '.taskchute-modal--no-close .modal-close-button {')).toMatch(
      /display:\s*none;/,
    )
  })

  test('the log header restore button is sized like the rest of its control row', () => {
    const css = styles()
    const rule = readRule(css, '.refresh-button,')

    expect(rule).toContain('.taskchute-log-header .restore-button')
    expect(rule).toMatch(/font-size:\s*14px;/)
  })

  test('task names fall back to the theme accent unless the contrast fix overrides it', () => {
    const css = styles()
    const rule = readRule(css, '.task-name--accent {')

    // AccentContrastController only publishes `--tc-task-accent` when the
    // theme's accent fails against the list background; the fallback keeps
    // well-behaved themes on their own colour.
    expect(rule).toMatch(/color:\s*var\(--tc-task-accent,\s*var\(--text-accent\)\);/)
  })

  test('every dialog footer is core\'s button container, with no plugin rival left', () => {
    const css = styles()

    // The five hand-rolled action rows the dialogs used to each pick from.
    // `createModalFooter` builds `.modal-button-container` for all of them now,
    // so none of these may come back: a second container class is how the
    // phone stacking diverged between dialogs in the first place.
    expect(css).not.toContain('.form-button-group')
    expect(css).not.toContain('.confirm-button-group')
    expect(css).not.toContain('.routine-editor__buttons')
    expect(css).not.toContain('.routine-confirm__buttons')
    expect(css).not.toContain('.ai-custom-model-modal__actions')
    expect(css).not.toContain('.calendar-export-buttons')
  })

  test('the dialog footer lines up with the fields above it on a phone', () => {
    const css = styles()

    // Core pads `.is-phone .modal-button-container` by --size-4-3 on top of the
    // --size-4-4 that `.is-phone .modal-content` gives the fields, so the
    // buttons sit further in than the inputs. Only the horizontal half is
    // cancelled -- the bottom safe-area margin is core's to keep -- and the
    // rule stays scoped to the phone so it cannot outrank the per-dialog
    // footer padding a couple of dialogs use as their only gutter.
    const rule = readRule(css, 'body.is-phone .taskchute-modal .modal-button-container {')

    expect(rule).toMatch(/padding-inline:\s*0;/)
    expect(rule).not.toMatch(/padding-block/)
  })

  test('the destructive dialog button does not wear the accent', () => {
    const css = styles()
    const rule = readRule(css, '.form-button.danger {')

    // `.form-button.danger` (0,2,0) outranks core's `button.mod-warning`, so
    // this rule is the only thing standing between a delete button and looking
    // exactly like the Save button beside it.
    expect(rule).toMatch(/background:\s*var\(--background-modifier-error\);/)
    expect(rule).not.toContain('--interactive-accent')
  })

  test('form fields take their box from core so one form cannot mix two shapes', () => {
    const css = styles()
    const rule = readRule(css, '.form-input {')

    // Core styles text/number/date/select/textarea from `--input-*` with
    // attribute and element selectors (0,1,1), which outrank this class. When
    // the class restated the box it therefore won on `select` and on `time`
    // and lost everywhere else -- pill-shaped number fields beside square
    // selects. Width is all it may own now.
    expect(rule).toMatch(/width:\s*100%;/)
    expect(rule).not.toMatch(/border-radius/)
    expect(rule).not.toMatch(/padding/)
    expect(rule).not.toMatch(/background/)

    // The two fields core's own rules never reach, restated in core's tokens
    // rather than in resolved values so the phone's 44px pill reaches them.
    const time = readRule(css, '.form-input[type="time"] {')
    expect(time).toMatch(/border-radius:\s*var\(--input-radius\);/)
    expect(time).toMatch(/padding:\s*var\(--input-padding\);/)
    expect(time).toMatch(/height:\s*var\(--input-height\);/)

    const composite = readRule(css, '.form-input-icon-wrapper {')
    expect(composite).toMatch(/border-radius:\s*var\(--input-radius\);/)
    expect(composite).toMatch(/padding:\s*var\(--input-padding\);/)
  })

  test('the task row is one flex line with a symmetric gutter', () => {
    const css = styles()
    const rule = readRule(css, '.task-item {')

    // A grid reserved a track whether or not anything filled it, which is how
    // a phone ended up with a spare column to the right of the settings
    // button. Flex gives width only to what renders.
    expect(rule).toMatch(/display:\s*flex;/)
    expect(rule).not.toMatch(/grid-template/)

    // One padding for every width. Each breakpoint used to set its own
    // padding-right (12/15/16px), so the gutter changed as the pane resized.
    expect(rule).toMatch(/padding:\s*4px 8px;/)
    expect(css).not.toMatch(/\.task-item[^{]*\{[^}]*padding-right/)

    // The text column is the only part that grows, and it must be able to
    // shrink past its content or a long task name pushes the controls off.
    const main = readRule(css, '.task-item__main {')
    expect(main).toMatch(/flex:\s*1 1 auto;/)
    expect(main).toMatch(/min-width:\s*0;/)
  })

  test('the row has one responsive system, not two', () => {
    const css = styles()

    // `.taskchute-very-narrow .task-item` (0,2,0) outranked the container
    // query's `.task-item` (0,1,0) -- container queries add no specificity --
    // so the phone got the wide layout's column count with the phone
    // layout's areas, and the mismatch left an empty trailing column. The
    // width classes are gone; `@container` is the only responsive path.
    expect(css).not.toContain('.taskchute-medium')
    expect(css).not.toContain('.taskchute-narrow')
    expect(css).not.toContain('.taskchute-very-narrow')
    expect(css).not.toContain('.taskchute-wide')

    // The phone layout stacks the text column instead of naming grid areas.
    expect(css).not.toContain('grid-area: name')
    const stacked = readRuleAfter(
      css,
      '.task-item__main {',
      '@container taskchute-list (max-width: 440px)',
    )
    expect(stacked).toMatch(/flex-direction:\s*column;/)
  })

  test('the date label keeps a fixed box so the nav controls never move', () => {
    const css = styles()

    // The label holds a box wide enough for the longest date string it ever
    // shows, so neither arrow nor the calendar glyph slides as the date
    // changes -- "Today (9/2 Wed)" and "9/3 Thu" occupy the same width.
    const label = readRule(css, '.date-nav-label {')
    expect(label).toMatch(/flex:\s*0 1 150px;/)
    expect(label).toMatch(/width:\s*150px;/)
    expect(label).toMatch(/text-align:\s*center;/)

    // Below the ~338px the row needs for that box, the label is the one thing
    // allowed to give: it truncates rather than pushing an arrow off the edge.
    expect(label).toMatch(/min-width:\s*0;/)
    expect(label).toMatch(/text-overflow:\s*ellipsis;/)
    // An ellipsis does nothing to a flex container, which this used to be.
    expect(label).toMatch(/display:\s*block;/)

    // No width-keyed exception left: the phone rule that used to shrink the
    // label to its text is gone, along with the two-row header and the hidden
    // calendar glyph it belonged to.
    expect(css).not.toContain('@container taskchute-view (max-width: 380px)')
    expect(css).not.toMatch(/\.calendar-btn\s*\{[^}]*display:\s*none/)

    // The compact variant only tunes the type; anything it said about the box
    // would override the rule above on source order.
    const compact = readRule(css, '.date-nav-container.compact .date-nav-label {')
    expect(compact).not.toMatch(/width:/)
    expect(compact).not.toMatch(/flex:/)
  })

  test('the move calendar keeps its arrows and Today button compact on mobile', () => {
    const css = styles()
    const compact = readRule(
      css,
      '.taskchute-move-calendar button.taskchute-move-calendar__nav {',
    )
    // Core's mobile button box is what puffs these up; drop the height it
    // hands over and restate the padding the popover asks for.
    expect(compact).toMatch(/height:\s*auto;/)
    expect(compact).toMatch(/min-height:\s*0;/)
    expect(compact).toMatch(/padding:\s*4px 6px;/)

    // `.is-mobile button:not(.clickable-icon)` is (0,2,1), so a bare class
    // cannot win: the reset has to name the element and come later than the
    // plain rules it repeats.
    expect(compact).toMatch(/^\.taskchute-move-calendar button\./)
    expect(css.indexOf('.taskchute-move-calendar button.taskchute-move-calendar__nav {')).toBeGreaterThan(
      css.indexOf('\n.taskchute-move-calendar__nav {'),
    )

    const action = readRule(css, '.taskchute-move-calendar button.taskchute-move-calendar__action {')
    expect(action).toMatch(/height:\s*auto;/)
    expect(action).toMatch(/padding:\s*4px 6px;/)
  })

  test('an outside day reads as faint, not as a weekend', () => {
    const css = styles()
    // All four are single-class rules on the same element, so source order is
    // the whole of the cascade here: weekend, then outside, then selected.
    const sunday = css.indexOf('.taskchute-move-calendar__day.is-sunday {')
    const saturday = css.indexOf('.taskchute-move-calendar__day.is-saturday {')
    const outside = css.indexOf('.taskchute-move-calendar__day.is-outside {')
    const selected = css.indexOf('.taskchute-move-calendar__day.is-selected {')
    expect(outside).toBeGreaterThan(sunday)
    expect(outside).toBeGreaterThan(saturday)
    expect(selected).toBeGreaterThan(outside)
  })

  test('every move calendar button is a 44px touch target on a phone', () => {
    const css = styles()
    // Core's `.is-mobile button:not(.clickable-icon)` is (0,2,1), so each of
    // these has to name the element to win.
    const nav = readRule(css, '.is-mobile .taskchute-move-calendar button.taskchute-move-calendar__nav {')
    expect(nav).toMatch(/width:\s*44px;/)
    expect(nav).toMatch(/height:\s*44px;/)

    const action = readRule(css, '.is-mobile .taskchute-move-calendar button.taskchute-move-calendar__action {')
    expect(action).toMatch(/height:\s*44px;/)

    const day = readRule(css, '.is-mobile .taskchute-move-calendar button.taskchute-move-calendar__day {')
    expect(day).toMatch(/height:\s*44px;/)

    // Core also pads day cells to `4px var(--size-4-5)`, which widens each one
    // to 55px and pushes the seven-column grid past the sheet.
    const dayBox = readRule(css, '.taskchute-move-calendar button.taskchute-move-calendar__day {')
    expect(dayBox).toMatch(/padding:\s*6px 0;/)

    // Seven 44px cells plus the 4px gaps and the popover's own padding: the
    // cap has to leave the grid room, or the days shrink below the target.
    expect(7 * 44 + 6 * 4 + 2 * 12).toBeLessThanOrEqual(360)
  })

  test('the move calendar fills the phone screen up to a cap', () => {
    const css = styles()
    const mobile = readRule(css, '.is-mobile .taskchute-move-calendar {')
    // Wider than the 260px desktop popover, but never wider than the screen
    // minus its margins -- and capped so a tablet keeps a sane month.
    expect(mobile).toMatch(/width:\s*min\(calc\(100vw - 32px\), 360px\);/)
    expect(mobile).toMatch(/max-width:\s*calc\(100vw - 32px\);/)
    expect(css.indexOf('.is-mobile .taskchute-move-calendar {')).toBeGreaterThan(
      css.indexOf('\n.taskchute-move-calendar {'),
    )
  })
})
