/**
 * TaskCreationController AI task mode (U3):
 *   - a human/AI task-type selector appears near the top of the add-task
 *     modal ONLY while the AI Task feature is enabled on desktop
 *   - AI mode reveals (in reference order) the main-agent card grid
 *     (Claude Code default / Codex), the prompt textarea with a live
 *     command preview, a start-time input, and an advanced block
 *     (execution mode, AI model, reasoning mode/budget, working directory)
 *   - the preview mirrors the interactive terminal argv: binary + args +
 *     quoted prompt head
 *   - submitting in AI mode hands an aiTask payload to
 *     TaskCreationService.createTaskFile; human mode stays byte-identical
 *   - reuse/copy radios and autocomplete selection keep working in AI mode
 */
import { TFile } from 'obsidian'
import TaskCreationController, {
  TaskCreationControllerHost,
} from '../../../src/ui/task/TaskCreationController'
import type {
  TaskInstance,
  TaskNameValidator,
  TaskChutePluginLike,
} from '../../../src/types'
import type { App } from 'obsidian'
import { en } from '../../../src/i18n/locales/en'
import { ja } from '../../../src/i18n/locales/ja'
import type { Recipe } from '../../../src/features/recipe/types'

jest.mock('obsidian', () => {
  const Actual = jest.requireActual('obsidian')
  return {
    ...Actual,
    Notice: jest.fn(),
    TFile: class MockTFile {},
    // Mutable object: single tests flip isDesktop to simulate mobile; the
    // controller reads Platform?.isDesktop at call time.
    Platform: { isDesktop: true, isMobile: false },
  }
})

// The controller sees the same mocked object reference.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockPlatformState = (require('obsidian') as {
  Platform: { isDesktop: boolean; isMobile: boolean }
}).Platform

jest.mock('../../../src/ui/components/TaskNameAutocomplete', () => ({
  TaskNameAutocomplete: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn(),
    isSuggestionsVisible: jest.fn(() => false),
    hasActiveSelection: jest.fn(() => false),
  })),
}))

const validator: TaskNameValidator = {
  INVALID_CHARS_PATTERN: /[\\/:]/g,
  validate: (name: string) => {
    const invalidChars = name.match(/[\\/:]/g) ?? []
    return {
      isValid: invalidChars.length === 0 && name.trim().length > 0,
      invalidChars,
    }
  },
  getErrorMessage: (chars: string[]) => `Invalid: ${chars.join(',')}`,
}

interface CreateHostOptions {
  defaultWorkingDirectory?: string
  workingDirectoryCandidates?: string[]
  storedWorkingDirectories?: string[]
  selectDirectory?: (defaultPath?: string) => Promise<string | null>
  recipes?: Recipe[]
}

function createHost(
  settings: Partial<TaskChutePluginLike['settings']> = {},
  options: CreateHostOptions = {},
) {
  const createdFile = new (TFile)()
  createdFile.path = 'TASKS/New Task.md'

  const taskCreationService = {
    createTaskFile: jest.fn().mockResolvedValue(createdFile),
  }
  const taskReuseService = {
    reuseTaskAtDate: jest.fn().mockResolvedValue({
      file: new (TFile)(),
      instanceId: 'reuse-instance-1',
    }),
  }
  const aiTaskEditService = {
    load: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
  }

  const saveLocalStorage = jest.fn()
  const loadLocalStorage = jest.fn((key: string) =>
    key === 'taskchute-plus.ai-task-working-directory-history'
      ? options.storedWorkingDirectories ?? []
      : null,
  )
  const pluginStub: TaskChutePluginLike = {
    app: {
      loadLocalStorage,
      saveLocalStorage,
      vault: {
        adapter: {
          getBasePath: () => options.defaultWorkingDirectory ?? '',
        },
      },
    } as unknown as App,
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
      aiTaskEnabled: true,
      ...settings,
    },
    pathManager: {
      getTaskFolderPath: () => 'TASKS',
      getProjectFolderPath: () => 'PROJECTS',
      getLogDataPath: () => 'LOGS',
      getReviewDataPath: () => 'REVIEWS',
      ensureFolderExists: jest.fn(),
      getLogYearPath: jest.fn(),
      ensureYearFolder: jest.fn(),
      validatePath: jest.fn(() => ({ valid: true })),
    },
    routineAliasService: { loadAliases: jest.fn() },
    dayStateService: {
      loadDay: jest.fn(),
      saveDay: jest.fn(),
      mergeDayState: jest.fn(),
      clearCache: jest.fn(),
      getDateFromKey: jest.fn(),
    },
    saveSettings: jest.fn(),
    manifest: { id: 'taskchute-plus' },
  } as unknown as TaskChutePluginLike

  const host: TaskCreationControllerHost = {
    tv: (_key, fallback, vars) => {
      if (!vars) return fallback
      return Object.entries(vars).reduce(
        (acc, [name, value]) => acc.replace(`{${name}}`, String(value)),
        fallback,
      )
    },
    getTaskNameValidator: () => validator,
    taskCreationService:
      taskCreationService as unknown as TaskCreationControllerHost['taskCreationService'],
    aiTaskEditService:
      aiTaskEditService as unknown as TaskCreationControllerHost['aiTaskEditService'],
    taskReuseService:
      taskReuseService as unknown as TaskCreationControllerHost['taskReuseService'],
    registerAutocompleteCleanup: jest.fn(),
    reloadTasksAndRestore: jest.fn().mockResolvedValue(undefined),
    getCurrentDateString: () => '2025-10-09',
    app: {
      metadataCache: {
        getFileCache: jest.fn(() => ({ frontmatter: {} })),
      },
    },
    plugin: pluginStub,
    getAiTaskDefaultWorkingDirectory: () =>
      options.defaultWorkingDirectory ?? '',
    getAiTaskWorkingDirectoryCandidates: () =>
      options.workingDirectoryCandidates ?? [],
    selectAiTaskDirectory: options.selectDirectory,
    hasInstanceForPathToday: jest.fn(() => false),
    duplicateInstanceForPath: jest.fn().mockResolvedValue(null),
    invalidateDayStateCache: jest.fn(),
    findDeletedTaskRestoreCandidate: jest.fn(() => null),
    restoreDeletedTaskCandidate: jest.fn().mockResolvedValue(true),
    ...(options.recipes
      ? {
          recipeService: {
            loadRecipes: jest.fn(async () => options.recipes ?? []),
          } as unknown as TaskCreationControllerHost['recipeService'],
        }
      : {}),
  }

  return {
    host,
    taskCreationService,
    aiTaskEditService,
    taskReuseService,
    loadLocalStorage,
    saveLocalStorage,
  }
}

