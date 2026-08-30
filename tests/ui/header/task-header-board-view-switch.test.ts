/**
 * TaskHeaderController AI board-view segmented control:
 *   - rendered in the right header action section ONLY while the AI Task feature is
 *     enabled (host callback); a disabled feature leaves the header exactly
 *     as it was before the control existed
 *   - three segments (human / ai / mixed) with Lucide icons composed in
 *     code and i18n labels; the active segment mirrors
 *     host.getAiTaskBoardView()
 *   - clicking a segment calls host.setAiTaskBoardView and re-syncs the
 *     active state
 *   - refreshAiTaskBoardSwitch() adds/removes the control after the feature
 *     toggle changes without re-rendering the whole header
 */
import TaskHeaderController, {
  TaskHeaderControllerHost,
} from '../../../src/ui/header/TaskHeaderController'
import type { AiTaskBoardView } from '../../../src/features/ai-task/types'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

jest.mock('../../../src/i18n', () => {
  const actual = jest.requireActual('../../../src/i18n')
  return {
    ...actual,
    getCurrentLocale: () => 'en',
  }
})

interface AiHostOptions {
  enabled?: boolean
  initialView?: AiTaskBoardView
  robotEnabled?: boolean
}

function createHost(options: AiHostOptions = {}): {
  host: TaskHeaderControllerHost
  setAiTaskBoardView: jest.Mock
  state: { view: AiTaskBoardView; enabled: boolean }
} {
  const state = {
    view: options.initialView ?? ('mixed'),
    enabled: options.enabled ?? true,
  }
  const setAiTaskBoardView = jest.fn((view: AiTaskBoardView) => {
    state.view = view
  })
  const host: TaskHeaderControllerHost = {
    tv: (_key, fallback) => fallback,
    getCurrentDate: () => new Date(2026, 6, 12),
    setCurrentDate: jest.fn(),
    adjustCurrentDate: jest.fn(),
    reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
    showAddTaskModal: jest.fn(),
    toggleNavigation: jest.fn(),
    plugin: {
      settings: { aiRobotButtonEnabled: options.robotEnabled ?? false },
    } as unknown as TaskHeaderControllerHost['plugin'],
    app: {
      commands: { commands: {}, executeCommandById: jest.fn() },
    } as unknown as TaskHeaderControllerHost['app'],
    registerManagedDomEvent: jest.fn(
      (target: Document | HTMLElement, event: string, handler: EventListener) => {
        target.addEventListener(event, handler)
      },
    ),
    isAiTaskFeatureEnabled: () => state.enabled,
    getAiTaskBoardView: () => state.view,
    setAiTaskBoardView,
  }
  return { host, setAiTaskBoardView, state }
}

function renderHeader(host: TaskHeaderControllerHost): {
  controller: TaskHeaderController
  container: HTMLElement
} {
  const controller = new TaskHeaderController(host)
  const container = document.createElement('div')
  document.body.appendChild(container)
  controller.render(container)
  return { controller, container }
}

const segments = (container: HTMLElement): HTMLButtonElement[] =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>('.ai-board-view-switch__segment'),
  )

beforeEach(() => {
  document.body.replaceChildren()
  jest.clearAllMocks()
})

