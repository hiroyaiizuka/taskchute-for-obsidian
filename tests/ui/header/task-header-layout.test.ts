import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../../..')

function readRule(css: string, selector: string, fromIndex = 0): string {
  const start = css.indexOf(selector, fromIndex)
  expect(start).toBeGreaterThanOrEqual(0)

  const end = css.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end + 1)
}

describe('TaskChute header layout', () => {
  test('date navigation stays centred independently of unequal side controls', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    const topBar = readRule(css, '.top-bar-container {')
    const drawer = readRule(css, '.drawer-toggle {')
    const dateNavigation = readRule(
      css,
      '.date-nav-container.compact {',
      css.indexOf('.date-nav-container {'),
    )
    const actions = readRule(css, '.header-action-section {')

    expect(topBar).toMatch(/display:\s*grid;/)
    expect(topBar).toMatch(
      /grid-template-columns:\s*minmax\(min-content,\s*1fr\)\s+auto\s+minmax\(min-content,\s*1fr\);/,
    )
    expect(drawer).toMatch(/grid-column:\s*1;/)
    expect(drawer).toMatch(/justify-self:\s*start;/)
    expect(dateNavigation).toMatch(/grid-column:\s*2;/)
    expect(dateNavigation).toMatch(/justify-self:\s*center;/)
    expect(actions).toMatch(/grid-column:\s*3;/)
    expect(actions).toMatch(/justify-self:\s*end;/)
  })

  test('outer tracks never shrink below the controls they hold', () => {
    // A zero floor lets the action track become narrower than the switch and
    // add button it holds. They are `justify-self: end`, so the overflow runs
    // leftwards and hides the date navigator's next-day arrow.
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    const topBar = readRule(css, '.top-bar-container {')

    expect(topBar).not.toMatch(/grid-template-columns:[^;]*minmax\(0,/)
  })

  test('narrow split drops only the filter to a second row', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    const viewRoot = readRule(css, '.taskchute-view-root {')
    const queryStart = css.indexOf('@container taskchute-view (max-width: 680px)')

    expect(viewRoot).toMatch(/container-type:\s*inline-size;/)
    expect(viewRoot).toMatch(/container-name:\s*taskchute-view;/)
    expect(viewRoot).toMatch(/display:\s*flex;/)
    expect(viewRoot).toMatch(/flex-direction:\s*column;/)
    expect(queryStart).toBeGreaterThanOrEqual(0)

    const query = css.slice(queryStart, css.indexOf('/* Navigation Overlay */', queryStart))
    expect(query).toMatch(
      /\.top-bar-container\.has-board-view-switch\s*\{[\s\S]*grid-template-rows:\s*repeat\(2,\s*30px\);/,
    )
    expect(query).toMatch(/\.date-nav-container\.compact\s*\{[\s\S]*grid-row:\s*1;/)
    expect(query).toMatch(
      /\.top-bar-container\s*>\s*\.drawer-toggle\s*\{[\s\S]*grid-column:\s*1;[\s\S]*grid-row:\s*1;/,
    )
    // The section holds the filter and the add action in one flex box, so it
    // has to dissolve before the grid can put them on different rows.
    expect(query).toMatch(
      /\.header-action-section\.has-board-view-switch\s*\{[\s\S]*display:\s*contents;/,
    )
    expect(query).toMatch(
      /\.add-task-button\.repositioned\s*\{[\s\S]*grid-column:\s*3;[\s\S]*grid-row:\s*1;[\s\S]*justify-self:\s*end;/,
    )
    expect(query).toMatch(
      /\.ai-board-view-switch\s*\{[\s\S]*grid-row:\s*2;[\s\S]*justify-self:\s*end;/,
    )
    // The add action riding down with the filter is the regression this
    // layout exists to prevent.
    expect(query).not.toMatch(
      /\.add-task-button\.repositioned\s*\{[^}]*grid-row:\s*2/,
    )
  })

  test('board view control uses a muted segmented frame and active outline', () => {
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    const sectionStart = css.indexOf('AI Task - board view switch')
    const group = readRule(css, '.ai-board-view-switch {', sectionStart)
    const segment = readRule(
      css,
      '.ai-board-view-switch__segment {',
      sectionStart,
    )
    const active = readRule(
      css,
      '.ai-board-view-switch__segment.is-active {',
      sectionStart,
    )
    const separator = readRule(
      css,
      '.ai-board-view-switch__segment + .ai-board-view-switch__segment {',
      sectionStart,
    )
    const firstSegment = readRule(
      css,
      '.ai-board-view-switch__segment:first-child {',
      sectionStart,
    )
    const lastSegment = readRule(
      css,
      '.ai-board-view-switch__segment:last-child {',
      sectionStart,
    )
    const activeFrame = readRule(
      css,
      '.ai-board-view-switch__segment.is-active::after {',
      sectionStart,
    )
    const firstActiveFrame = readRule(
      css,
      '.ai-board-view-switch__segment.is-active:first-child::after {',
      sectionStart,
    )
    const lastActiveFrame = readRule(
      css,
      '.ai-board-view-switch__segment.is-active:last-child::after {',
      sectionStart,
    )
    const focus = readRule(
      css,
      '.ai-board-view-switch__segment:focus-visible {',
      sectionStart,
    )

    expect(group).toMatch(
      /border:\s*1px\s+solid\s+var\(--ai-board-view-border\);/,
    )
    expect(group).toMatch(
      /--ai-board-view-border:\s*var\(--background-modifier-border\);/,
    )
    expect(group).toMatch(/border-radius:\s*7px;/)
    expect(group).toMatch(/background:\s*color-mix\(/)
    expect(segment).toMatch(/border:\s*none;/)
    expect(segment).toMatch(/height:\s*28px;/)
    expect(segment).toMatch(/box-sizing:\s*border-box;/)
    expect(separator).toMatch(
      /border-left:\s*1px\s+solid\s+var\(--ai-board-view-border\);/,
    )
    expect(firstSegment).toMatch(/border-radius:\s*6px\s+0\s+0\s+6px;/)
    expect(lastSegment).toMatch(/border-radius:\s*0\s+6px\s+6px\s+0;/)
    expect(active).toMatch(/background:\s*color-mix\(/)
    expect(active).toMatch(/box-shadow:\s*none;/)
    expect(active).toMatch(/z-index:\s*1;/)
    expect(activeFrame).toMatch(
      /border:\s*1px\s+solid\s+var\(--ai-board-view-active-border\);/,
    )
    expect(activeFrame).toMatch(/border-radius:\s*0;/)
    expect(firstActiveFrame).toMatch(
      /border-radius:\s*5px\s+0\s+0\s+5px;/,
    )
    expect(lastActiveFrame).toMatch(
      /border-radius:\s*0\s+5px\s+5px\s+0;/,
    )
    expect(focus).toMatch(/outline:\s*2px\s+solid/)
  })
})