function makeRecipe(path = 'TaskChute/Recipes/Publish.md'): Recipe {
  return {
    path,
    title: 'Publish',
    schemaVersion: 2,
    goal: 'A public URL exists',
    steps: [{ id: 'step-1', text: 'Publish the article' }],
    qualityChecks: [{ id: 'quality-1', text: 'Open the URL' }],
    constraints: [{ id: 'constraint-1', text: 'Do not expose secrets' }],
    file: new TFile(),
  }
}

function openModal(host: TaskCreationControllerHost): HTMLElement {
  const controller = new TaskCreationController(host)
  controller.showAddTaskModal()
  const modal = document.querySelector<HTMLElement>('.task-modal-overlay')
  if (!modal) throw new Error('modal did not open')
  return modal
}

async function openEditModal(
  host: TaskCreationControllerHost,
  inst: TaskInstance,
): Promise<HTMLElement> {
  const controller = new TaskCreationController(host)
  await controller.showEditAiTaskModal(inst)
  const modal = document.querySelector<HTMLElement>('.task-modal-overlay')
  if (!modal) throw new Error('edit modal did not open')
  return modal
}

function createAiTaskInstance(file: TFile): TaskInstance {
  return {
    task: {
      file,
      frontmatter: { ai_task: true, ai_task_host: 'codex' },
      path: file.path,
      name: 'Existing AI task',
      displayTitle: 'Existing AI task',
      isRoutine: true,
    },
    instanceId: 'existing-ai-instance',
    state: 'idle',
    slotKey: '8:00-12:00',
  }
}

function existingCodexEditValue(file: TFile) {
  return {
    file,
    taskName: 'Existing AI task',
    host: 'codex' as const,
    args: [
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
      '--model=gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="max"',
      '--future-flag',
      'future-value',
    ],
    cwd: '/Users/me/existing-project',
    prompt: 'Review the existing project',
    scheduledTime: '08:45',
  }
}

function typeButton(modal: HTMLElement, type: 'human' | 'ai'): HTMLButtonElement {
  const button = modal.querySelector<HTMLButtonElement>(
    `.task-type-option[data-task-type="${type}"]`,
  )
  if (!button) throw new Error(`type button ${type} missing`)
  return button
}

function agentCard(modal: HTMLElement, hostId: 'claude' | 'codex'): HTMLButtonElement {
  const card = modal.querySelector<HTMLButtonElement>(
    `.ai-task-agent-card[data-ai-host="${hostId}"]`,
  )
  if (!card) throw new Error(`agent card ${hostId} missing`)
  return card
}

function previewCode(modal: HTMLElement): string {
  return (
    modal.querySelector<HTMLElement>('.ai-task-command-preview code')?.textContent ??
    ''
  )
}

