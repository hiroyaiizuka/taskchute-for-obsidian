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

describe('style regressions', () => {
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
})