describe('TaskHeaderController board view switch', () => {
  test('renders three segments in the right action section while the feature is enabled', () => {
    const { host } = createHost()
    const { container } = renderHeader(host)

    const group = container.querySelector('.ai-board-view-switch')
    expect(group).not.toBeNull()
    expect(
      group?.parentElement?.classList.contains('header-action-section'),
    ).toBe(true)
    expect(container.querySelector('.drawer-toggle')?.parentElement).toBe(container)
    const buttons = segments(container)
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('data-view'))).toEqual([
      'human',
      'ai',
      'mixed',
    ])
  })

  test('Lucide icons are composed in code beside the i18n labels', () => {
    const { host } = createHost()
    const { container } = renderHeader(host)

    const [human, ai, mixed] = segments(container)
    expect(human.textContent).toContain('Human')
    expect(ai.textContent).toContain('AI')
    expect(mixed.textContent).toContain('Mixed')
    expect(
      [human, ai, mixed].map((button) =>
        button
          .querySelector('.ai-board-view-switch__icon')
          ?.getAttribute('data-icon'),
      ),
    ).toEqual(['user-round', 'bot', 'layers'])
    for (const button of [human, ai, mixed]) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
    }
  })

  test('keeps the view switch beside the far-right add button when the legacy terminal action is enabled', () => {
    const { host } = createHost({ robotEnabled: true })
    const { container } = renderHeader(host)
    const actions = container.querySelector('.header-action-section')
    const group = actions?.querySelector('.ai-board-view-switch')
    const addButton = actions?.querySelector('.add-task-button')

    expect(actions?.lastElementChild?.classList.contains('add-task-button')).toBe(
      true,
    )
    expect(group?.nextElementSibling).toBe(addButton)
    expect(actions?.firstElementChild?.classList.contains('robot-terminal-button')).toBe(
      true,
    )
  })

  test('the active segment mirrors host.getAiTaskBoardView (default mixed)', () => {
    const { host } = createHost()
    const { container } = renderHeader(host)

    const [human, ai, mixed] = segments(container)
    expect(mixed.classList.contains('is-active')).toBe(true)
    expect(mixed.getAttribute('aria-pressed')).toBe('true')
    expect(human.classList.contains('is-active')).toBe(false)
    expect(ai.classList.contains('is-active')).toBe(false)
  })

  test('clicking a segment updates the host and the active state', () => {
    const { host, setAiTaskBoardView } = createHost()
    const { container } = renderHeader(host)

    const [human, , mixed] = segments(container)
    human.dispatchEvent(new Event('click', { bubbles: true }))

    expect(setAiTaskBoardView).toHaveBeenCalledWith('human')
    expect(human.classList.contains('is-active')).toBe(true)
    expect(human.getAttribute('aria-pressed')).toBe('true')
    expect(mixed.classList.contains('is-active')).toBe(false)
    expect(mixed.getAttribute('aria-pressed')).toBe('false')
  })

  test('a stored non-default view is reflected on first render', () => {
    const { host } = createHost({ initialView: 'ai' })
    const { container } = renderHeader(host)

    const [, ai] = segments(container)
    expect(ai.classList.contains('is-active')).toBe(true)
  })

  test('renders nothing when the AI Task feature is disabled', () => {
    const { host } = createHost({ enabled: false })
    const { container } = renderHeader(host)

    expect(container.querySelector('.ai-board-view-switch')).toBeNull()
  })

  test('the header markup with the feature disabled is identical to a host without the AI members', () => {
    const disabled = createHost({ enabled: false })
    const { container: withDisabledFeature } = renderHeader(disabled.host)

    const bare = createHost()
    delete (bare.host as Partial<TaskHeaderControllerHost>).isAiTaskFeatureEnabled
    delete (bare.host as Partial<TaskHeaderControllerHost>).getAiTaskBoardView
    delete (bare.host as Partial<TaskHeaderControllerHost>).setAiTaskBoardView
    const { container: withoutMembers } = renderHeader(bare.host)

    expect(withDisabledFeature.innerHTML).toBe(withoutMembers.innerHTML)
  })

  // The narrow-width header rules key off this class instead of `:has()`,
  // which Obsidian's plugin review rejects. If it stops tracking the control,
  // the switch silently overlaps the add action on a split pane.
  test('the presence marker class follows the control on both the section and the top bar', () => {
    const { host, state } = createHost({ enabled: false })
    const { controller, container } = renderHeader(host)
    const actions = container.querySelector('.header-action-section')

    expect(actions?.classList.contains('has-board-view-switch')).toBe(false)
    expect(container.classList.contains('has-board-view-switch')).toBe(false)

    state.enabled = true
    controller.refreshAiTaskBoardSwitch()
    expect(actions?.classList.contains('has-board-view-switch')).toBe(true)
    expect(container.classList.contains('has-board-view-switch')).toBe(true)

    state.enabled = false
    controller.refreshAiTaskBoardSwitch()
    expect(actions?.classList.contains('has-board-view-switch')).toBe(false)
    expect(container.classList.contains('has-board-view-switch')).toBe(false)
  })

  test('refreshAiTaskBoardSwitch adds and removes the control as the feature toggles', () => {
    const { host, state } = createHost({ enabled: false })
    const { controller, container } = renderHeader(host)
    expect(container.querySelector('.ai-board-view-switch')).toBeNull()

    state.enabled = true
    controller.refreshAiTaskBoardSwitch()
    expect(container.querySelector('.ai-board-view-switch')).not.toBeNull()
    expect(segments(container)).toHaveLength(3)
    expect(
      container.querySelector('.ai-board-view-switch')?.nextElementSibling,
    ).toBe(container.querySelector('.add-task-button'))

    state.enabled = false
    controller.refreshAiTaskBoardSwitch()
    expect(container.querySelector('.ai-board-view-switch')).toBeNull()

    // Idempotent re-enable never duplicates the control.
    state.enabled = true
    controller.refreshAiTaskBoardSwitch()
    controller.refreshAiTaskBoardSwitch()
    expect(container.querySelectorAll('.ai-board-view-switch')).toHaveLength(1)
    expect(
      container.querySelector('.ai-board-view-switch')?.nextElementSibling,
    ).toBe(container.querySelector('.add-task-button'))
  })

  test('repeated refreshes never re-register segment click handlers', () => {
    const { host, setAiTaskBoardView, state } = createHost()
    const { controller, container } = renderHeader(host)
    const managed = host.registerManagedDomEvent as jest.Mock
    const segmentClickRegistrations = () =>
      managed.mock.calls.filter(
        ([target, event]) =>
          event === 'click' &&
          target instanceof HTMLElement &&
          target.classList.contains('ai-board-view-switch__segment'),
      ).length

    expect(segmentClickRegistrations()).toBe(3)

    // Toggle the feature off and on a few times: managed registrations for
    // detached buttons are only released at view unload, so re-registering
    // on every refresh would accumulate for the session.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      state.enabled = false
      controller.refreshAiTaskBoardSwitch()
      state.enabled = true
      controller.refreshAiTaskBoardSwitch()
    }

    expect(segmentClickRegistrations()).toBe(3)
    expect(segments(container)).toHaveLength(3)

    // The surviving buttons still work, and exactly once per click.
    const [human] = segments(container)
    human.dispatchEvent(new Event('click', { bubbles: true }))
    expect(setAiTaskBoardView).toHaveBeenCalledTimes(1)
    expect(setAiTaskBoardView).toHaveBeenCalledWith('human')
    expect(human.classList.contains('is-active')).toBe(true)
  })
})