function setPrompt(modal: HTMLElement, value: string): void {
  const textarea = modal.querySelector<HTMLTextAreaElement>('.ai-task-prompt-input')
  if (!textarea) throw new Error('prompt textarea missing')
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function modelOptionValues(modal: HTMLElement): string[] {
  return Array.from(
    modal.querySelectorAll<HTMLElement>('.ai-model-select__option'),
  ).map((option) => option.dataset.modelId ?? '')
}

function setModel(modal: HTMLElement, value: string): boolean {
  const trigger = modal.querySelector<HTMLButtonElement>('.ai-task-model-select')
  if (!trigger) throw new Error('model picker missing')
  trigger.click()
  const option = Array.from(
    modal.querySelectorAll<HTMLButtonElement>('.ai-model-select__option'),
  ).find((candidate) => candidate.dataset.modelId === value)
  if (option) {
    option.click()
    return true
  }

  modal.querySelector<HTMLButtonElement>('.ai-model-select__add')?.click()
  const customModal = document.querySelector<HTMLElement>('.ai-custom-model-modal')
  const id = customModal?.querySelector<HTMLInputElement>(
    '.ai-custom-model-modal__model-id',
  )
  const label = customModal?.querySelector<HTMLInputElement>(
    '.ai-custom-model-modal__display-name',
  )
  const form = customModal?.querySelector<HTMLFormElement>(
    '.ai-custom-model-modal__form',
  )
  if (!customModal || !id || !label || !form) {
    throw new Error('custom model modal missing')
  }
  id.value = value
  id.dispatchEvent(new Event('input', { bubbles: true }))
  label.value = `Custom ${value}`
  label.dispatchEvent(new Event('input', { bubbles: true }))
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  const saved = document.querySelector('.ai-custom-model-modal') === null
  if (!saved) {
    customModal
      .querySelector<HTMLButtonElement>('.ai-custom-model-modal__cancel')
      ?.click()
  }
  return saved
}

function selectReasoningMode(
  modal: HTMLElement,
  value: 'automatic' | 'specified' | 'ultra',
): void {
  const select = modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')
  if (!select) throw new Error('reasoning mode select missing')
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function selectReasoningBudget(modal: HTMLElement, value: string): void {
  const select = modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-budget')
  if (!select) throw new Error('reasoning budget select missing')
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function selectExecMode(modal: HTMLElement, value: string): void {
  const select = modal.querySelector<HTMLSelectElement>('.ai-task-exec-mode')
  if (!select) throw new Error('exec mode select missing')
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

async function submit(modal: HTMLElement): Promise<void> {
  const form = modal.querySelector('form') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('AI task edit modal', () => {
  test('preserves an unchanged recipe assignment with the undefined tri-state', async () => {
    const recipe = makeRecipe()
    const { host, aiTaskEditService } = createHost(
      { recipeFeatureEnabled: true },
      { recipes: [recipe] },
    )
    const file = new TFile()
    file.path = 'TASKS/Existing AI task.md'
    const inst = createAiTaskInstance(file)
    aiTaskEditService.load.mockResolvedValue({
      ...existingCodexEditValue(file),
      recipePath: recipe.path,
    })

    const modal = await openEditModal(host, inst)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-recipe-select')?.value,
    ).toBe(recipe.path)

    await submit(modal)

    const savedOptions = aiTaskEditService.save.mock.calls[0]?.[2]
    expect(savedOptions).toBeDefined()
    expect(savedOptions).not.toHaveProperty('recipePath')
  })

  test('preserves an unchanged empty recipe assignment with the undefined tri-state', async () => {
    const { host, aiTaskEditService } = createHost(
      { recipeFeatureEnabled: true },
      { recipes: [makeRecipe()] },
    )
    const file = new TFile()
    file.path = 'TASKS/Existing AI task.md'
    const inst = createAiTaskInstance(file)
    aiTaskEditService.load.mockResolvedValue(existingCodexEditValue(file))

    const modal = await openEditModal(host, inst)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-recipe-select')?.value,
    ).toBe('')

    await submit(modal)

    const savedOptions = aiTaskEditService.save.mock.calls[0]?.[2]
    expect(savedOptions).toBeDefined()
    expect(savedOptions).not.toHaveProperty('recipePath')
  })

  test('loads the assigned recipe and allows an explicit unlink', async () => {
    const recipe = makeRecipe()
    const { host, aiTaskEditService } = createHost(
      { recipeFeatureEnabled: true },
      { recipes: [recipe] },
    )
    const file = new TFile()
    file.path = 'TASKS/Existing AI task.md'
    const inst = createAiTaskInstance(file)
    aiTaskEditService.load.mockResolvedValue({
      ...existingCodexEditValue(file),
      recipePath: recipe.path,
    })

    const modal = await openEditModal(host, inst)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const select = modal.querySelector<HTMLSelectElement>(
      '.ai-task-recipe-select',
    )
    expect(select?.value).toBe(recipe.path)
    if (!select) throw new Error('recipe select missing')
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))

    await submit(modal)

    expect(aiTaskEditService.save).toHaveBeenCalledWith(
      file,
      '08:45',
      expect.objectContaining({ recipePath: null }),
    )
  })

  test('loads an existing Codex task into the shared controls without exposing task type', async () => {
    const { host, aiTaskEditService } = createHost()
    const file = new TFile()
    file.path = 'TASKS/Existing AI task.md'
    const inst = createAiTaskInstance(file)
    aiTaskEditService.load.mockResolvedValue(existingCodexEditValue(file))

    const modal = await openEditModal(host, inst)

    expect(aiTaskEditService.load).toHaveBeenCalledWith(
      file,
      inst.task.frontmatter,
      'Existing AI task',
    )
    const nameInput = modal.querySelector<HTMLInputElement>(
      '.task-name-input--readonly',
    )
    expect(nameInput?.value).toBe('Existing AI task')
    expect(nameInput?.readOnly).toBe(true)
    expect(modal.querySelector('.task-type-group')?.classList.contains('hidden')).toBe(true)
    expect(modal.querySelector('.ai-task-section')?.classList.contains('hidden')).toBe(false)
    expect(agentCard(modal, 'codex').classList.contains('is-selected')).toBe(true)
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-exec-mode')?.value,
    ).toBe('full-auto')
    expect(
      modal.querySelector<HTMLButtonElement>('.ai-task-model-select')?.textContent,
    ).toContain('GPT-5.6 Sol')
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')?.value,
    ).toBe('specified')
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-budget')?.value,
    ).toBe('max')
    expect(
      modal.querySelector('.ai-task-reasoning-budget-field')?.classList.contains('hidden'),
    ).toBe(false)
    expect(
      modal.querySelector<HTMLInputElement>('.ai-task-cwd-input')?.value,
    ).toBe('/Users/me/existing-project')
    expect(
      modal.querySelector<HTMLTextAreaElement>('.ai-task-prompt-input')?.value,
    ).toBe('Review the existing project')
    expect(
      modal.querySelector<HTMLInputElement>('.ai-task-scheduled-time')?.value,
    ).toBe('08:45')
    expect(previewCode(modal)).toBe(
      'codex --ask-for-approval never --sandbox workspace-write ' +
        '--model=gpt-5.6-sol --config model_reasoning_effort="max" ' +
        '--future-flag future-value -- "Review the existing project"',
    )
  })

  test('saves edited settings without creating a task and retains unknown arguments', async () => {
    const {
      host,
      aiTaskEditService,
      taskCreationService,
    } = createHost()
    const file = new TFile()
    file.path = 'TASKS/Existing AI task.md'
    const inst = createAiTaskInstance(file)
    aiTaskEditService.load.mockResolvedValue(existingCodexEditValue(file))
    const modal = await openEditModal(host, inst)

    setPrompt(modal, 'Updated review prompt')
    selectReasoningBudget(modal, 'high')
    const cwd = modal.querySelector<HTMLInputElement>('.ai-task-cwd-input')
    if (!cwd) throw new Error('working directory input missing')
    cwd.value = '/Users/me/updated-project'
    cwd.dispatchEvent(new Event('input', { bubbles: true }))
    const scheduled = modal.querySelector<HTMLInputElement>(
      '.ai-task-scheduled-time',
    )
    if (!scheduled) throw new Error('scheduled time input missing')
    scheduled.value = '09:15'

    await submit(modal)

    expect(taskCreationService.createTaskFile).not.toHaveBeenCalled()
    expect(aiTaskEditService.save).toHaveBeenCalledWith(
      file,
      '09:15',
      {
        host: 'codex',
        args: [
          '--ask-for-approval',
          'never',
          '--sandbox',
          'workspace-write',
          '--model=gpt-5.6-sol',
          '--config',
          'model_reasoning_effort="high"',
          '--future-flag',
          'future-value',
        ],
        cwd: '/Users/me/updated-project',
        prompt: 'Updated review prompt',
      },
    )
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({
      runBoundaryCheck: true,
    })
    expect(document.querySelector('.task-modal-overlay')).toBeNull()
  })

  test('keeps the edit modal open when saving fails', async () => {
    const {
      host,
      aiTaskEditService,
      taskCreationService,
    } = createHost()
    const file = new TFile()
    file.path = 'TASKS/Existing AI task.md'
    const inst = createAiTaskInstance(file)
    aiTaskEditService.load.mockResolvedValue(existingCodexEditValue(file))
    aiTaskEditService.save.mockRejectedValue(new Error('save failed'))
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const modal = await openEditModal(host, inst)

    try {
      await submit(modal)

      expect(taskCreationService.createTaskFile).not.toHaveBeenCalled()
      expect(aiTaskEditService.save).toHaveBeenCalledTimes(1)
      expect(host.reloadTasksAndRestore).not.toHaveBeenCalled()
      expect(document.body.contains(modal)).toBe(true)
      expect(
        modal.querySelector<HTMLButtonElement>('.form-button.create')?.disabled,
      ).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('task-type selector gating', () => {
  test('renders the human/AI selector when the AI feature is enabled on desktop', () => {
    const { host } = createHost()
    const modal = openModal(host)

    const group = modal.querySelector('.task-type-group')
    expect(group).not.toBeNull()
    expect(typeButton(modal, 'human').classList.contains('is-selected')).toBe(true)
    expect(typeButton(modal, 'ai').classList.contains('is-selected')).toBe(false)
    // The AI section exists but stays hidden while human mode is selected.
    const section = modal.querySelector('.ai-task-section')
    expect(section).not.toBeNull()
    expect(section?.classList.contains('hidden')).toBe(true)
  })

  test('renders no selector and no AI section when the feature is disabled', () => {
    const { host } = createHost({ aiTaskEnabled: false })
    const modal = openModal(host)

    expect(modal.querySelector('.task-type-group')).toBeNull()
    expect(modal.querySelector('.ai-task-section')).toBeNull()
  })

  test('renders no selector on non-desktop platforms even when enabled', () => {
    mockPlatformState.isDesktop = false
    mockPlatformState.isMobile = true
    try {
      const { host } = createHost()
      const modal = openModal(host)
      expect(modal.querySelector('.task-type-group')).toBeNull()
      expect(modal.querySelector('.ai-task-section')).toBeNull()
    } finally {
      mockPlatformState.isDesktop = true
      mockPlatformState.isMobile = false
    }
  })
})

describe('AI mode UI', () => {
  test('shows recipe disclosure and submits the selected Recipe v2 link', async () => {
    const recipe = makeRecipe()
    const { host, taskCreationService } = createHost(
      { recipeFeatureEnabled: true },
      { recipes: [recipe] },
    )
    const modal = openModal(host)
    ;(modal.querySelector('input.form-input') as HTMLInputElement).value =
      'AI Publish'
    typeButton(modal, 'ai').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const select = modal.querySelector<HTMLSelectElement>(
      '.ai-task-recipe-select',
    )
    expect(select).not.toBeNull()
    expect(select?.options[1]?.textContent).toContain('Publish')
    expect(modal.textContent).toContain('秘密情報を含めないでください')
    if (!select) throw new Error('recipe select missing')
    select.value = recipe.path
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(modal.querySelector('.ai-task-recipe-preview')?.textContent).toContain(
      'A public URL exists',
    )

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'AI Publish',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: expect.objectContaining({ recipePath: recipe.path }),
      }),
    )
  })

  test('switching to AI mode reveals the section; back to human hides it', () => {
    const { host } = createHost()
    const modal = openModal(host)
    const section = modal.querySelector('.ai-task-section') as HTMLElement

    typeButton(modal, 'ai').click()
    expect(section.classList.contains('hidden')).toBe(false)
    expect(typeButton(modal, 'ai').classList.contains('is-selected')).toBe(true)
    expect(typeButton(modal, 'human').classList.contains('is-selected')).toBe(false)

    typeButton(modal, 'human').click()
    expect(section.classList.contains('hidden')).toBe(true)
  })

  test('shows exactly two agent cards with Claude Code selected by default', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    const cards = modal.querySelectorAll('.ai-task-agent-card')
    expect(cards).toHaveLength(2)
    expect(agentCard(modal, 'claude').classList.contains('is-selected')).toBe(true)
    expect(agentCard(modal, 'codex').classList.contains('is-selected')).toBe(false)
    expect(agentCard(modal, 'claude').textContent).toContain('Claude Code')
    expect(agentCard(modal, 'codex').textContent).toContain('Codex')
  })

  test('agent cards carry the reference icons (👑 Claude Code / 📜 Codex)', () => {
    // Carried fix: the reference main-agents.ts uses 👑 for Claude Code.
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    expect(
      agentCard(modal, 'claude').querySelector('.ai-task-agent-icon')?.textContent,
    ).toBe('👑')
    expect(
      agentCard(modal, 'codex').querySelector('.ai-task-agent-icon')?.textContent,
    ).toBe('📜')
  })

  test('clicking the Codex card selects it and deselects Claude Code', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    agentCard(modal, 'codex').click()

    expect(agentCard(modal, 'codex').classList.contains('is-selected')).toBe(true)
    expect(agentCard(modal, 'claude').classList.contains('is-selected')).toBe(false)
  })

  test('renders the prompt textarea (rows=4), start time, and advanced controls', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    const textarea = modal.querySelector<HTMLTextAreaElement>('.ai-task-prompt-input')
    expect(textarea).not.toBeNull()
    expect(textarea?.rows).toBe(4)
    expect(textarea?.placeholder).toContain('Review this pull request')

    // Start time shows in AI mode even though the advanced-settings feature
    // flag (showTaskCreationAdvancedSettings) is off.
    expect(
      modal.querySelector<HTMLInputElement>('.ai-task-scheduled-time'),
    ).not.toBeNull()

    expect(modal.querySelector('.ai-task-advanced')).not.toBeNull()
    expect(modal.querySelector('.ai-task-exec-mode')).not.toBeNull()
    expect(modal.querySelector('.ai-task-model-select')).not.toBeNull()
    expect(modal.querySelector('.ai-task-model-input')).toBeNull()
    expect(modal.querySelector('.ai-task-reasoning-mode')).not.toBeNull()
    expect(modal.querySelector('.ai-task-reasoning-budget')).not.toBeNull()
    expect(modal.querySelector('.ai-task-cwd-input')).not.toBeNull()
  })

  test('offers verified host-specific model presets plus a custom option', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    modal.querySelector<HTMLButtonElement>('.ai-task-model-select')?.click()
    expect(modelOptionValues(modal)).toEqual([
      '',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ])
    expect(modal.querySelector('.ai-model-select__add')).not.toBeNull()

    agentCard(modal, 'codex').click()
    modal.querySelector<HTMLButtonElement>('.ai-task-model-select')?.click()
    expect(modelOptionValues(modal)).toEqual([
      '',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
  })

  test('shows the vault workspace, recent directories, and native Browse control', async () => {
    const selectDirectory = jest.fn(async () => '/Users/me/Projects/alpha')
    const { host } = createHost(
      {},
      {
        defaultWorkingDirectory: '/Users/me/Evergreens',
        storedWorkingDirectories: ['/Users/me/Recent'],
        workingDirectoryCandidates: ['/Users/me/Candidate'],
        selectDirectory,
      },
    )
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    const input = modal.querySelector<HTMLInputElement>('.ai-task-cwd-input')
    expect(input?.value).toBe('/Users/me/Evergreens')

    const toggle = modal.querySelector<HTMLButtonElement>(
      '.ai-working-directory-select__toggle',
    )
    toggle?.click()
    expect(
      modal.querySelector(
        '.ai-working-directory-select__option[data-path="/Users/me/Recent"]',
      ),
    ).not.toBeNull()
    expect(
      modal.querySelector(
        '.ai-working-directory-select__option[data-path="/Users/me/Candidate"]',
      ),
    ).not.toBeNull()

    modal
      .querySelector<HTMLButtonElement>('.ai-working-directory-select__browse')
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(selectDirectory).toHaveBeenCalledWith('/Users/me/Evergreens')
    expect(input?.value).toBe('/Users/me/Projects/alpha')
  })
})

