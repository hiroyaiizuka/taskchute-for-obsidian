import NavigationRoutineRenderer, { RoutineTaskWithFile } from '../../../src/ui/navigation/NavigationRoutineRenderer'

function createTranslator(): (key: string, fallback: string, vars?: Record<string, string | number>) => string {
  return (_key, fallback, vars) => {
    if (!vars) return fallback
    return fallback.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = vars[name]
      return value !== undefined ? String(value) : `{${name}}`
    })
  }
}

describe('NavigationRoutineRenderer', () => {
  const getWeekdayNames = () => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  function createTask(overrides: Partial<RoutineTaskWithFile> = {}): RoutineTaskWithFile {
    return {
      title: 'Daily stretch',
      displayTitle: 'Daily stretch',
      name: 'Daily stretch',
      path: 'TASKS/stretch.md',
      file: {} as unknown as RoutineTaskWithFile['file'],
      frontmatter: {},
      isRoutine: true,
      scheduledTime: undefined,
      routine_type: 'daily',
      routine_interval: 1,
      routine_enabled: true,
      weekdays: undefined,
      weekday: undefined,
      monthly_week: undefined,
      monthly_weekday: undefined,
      routine_week: undefined,
      routine_weekday: undefined,
      routine_weeks: undefined,
      routine_weekdays: undefined,
      projectPath: undefined,
      projectTitle: undefined,
      ...overrides,
    }
  }

  it('renders routine row with title, badge, toggle, and edit button', () => {
    const renderer = new NavigationRoutineRenderer(
      { tv: createTranslator(), getWeekdayNames },
      {
        onToggle: jest.fn(),
        onEdit: jest.fn(),
      },
    )

    const task = createTask({ displayTitle: 'Weekly planning', routine_type: 'weekly', routine_interval: 2, routine_weekday: 2 })
    const row = renderer.createRow(task)

    const title = row.querySelector('.routine-title')
    const badge = row.querySelector('.routine-type-badge')
    const toggle = row.querySelector<HTMLInputElement>('.routine-enabled-toggle input[type="checkbox"]')
    const edit = row.querySelector<HTMLButtonElement>('.routine-edit-btn')

    expect(title?.textContent).toBe('Weekly planning')
    expect(badge?.textContent).toBe('Every 2 week(s) on Tue')
    expect(toggle?.checked).toBe(true)
    expect(edit?.textContent).toBe('Edit')
  })

  it('renders multiple weekdays for weekly routines', () => {
    const renderer = new NavigationRoutineRenderer(
      { tv: createTranslator(), getWeekdayNames },
      {
        onToggle: jest.fn(),
        onEdit: jest.fn(),
      },
    )

    const task = createTask({
      routine_type: 'weekly',
      routine_interval: 1,
      weekdays: [1, 3, 5],
    })

    const row = renderer.createRow(task)
    const badge = row.querySelector('.routine-type-badge')

    expect(badge?.textContent).toBe('Every 1 week(s) on Mon / Wed / Fri')
  })

  it('renders multiple weeks and weekdays for monthly routines', () => {
    const renderer = new NavigationRoutineRenderer(
      { tv: createTranslator(), getWeekdayNames },
      {
        onToggle: jest.fn(),
        onEdit: jest.fn(),
      },
    )

    const task = createTask({
      routine_type: 'monthly',
      routine_interval: 1,
      routine_weeks: [1, 3, 'last'],
      routine_weekdays: [1, 5],
    })

    const row = renderer.createRow(task)
    const badge = row.querySelector('.routine-type-badge')

    expect(badge?.textContent).toBe('Every Week 1 / Week 3 / Last on Mon / Fri')
  })

  it('invokes callbacks when toggling and editing, updating badge label', async () => {
    const onToggle = jest.fn(async (task: RoutineTaskWithFile, enabled: boolean) => {
      task.routine_type = 'monthly'
      task.routine_interval = 1
      task.monthly_week = 1
      task.monthly_weekday = 4
      task.routine_weekday = 4
      task.routine_enabled = enabled
    })
    const onEdit = jest.fn()

    const renderer = new NavigationRoutineRenderer(
      { tv: createTranslator(), getWeekdayNames },
      { onToggle, onEdit },
    )

    const task = createTask({ routine_type: 'weekly', routine_weekday: 1 })
    const row = renderer.createRow(task)

    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const badge = row.querySelector<HTMLElement>('.routine-type-badge')
    const edit = row.querySelector<HTMLButtonElement>('.routine-edit-btn')

    expect(toggle).not.toBeNull()
    expect(badge).not.toBeNull()

    if (!toggle || !badge || !edit) {
      throw new Error('renderer row missing expected elements')
    }

    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith(task, false)
    expect(badge.textContent).toBe('Every Week 2 on Thu')

    edit.click()
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit).toHaveBeenCalledWith(task, edit)
  })
})
