/**
 * TaskHeaderController AI board-view segmented control:
 *   - rendered in the header action section ONLY while the AI Task feature is
 *     enabled (host callback); a disabled feature leaves the header exactly
 *     as it was before the control existed
 *   - three segments (human / ai / mixed) with emoji prefixes composed in
 *     code (👤 / 🤖) and i18n labels; the active segment mirrors
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
}

function createHost(options: AiHostOptions = {}): {
  host: TaskHeaderControllerHost
  setAiTaskBoardView: jest.Mock
  state: { view: AiTaskBoardView; enabled: boolean }
} {
  const state = {
    view: options.initialView ?? ('mixed' as AiTaskBoardView),
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
      settings: { aiRobotButtonEnabled: false },
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
  test('renders three segments in the action section while the feature is enabled', () => {
    const { host } = createHost()
    const { container } = renderHeader(host)

    const group = container.querySelector('.ai-board-view-switch')
    expect(group).not.toBeNull()
    expect(
      group?.parentElement?.classList.contains('header-action-section'),
    ).toBe(true)
    const buttons = segments(container)
    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.getAttribute('data-view'))).toEqual([
      'human',
      'ai',
      'mixed',
    ])
  })

  test('emoji prefixes are composed in code around the i18n labels', () => {
    const { host } = createHost()
    const { container } = renderHeader(host)

    const [human, ai, mixed] = segments(container)
    expect(human.textContent).toContain('👤')
    expect(human.textContent).toContain('Human')
    expect(ai.textContent).toContain('🤖')
    expect(ai.textContent).toContain('AI')
    expect(mixed.textContent).toContain('Mixed')
    for (const button of [human, ai, mixed]) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
    }
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

  test('refreshAiTaskBoardSwitch adds and removes the control as the feature toggles', () => {
    const { host, state } = createHost({ enabled: false })
    const { controller, container } = renderHeader(host)
    expect(container.querySelector('.ai-board-view-switch')).toBeNull()

    state.enabled = true
    controller.refreshAiTaskBoardSwitch()
    expect(container.querySelector('.ai-board-view-switch')).not.toBeNull()
    expect(segments(container)).toHaveLength(3)

    state.enabled = false
    controller.refreshAiTaskBoardSwitch()
    expect(container.querySelector('.ai-board-view-switch')).toBeNull()

    // Idempotent re-enable never duplicates the control.
    state.enabled = true
    controller.refreshAiTaskBoardSwitch()
    controller.refreshAiTaskBoardSwitch()
    expect(container.querySelectorAll('.ai-board-view-switch')).toHaveLength(1)
  })
})