describe('command preview', () => {
  test('defaults to the bare claude command and appends the quoted prompt', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    expect(previewCode(modal)).toBe('claude')

    setPrompt(modal, 'Review this PR')
    expect(previewCode(modal)).toBe('claude -- "Review this PR"')
  })

  test('reflects host switches and execution-mode variants', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')

    selectExecMode(modal, 'auto')
    expect(previewCode(modal)).toBe('claude --permission-mode auto -- "Go"')

    selectExecMode(modal, 'skip-permissions')
    expect(previewCode(modal)).toBe('claude --dangerously-skip-permissions -- "Go"')

    // Switching the host resets the variant to its default and swaps the
    // binary and the variant option set.
    agentCard(modal, 'codex').click()
    expect(previewCode(modal)).toBe('codex -- "Go"')

    selectExecMode(modal, 'full-auto')
    expect(previewCode(modal)).toBe(
      'codex --ask-for-approval never --sandbox workspace-write -- "Go"',
    )
  })

  test('appends a --model=<value> token when the model input is non-empty', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')

    setModel(modal, 'claude-sonnet-4-5')

    expect(previewCode(modal)).toBe('claude --model=claude-sonnet-4-5 -- "Go"')
  })

  test('uses a verified model preset without revealing the custom input', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')

    setModel(modal, 'claude-fable-5')

    expect(previewCode(modal)).toBe('claude --model=claude-fable-5 -- "Go"')
    expect(modal.querySelector('.ai-task-model-input')).toBeNull()
  })

  test('keeps model ids using the full reference-safe character set', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')

    setModel(modal, 'groq/llama-3.3-70b:versatile_x')

    expect(previewCode(modal)).toBe(
      'claude --model=groq/llama-3.3-70b:versatile_x -- "Go"',
    )
  })

  test('drops model ids outside the reference safe pattern (carried fix)', () => {
    // Reference parity (quest-command.ts MODEL_ID_SAFE_PATTERN): invalid ids
    // are ignored instead of producing an argv token the CLI rejects.
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')

    setModel(modal, '-leading-hyphen')
    expect(previewCode(modal)).toBe('claude -- "Go"')

    setModel(modal, 'opus 4.6; rm -rf /')
    expect(previewCode(modal)).toBe('claude -- "Go"')
  })

  test('flattens newlines and truncates the displayed prompt head', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    setPrompt(modal, 'line one\nline two')
    expect(previewCode(modal)).toBe('claude -- "line one line two"')

    const long = 'a'.repeat(60)
    setPrompt(modal, long)
    expect(previewCode(modal)).toBe(`claude -- "${'a'.repeat(40)}…"`)
  })

  test('shows the real argv separator and shell-escapes the displayed prompt', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    setPrompt(modal, '--help "quoted" \\path $HOME `pwd`')

    expect(previewCode(modal)).toBe(
      'claude -- "--help \\"quoted\\" \\\\path \\$HOME \\`pwd\\`"',
    )
  })

  test('clears a host-specific model when switching agents', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')
    setModel(modal, 'claude-sonnet-4-5')

    agentCard(modal, 'codex').click()

    expect(
      modal.querySelector<HTMLButtonElement>('.ai-task-model-select')?.textContent,
    ).toContain('Default model')
    expect(previewCode(modal)).toBe('codex -- "Go"')
  })

  test('keeps reasoning settings when the selected agent card is clicked again', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')
    setModel(modal, 'claude-fable-5')
    selectReasoningMode(modal, 'specified')
    selectReasoningBudget(modal, 'max')

    agentCard(modal, 'claude').click()

    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')?.value,
    ).toBe('specified')
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-budget')?.value,
    ).toBe('max')
    expect(previewCode(modal)).toBe(
      'claude --model=claude-fable-5 --effort=max -- "Go"',
    )
  })

  test('maps Claude and Codex reasoning budgets to their documented CLI args', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')
    setModel(modal, 'claude-fable-5')

    const budgetField = modal.querySelector('.ai-task-reasoning-budget-field')
    expect(
      modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')?.value,
    ).toBe('automatic')
    expect(budgetField?.classList.contains('hidden')).toBe(true)

    selectReasoningMode(modal, 'specified')
    selectReasoningBudget(modal, 'high')
    expect(budgetField?.classList.contains('hidden')).toBe(false)
    expect(previewCode(modal)).toBe(
      'claude --model=claude-fable-5 --effort=high -- "Go"',
    )

    selectReasoningMode(modal, 'ultra')
    expect(previewCode(modal)).toBe(
      'claude --model=claude-fable-5 --effort=ultracode -- "Go"',
    )

    agentCard(modal, 'codex').click()
    setModel(modal, 'gpt-5.6-terra')
    selectReasoningMode(modal, 'ultra')
    expect(previewCode(modal)).toBe(
      'codex --model=gpt-5.6-terra --config model_reasoning_effort="ultra" -- "Go"',
    )
  })

  test('offers host-specific parallel modes separately from effort budgets', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    const budget = modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-budget')
    const values = () => Array.from(budget?.options ?? []).map((option) => option.value)
    expect(values()).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const modes = modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')
    const modeValues = () => Array.from(modes?.options ?? []).map((option) => option.value)
    // Default resolves through the user's CLI configuration, so its model
    // capability is unknown until a concrete preset is selected.
    expect(modeValues()).toEqual(['automatic'])

    agentCard(modal, 'codex').click()
    expect(values()).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(modeValues()).toEqual(['automatic'])

    setModel(modal, 'gpt-5.6-sol')
    expect(modeValues()).toEqual(['automatic', 'specified', 'ultra'])
  })

  test('resets specified reasoning when switching to effort-incompatible Haiku', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')
    setModel(modal, 'claude-fable-5')
    selectReasoningMode(modal, 'specified')
    selectReasoningBudget(modal, 'high')
    expect(previewCode(modal)).toBe(
      'claude --model=claude-fable-5 --effort=high -- "Go"',
    )

    setModel(modal, 'claude-haiku-4-5')

    const mode = modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')
    expect(Array.from(mode?.options ?? []).map((option) => option.value)).toEqual([
      'automatic',
    ])
    expect(mode?.value).toBe('automatic')
    expect(previewCode(modal)).toBe(
      'claude --model=claude-haiku-4-5 -- "Go"',
    )
  })

  test('resets Ultra when switching from Codex Terra to Luna', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()
    agentCard(modal, 'codex').click()
    setPrompt(modal, 'Go')
    setModel(modal, 'gpt-5.6-terra')
    selectReasoningMode(modal, 'ultra')
    expect(previewCode(modal)).toContain('model_reasoning_effort="ultra"')

    setModel(modal, 'gpt-5.6-luna')

    const mode = modal.querySelector<HTMLSelectElement>('.ai-task-reasoning-mode')
    expect(Array.from(mode?.options ?? []).map((option) => option.value)).toEqual([
      'automatic',
      'specified',
    ])
    expect(mode?.value).toBe('automatic')
    expect(previewCode(modal)).toBe(
      'codex --model=gpt-5.6-luna -- "Go"',
    )
  })
})

describe('AI mode submission', () => {
  test('omits the vault default cwd and records only a successfully saved custom cwd', async () => {
    const first = createHost(
      {},
      { defaultWorkingDirectory: '/Users/me/Evergreens' },
    )
    const defaultModal = openModal(first.host)
    ;(defaultModal.querySelector('input.form-input') as HTMLInputElement).value =
      'Default Workspace'
    typeButton(defaultModal, 'ai').click()

    await submit(defaultModal)

    expect(first.taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Default Workspace',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: expect.objectContaining({ cwd: undefined }),
      }),
    )
    expect(first.saveLocalStorage).not.toHaveBeenCalled()

    const second = createHost(
      {},
      { defaultWorkingDirectory: '/Users/me/Evergreens' },
    )
    const customModal = openModal(second.host)
    ;(customModal.querySelector('input.form-input') as HTMLInputElement).value =
      'Custom Workspace'
    typeButton(customModal, 'ai').click()
    const cwd = customModal.querySelector<HTMLInputElement>('.ai-task-cwd-input')!
    cwd.value = '/Users/me/Projects/custom'
    cwd.dispatchEvent(new Event('input', { bubbles: true }))

    await submit(customModal)

    expect(second.taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Custom Workspace',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: expect.objectContaining({ cwd: '/Users/me/Projects/custom' }),
      }),
    )
    expect(second.saveLocalStorage).toHaveBeenCalledWith(
      'taskchute-plus.ai-task-working-directory-history',
      ['/Users/me/Projects/custom'],
    )
  })

  test('hands the aiTask payload (host, args, cwd, prompt) to createTaskFile', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'AI Review'

    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Review this PR')
    selectExecMode(modal, 'auto')
    setModel(modal, 'claude-sonnet-4-5')
    const cwd = modal.querySelector('.ai-task-cwd-input') as HTMLInputElement
    cwd.value = '/Users/me/project'
    cwd.dispatchEvent(new Event('input', { bubbles: true }))
    const scheduled = modal.querySelector(
      '.ai-task-scheduled-time',
    ) as HTMLInputElement
    scheduled.value = '09:30'
    scheduled.dispatchEvent(new Event('input', { bubbles: true }))

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'AI Review',
      '2025-10-09',
      '09:30',
      expect.objectContaining({
        aiTask: {
          host: 'claude',
          args: ['--permission-mode', 'auto', '--model=claude-sonnet-4-5'],
          cwd: '/Users/me/project',
          prompt: 'Review this PR',
        },
      }),
    )
    expect(document.querySelector('.task-modal-overlay')).toBeNull()
  })

  test('an invalid model id contributes no token to the submitted args', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'AI Bad Model'

    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Go')
    setModel(modal, 'not a model!!')

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'AI Bad Model',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: { host: 'claude', args: [], cwd: undefined, prompt: 'Go' },
      }),
    )
  })

  test('submits the prompt with its outer whitespace unchanged', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Whitespace Prompt'
    const prompt = '\n    indented first line  \nlast line\n'

    typeButton(modal, 'ai').click()
    setPrompt(modal, prompt)
    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Whitespace Prompt',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: expect.objectContaining({ prompt }),
      }),
    )
  })

  test('normalizes a whitespace-only prompt to an empty REPL prompt', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Blank Prompt'

    typeButton(modal, 'ai').click()
    setPrompt(modal, '  \n\t  ')
    expect(previewCode(modal)).toBe('claude')
    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Blank Prompt',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: expect.objectContaining({ prompt: '' }),
      }),
    )
  })

  test('submits codex with default variant, no model, no cwd, empty prompt', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Codex Task'

    typeButton(modal, 'ai').click()
    agentCard(modal, 'codex').click()

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Codex Task',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: { host: 'codex', args: [], cwd: undefined, prompt: '' },
      }),
    )
  })

  test.each([
    {
      label: 'Claude',
      aiHost: 'claude' as const,
      model: 'claude-fable-5',
      expectedArgs: ['--model=claude-fable-5', '--effort=max'],
    },
    {
      label: 'Codex',
      aiHost: 'codex' as const,
      model: 'gpt-5.6-sol',
      expectedArgs: [
        '--model=gpt-5.6-sol',
        '--config',
        'model_reasoning_effort="max"',
      ],
    },
  ])(
    'submits $label Specify budget + Maximum as literal argv tokens',
    async ({ label, aiHost, model, expectedArgs }) => {
      const { host, taskCreationService } = createHost()
      const modal = openModal(host)
      const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
      nameInput.value = `${label} Maximum Task`

      typeButton(modal, 'ai').click()
      if (aiHost === 'codex') agentCard(modal, 'codex').click()
      setModel(modal, model)
      selectReasoningMode(modal, 'specified')
      selectReasoningBudget(modal, 'max')

      await submit(modal)

      expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
        `${label} Maximum Task`,
        '2025-10-09',
        undefined,
        expect.objectContaining({
          aiTask: {
            host: aiHost,
            args: expectedArgs,
            cwd: undefined,
            prompt: '',
          },
        }),
      )
    },
  )

  test('submits a Codex preset and Ultra reasoning as literal argv tokens', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Codex Ultra Task'

    typeButton(modal, 'ai').click()
    agentCard(modal, 'codex').click()
    setModel(modal, 'gpt-5.6-sol')
    selectReasoningMode(modal, 'ultra')

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Codex Ultra Task',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: {
          host: 'codex',
          args: [
            '--model=gpt-5.6-sol',
            '--config',
            'model_reasoning_effort="ultra"',
          ],
          cwd: undefined,
          prompt: '',
        },
      }),
    )
  })

  test('submits Claude Ultracode using its host-specific effort value', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Claude Ultracode Task'

    typeButton(modal, 'ai').click()
    setModel(modal, 'claude-fable-5')
    selectReasoningMode(modal, 'ultra')
    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Claude Ultracode Task',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: {
          host: 'claude',
          args: ['--model=claude-fable-5', '--effort=ultracode'],
          cwd: undefined,
          prompt: '',
        },
      }),
    )
  })

  test('human mode with the feature enabled submits exactly as before', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Plain Task'

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Plain Task',
      '2025-10-09',
    )
  })

  test('switching to AI and back to human submits a plain human task', async () => {
    const { host, taskCreationService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Round Trip'

    typeButton(modal, 'ai').click()
    setPrompt(modal, 'ignored')
    typeButton(modal, 'human').click()

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Round Trip',
      '2025-10-09',
    )
  })

  test('reuse mode ignores the AI start time and configuration entirely', async () => {
    // Carried WARNING regression: the AI section is hidden in reuse mode, so
    // none of its inputs (including the start time) may leak into the reuse.
    const { host, taskCreationService, taskReuseService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement

    typeButton(modal, 'ai').click()
    setPrompt(modal, 'should be ignored')
    const scheduled = modal.querySelector('.ai-task-scheduled-time') as HTMLInputElement
    scheduled.value = '14:00'
    scheduled.dispatchEvent(new Event('input', { bubbles: true }))

    nameInput.value = 'Existing Task'
    nameInput.dispatchEvent(
      new CustomEvent('autocomplete-selected', {
        detail: {
          value: 'Existing Task',
          suggestion: {
            type: 'task',
            name: 'Existing Task',
            path: 'TaskChute/Task/existing.md',
          },
        },
      }),
    )

    await submit(modal)

    expect(taskReuseService.reuseTaskAtDate).toHaveBeenCalledWith(
      'TaskChute/Task/existing.md',
      '2025-10-09',
      undefined,
    )
    expect(taskCreationService.createTaskFile).not.toHaveBeenCalled()
  })

  test('reuse via autocomplete keeps working while AI mode is selected', async () => {
    const { host, taskCreationService, taskReuseService } = createHost()
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement

    typeButton(modal, 'ai').click()

    nameInput.value = 'Existing Task'
    nameInput.dispatchEvent(
      new CustomEvent('autocomplete-selected', {
        detail: {
          value: 'Existing Task',
          suggestion: {
            type: 'task',
            name: 'Existing Task',
            path: 'TaskChute/Task/existing.md',
          },
        },
      }),
    )

    const modeGroup = modal.querySelector('.task-mode-group') as HTMLElement
    expect(modeGroup.classList.contains('hidden')).toBe(false)

    await submit(modal)

    expect(taskReuseService.reuseTaskAtDate).toHaveBeenCalledWith(
      'TaskChute/Task/existing.md',
      '2025-10-09',
      undefined,
    )
    expect(taskCreationService.createTaskFile).not.toHaveBeenCalled()
  })
})

describe('reuse mode hides the AI configuration (carried fix)', () => {
  function selectReusableTask(modal: HTMLElement): void {
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'Existing Task'
    nameInput.dispatchEvent(
      new CustomEvent('autocomplete-selected', {
        detail: {
          value: 'Existing Task',
          suggestion: {
            type: 'task',
            name: 'Existing Task',
            path: 'TaskChute/Task/existing.md',
          },
        },
      }),
    )
  }

  function modeRadio(modal: HTMLElement, value: 'reuse' | 'copy'): HTMLInputElement {
    const radio = modal.querySelector<HTMLInputElement>(
      `.task-mode-option input[value="${value}"]`,
    )
    if (!radio) throw new Error(`mode radio ${value} missing`)
    return radio
  }

  test('selecting a reusable task hides the type selector and AI section (reference parity)', () => {
    const { host } = createHost()
    const modal = openModal(host)
    const typeGroup = modal.querySelector('.task-type-group') as HTMLElement
    const section = modal.querySelector('.ai-task-section') as HTMLElement

    typeButton(modal, 'ai').click()
    expect(section.classList.contains('hidden')).toBe(false)

    // The reuse radio is checked by default once a reusable task is chosen.
    selectReusableTask(modal)
    expect(typeGroup.classList.contains('hidden')).toBe(true)
    expect(section.classList.contains('hidden')).toBe(true)

    // Switching to "create new copy" restores the AI configuration.
    modeRadio(modal, 'copy').click()
    expect(typeGroup.classList.contains('hidden')).toBe(false)
    expect(section.classList.contains('hidden')).toBe(false)

    // And back to reuse hides it again.
    modeRadio(modal, 'reuse').click()
    expect(typeGroup.classList.contains('hidden')).toBe(true)
    expect(section.classList.contains('hidden')).toBe(true)
  })

  test('clearing the reusable selection restores the selector', () => {
    const { host } = createHost()
    const modal = openModal(host)
    const typeGroup = modal.querySelector('.task-type-group') as HTMLElement
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement

    selectReusableTask(modal)
    expect(typeGroup.classList.contains('hidden')).toBe(true)

    nameInput.value = 'Different name'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    expect(typeGroup.classList.contains('hidden')).toBe(false)
  })

  test('copy mode with a reusable selection still creates an AI task', async () => {
    const { host, taskCreationService, taskReuseService } = createHost()
    const modal = openModal(host)

    typeButton(modal, 'ai').click()
    setPrompt(modal, 'Review this PR')
    selectReusableTask(modal)
    modeRadio(modal, 'copy').click()

    await submit(modal)

    expect(taskReuseService.reuseTaskAtDate).not.toHaveBeenCalled()
    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'Existing Task',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        aiTask: expect.objectContaining({ host: 'claude', prompt: 'Review this PR' }),
      }),
    )
  })
})

describe('label parity with the reference modal (carried fix)', () => {
  test('the agent and cwd field label fallbacks carry the reference emojis', () => {
    const { host } = createHost()
    const modal = openModal(host)
    typeButton(modal, 'ai').click()

    const labels = Array.from(
      modal.querySelectorAll<HTMLElement>('.ai-task-section .form-label'),
      (label) => label.textContent ?? '',
    )
    expect(labels.some((text) => text.startsWith('👑 '))).toBe(true)
    expect(labels.some((text) => text.startsWith('📁 '))).toBe(true)
  })

  test('en and ja locales share the reference emoji prefixes', () => {
    expect(en.taskChuteView.addTask.aiAgentLabel.startsWith('👑 ')).toBe(true)
    expect(ja.taskChuteView.addTask.aiAgentLabel.startsWith('👑 ')).toBe(true)
    expect(en.taskChuteView.addTask.aiCwdLabel.startsWith('📁 ')).toBe(true)
    expect(ja.taskChuteView.addTask.aiCwdLabel.startsWith('📁 ')).toBe(true)
  })
})

describe('human advanced block in AI mode (carried fix)', () => {
  function humanAdvanced(modal: HTMLElement): HTMLElement {
    const root = modal.querySelector<HTMLElement>('.task-creation-advanced')
    if (!root) throw new Error('human advanced block missing')
    return root
  }

  test('AI mode hides the human advanced block; human mode restores it', () => {
    const { host } = createHost({ showTaskCreationAdvancedSettings: true })
    const modal = openModal(host)

    expect(humanAdvanced(modal).classList.contains('hidden')).toBe(false)

    typeButton(modal, 'ai').click()
    expect(humanAdvanced(modal).classList.contains('hidden')).toBe(true)

    typeButton(modal, 'human').click()
    expect(humanAdvanced(modal).classList.contains('hidden')).toBe(false)
  })

  test('reuse mode shows the human advanced block again even in AI mode', () => {
    const { host } = createHost({ showTaskCreationAdvancedSettings: true })
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement

    typeButton(modal, 'ai').click()
    expect(humanAdvanced(modal).classList.contains('hidden')).toBe(true)

    // Reuse consumes the human block's schedule/reminder, so it comes back.
    nameInput.value = 'Existing Task'
    nameInput.dispatchEvent(
      new CustomEvent('autocomplete-selected', {
        detail: {
          value: 'Existing Task',
          suggestion: {
            type: 'task',
            name: 'Existing Task',
            path: 'TaskChute/Task/existing.md',
          },
        },
      }),
    )
    expect(humanAdvanced(modal).classList.contains('hidden')).toBe(false)
  })

  test('AI submit ignores the human block time and reminder (carried WARNING)', async () => {
    // Regression: human 09:00 + reminder toggle + AI 14:00 used to emit
    // scheduled_time 14:00 with a reminder computed from 09:00.
    const { host, taskCreationService } = createHost({
      showTaskCreationAdvancedSettings: true,
    })
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'AI With Reminder'

    const humanTime = modal.querySelector(
      '.task-creation-scheduled-time',
    ) as HTMLInputElement
    humanTime.value = '09:00'
    humanTime.dispatchEvent(new Event('input', { bubbles: true }))
    const reminderToggle = modal.querySelector(
      '.task-creation-reminder-toggle',
    ) as HTMLInputElement
    reminderToggle.checked = true

    typeButton(modal, 'ai').click()
    const aiTime = modal.querySelector('.ai-task-scheduled-time') as HTMLInputElement
    aiTime.value = '14:00'
    aiTime.dispatchEvent(new Event('input', { bubbles: true }))

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'AI With Reminder',
      '2025-10-09',
      '14:00',
      expect.objectContaining({
        reminderTime: undefined,
        aiTask: expect.objectContaining({ host: 'claude' }),
      }),
    )
  })

  test('AI submit without an AI time carries no schedule from the human block', async () => {
    const { host, taskCreationService } = createHost({
      showTaskCreationAdvancedSettings: true,
    })
    const modal = openModal(host)
    const nameInput = modal.querySelector('input.form-input') as HTMLInputElement
    nameInput.value = 'AI No Time'

    const humanTime = modal.querySelector(
      '.task-creation-scheduled-time',
    ) as HTMLInputElement
    humanTime.value = '09:00'
    humanTime.dispatchEvent(new Event('input', { bubbles: true }))

    typeButton(modal, 'ai').click()

    await submit(modal)

    expect(taskCreationService.createTaskFile).toHaveBeenCalledWith(
      'AI No Time',
      '2025-10-09',
      undefined,
      expect.objectContaining({
        reminderTime: undefined,
        aiTask: expect.objectContaining({ host: 'claude' }),
      }),
    )
  })
})
