import { renderRecipeEmptyState } from '../../src/features/recipe/ui/RecipeEmptyState'
import { RecipeIconRenderer } from '../../src/features/recipe/ui/RecipeIconRenderer'
import { RecipeRunPopover } from '../../src/features/recipe/ui/RecipeRunPopover'
import RecipeManagerModal from '../../src/features/recipe/modals/RecipeManagerModal'
import { RecipeSelectModal } from '../../src/features/recipe/modals/RecipeSelectModal'
import { setLocaleOverride } from '../../src/i18n'
import { Notice, TFile } from 'obsidian'

type CreateEl = (tag: string, options?: Record<string, unknown>) => HTMLElement

const setActiveDocument = (doc: Document): void => {
  ;(globalThis as typeof globalThis & { activeDocument: Document }).activeDocument = doc
}

function ensureCreateEl(): void {
  const proto = HTMLElement.prototype as unknown as {
    createEl?: CreateEl
    empty?: () => void
  }
  if (!proto.createEl) {
    proto.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const element = document.createElement(tag)
      if (options.cls) {
        element.className = options.cls as string
      }
      if (options.text) {
        element.textContent = options.text as string
      }
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          element.setAttribute(key, value)
        })
      }
      this.appendChild(element)
      return element
    }
  }
  if (!proto.empty) {
    proto.empty = function () {
      this.innerHTML = ''
    }
  }
}

describe('recipe UI helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    setLocaleOverride('ja')
    ensureCreateEl()
    ;(Notice as unknown as jest.Mock).mockClear?.()
  })

  afterEach(() => {
    setLocaleOverride('en')
  })

  test('empty state offers in-modal creation', () => {
    const container = document.createElement('div')
    const onCreate = jest.fn()

    renderRecipeEmptyState(container, { onCreate })

    expect(container.textContent).toContain('レシピがありません。')
    expect(container.textContent).toContain('このモーダルで作成しますか？')
    const button = container.querySelector<HTMLButtonElement>('.recipe-empty-create-button')
    expect(button?.textContent).toBe('レシピを作成')

    button?.click()

    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('recipe empty state uses english locale strings', () => {
    setLocaleOverride('en')
    const container = document.createElement('div')

    renderRecipeEmptyState(container, { onCreate: jest.fn() })

    expect(container.textContent).toContain('No recipes yet.')
    expect(container.textContent).toContain('Create one in this modal?')
    expect(container.querySelector<HTMLButtonElement>('.recipe-empty-create-button')?.textContent).toBe('Create recipe')
  })

  test('recipe select modal can be closed when no recipes exist', async () => {
    const modal = new RecipeSelectModal({} as never, {
      service: {
        loadRecipes: jest.fn(async () => []),
        assignRecipeToTask: jest.fn(),
        saveRecipe: jest.fn(),
      } as never,
      instance: {
        task: { path: 'TaskChute/Task/Workout.md', name: '運動 - 有酸素 15分' },
      } as never,
      onAssigned: jest.fn(),
    })

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.recipe-empty-create-state')).not.toBeNull()
    const closeButton = document.querySelector<HTMLButtonElement>('.recipe-modal-header .modal-close-button')
    expect(closeButton).not.toBeNull()

    closeButton?.click()

    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })

  test('recipe select modal removes Escape listener from the document that registered it', () => {
    const originalActiveDocument = activeDocument
    const sourceDoc = document.implementation.createHTMLDocument('source')
    const focusedDoc = document.implementation.createHTMLDocument('focused')
    const sourceAdd = jest.spyOn(sourceDoc, 'addEventListener')
    const sourceRemove = jest.spyOn(sourceDoc, 'removeEventListener')
    const focusedRemove = jest.spyOn(focusedDoc, 'removeEventListener')
    const modal = new RecipeSelectModal({} as never, {
      service: {
        loadRecipes: jest.fn(async () => []),
        assignRecipeToTask: jest.fn(),
        saveRecipe: jest.fn(),
      } as never,
      instance: {
        task: { path: 'TaskChute/Task/Workout.md', name: '運動 - 有酸素 15分' },
      } as never,
      onAssigned: jest.fn(),
    })

    try {
      setActiveDocument(sourceDoc)
      modal.open()

      expect(sourceAdd).toHaveBeenCalledWith('keydown', expect.any(Function))

      setActiveDocument(focusedDoc)
      modal.close()

      expect(sourceRemove).toHaveBeenCalledWith('keydown', expect.any(Function))
      expect(focusedRemove).not.toHaveBeenCalledWith('keydown', expect.any(Function))
    } finally {
      modal.close()
      setActiveDocument(originalActiveDocument)
      sourceAdd.mockRestore()
      sourceRemove.mockRestore()
      focusedRemove.mockRestore()
    }
  })

  test('recipe manager can be closed when no recipes exist', async () => {
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => []),
          getAbstractFileByPath: jest.fn(),
          read: jest.fn(),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: { getFileCache: jest.fn() },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.querySelector('.recipe-empty-create-state')).not.toBeNull()
    const closeButton = document.querySelector<HTMLButtonElement>('.recipe-modal-header .modal-close-button')
    expect(closeButton).not.toBeNull()

    closeButton?.click()

    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })

  test('recipe manager removes Escape listener from the document that registered it', () => {
    const originalActiveDocument = activeDocument
    const sourceDoc = document.implementation.createHTMLDocument('source')
    const focusedDoc = document.implementation.createHTMLDocument('focused')
    const sourceAdd = jest.spyOn(sourceDoc, 'addEventListener')
    const sourceRemove = jest.spyOn(sourceDoc, 'removeEventListener')
    const focusedRemove = jest.spyOn(focusedDoc, 'removeEventListener')
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => []),
          getAbstractFileByPath: jest.fn(),
          read: jest.fn(),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: { getFileCache: jest.fn() },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    try {
      setActiveDocument(sourceDoc)
      modal.open()

      expect(sourceAdd).toHaveBeenCalledWith('keydown', expect.any(Function))

      setActiveDocument(focusedDoc)
      modal.close()

      expect(sourceRemove).toHaveBeenCalledWith('keydown', expect.any(Function))
      expect(focusedRemove).not.toHaveBeenCalledWith('keydown', expect.any(Function))
    } finally {
      modal.close()
      setActiveDocument(originalActiveDocument)
      sourceAdd.mockRestore()
      sourceRemove.mockRestore()
      focusedRemove.mockRestore()
    }
  })

  test('recipe select modal shows simple autocomplete suggestions only after typing', async () => {
    const modal = new RecipeSelectModal({} as never, {
      service: {
        loadRecipes: jest.fn(async () => [
          {
            path: 'TaskChute/Recipes/Bath.md',
            title: 'お風呂に入る',
            steps: [{ id: 'step-1', text: '歯磨きする' }],
            file: {},
          },
          {
            path: 'TaskChute/Recipes/Morning.md',
            title: '朝ルーチン',
            steps: [{ id: 'step-1', text: '水を飲む' }],
            file: {},
          },
        ]),
        assignRecipeToTask: jest.fn(),
        saveRecipe: jest.fn(),
      } as never,
      instance: {
        task: { path: 'TaskChute/Task/Workout.md', name: '運動 - 有酸素 15分' },
      } as never,
      onAssigned: jest.fn(),
    })

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(document.body.textContent).not.toContain('お風呂に入る')
    expect(document.body.textContent).not.toContain('朝ルーチン')
    expect(document.querySelector('.taskchute-autocomplete-suggestions')).toBeNull()

    const search = document.querySelector<HTMLInputElement>('.recipe-search-input')
    search!.value = 'お'
    search!.dispatchEvent(new Event('input', { bubbles: true }))

    const suggestions = document.querySelector('.taskchute-autocomplete-suggestions')
    expect(suggestions?.textContent).toContain('お風呂に入る')
    expect(suggestions?.textContent).not.toContain('既存レシピを使う')
    expect(suggestions?.textContent).not.toContain('新規作成')
    expect(document.body.textContent).not.toContain('朝ルーチン')
    modal.close()
  })

  test('recipe select modal assigns existing recipe only after selecting and saving', async () => {
    const assignRecipeToTask = jest.fn()
    const onAssigned = jest.fn()
    const modal = new RecipeSelectModal({} as never, {
      service: {
        loadRecipes: jest.fn(async () => [
          {
            path: 'TaskChute/Recipes/Bath.md',
            title: 'お風呂に入る',
            steps: [{ id: 'step-1', text: '歯磨きする' }],
            file: {},
          },
        ]),
        assignRecipeToTask,
        saveRecipe: jest.fn(),
      } as never,
      instance: {
        task: { path: 'TaskChute/Task/Workout.md', name: '運動 - 有酸素 15分' },
      } as never,
      onAssigned,
    })

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const search = document.querySelector<HTMLInputElement>('.recipe-search-input')
    search!.value = 'お'
    search!.dispatchEvent(new Event('input', { bubbles: true }))

    document.querySelector<HTMLElement>('.taskchute-autocomplete-suggestions .suggestion-item')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    expect(assignRecipeToTask).not.toHaveBeenCalled()
    expect(search!.value).toBe('お風呂に入る')
    expect(document.querySelector('.taskchute-autocomplete-suggestions')).toBeNull()

    document.querySelector<HTMLButtonElement>('.recipe-select-save-button')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(assignRecipeToTask).toHaveBeenCalledWith('TaskChute/Task/Workout.md', 'TaskChute/Recipes/Bath.md')
    expect(onAssigned).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })

  test('recipe select modal does not treat reload failure after assignment as assignment failure', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const assignRecipeToTask = jest.fn()
    const onAssigned = jest.fn(async () => {
      throw new Error('reload failed')
    })
    const modal = new RecipeSelectModal({} as never, {
      service: {
        loadRecipes: jest.fn(async () => [
          {
            path: 'TaskChute/Recipes/Bath.md',
            title: 'お風呂に入る',
            steps: [{ id: 'step-1', text: '歯磨きする' }],
            file: {},
          },
        ]),
        assignRecipeToTask,
        saveRecipe: jest.fn(),
      } as never,
      instance: {
        task: { path: 'TaskChute/Task/Workout.md', name: '運動 - 有酸素 15分' },
      } as never,
      onAssigned,
    })

    try {
      modal.open()
      await new Promise((resolve) => setTimeout(resolve, 0))

      const search = document.querySelector<HTMLInputElement>('.recipe-search-input')
      search!.value = 'お'
      search!.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector<HTMLElement>('.taskchute-autocomplete-suggestions .suggestion-item')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document.querySelector<HTMLButtonElement>('.recipe-select-save-button')?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(assignRecipeToTask).toHaveBeenCalledWith('TaskChute/Task/Workout.md', 'TaskChute/Recipes/Bath.md')
      expect(onAssigned).toHaveBeenCalledTimes(1)
      expect(Notice).not.toHaveBeenCalledWith('レシピの設定に失敗しました')
      expect(document.querySelector('.recipe-modal-content')).toBeNull()
    } finally {
      consoleErrorSpy.mockRestore()
      modal.close()
    }
  })

  test('recipe select modal creates an unmatched recipe from inline step fields', async () => {
    const savedRecipe = {
      path: 'TaskChute/Recipes/ジム基本.md',
      title: 'ジム基本',
      steps: [
        { id: 'step-1', text: '散歩する' },
        { id: 'step-2', text: '筋トレをする' },
      ],
      file: {},
    }
    const saveRecipe = jest.fn(async () => savedRecipe)
    const assignRecipeToTask = jest.fn()
    const onAssigned = jest.fn()
    const modal = new RecipeSelectModal({} as never, {
      service: {
        loadRecipes: jest.fn(async () => [
          {
            path: 'TaskChute/Recipes/Bath.md',
            title: 'お風呂に入る',
            steps: [{ id: 'step-1', text: '歯磨きする' }],
            file: {},
          },
        ]),
        saveRecipe,
        assignRecipeToTask,
      } as never,
      instance: {
        task: { path: 'TaskChute/Task/Workout.md', name: '運動 - 有酸素 15分' },
      } as never,
      onAssigned,
    })

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const search = document.querySelector<HTMLInputElement>('.recipe-search-input')
    search!.value = 'ジム基本'
    search!.dispatchEvent(new Event('input', { bubbles: true }))

    expect(document.querySelector('.taskchute-autocomplete-suggestions')).toBeNull()
    expect(document.body.textContent).not.toContain('一致するレシピがありません')
    expect(document.body.textContent).not.toContain('新規作成')
    expect(document.body.textContent).toContain('手順:')
    expect(document.querySelector<HTMLInputElement>('.recipe-step-input')).not.toBeNull()

    const saveButton = document.querySelector<HTMLButtonElement>('.recipe-select-save-button')
    expect(saveButton?.disabled).toBe(true)
    expect(saveRecipe).not.toHaveBeenCalled()
    expect(assignRecipeToTask).not.toHaveBeenCalled()

    const stepInput = document.querySelector<HTMLInputElement>('.recipe-step-input')
    stepInput!.value = '筋トレをする'
    stepInput!.dispatchEvent(new Event('input', { bubbles: true }))
    expect(saveButton?.disabled).toBe(false)
    expect(document.querySelectorAll('.recipe-step-drag-handle')).toHaveLength(1)

    document.querySelector<HTMLButtonElement>('.recipe-add-step-button')?.click()
    const stepInputs = Array.from(document.querySelectorAll<HTMLInputElement>('.recipe-step-input'))
    expect(stepInputs).toHaveLength(2)
    stepInputs[1].value = '散歩する'
    stepInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelectorAll('.recipe-step-drag-handle')).toHaveLength(2)

    const handles = Array.from(document.querySelectorAll<HTMLButtonElement>('.recipe-step-drag-handle'))
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.recipe-step-row'))
    handles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }))
    rows[1]?.dispatchEvent(new Event('drop', { bubbles: true }))
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('.recipe-step-input')).map((input) => input.value)).toEqual([
      '散歩する',
      '筋トレをする',
    ])

    saveButton?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(saveRecipe).toHaveBeenCalledWith({
      title: 'ジム基本',
      steps: ['散歩する', '筋トレをする'],
    })
    expect(assignRecipeToTask).toHaveBeenCalledWith('TaskChute/Task/Workout.md', 'TaskChute/Recipes/ジム基本.md')
    expect(onAssigned).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })

  test('task recipe badge renders only clickable file icon', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const renderer = new RecipeIconRenderer({
      tv: (_, fallback) => fallback,
      getSummary: jest.fn().mockResolvedValue({ checked: 0, total: 3 }),
      onClick: jest.fn(),
    })

    renderer.render(container, {
      instanceId: 'inst-1',
      task: { recipePath: 'TaskChute/Recipes/Gym.md' },
    } as never)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(container.querySelector('button.recipe-task-badge')).toBeNull()
    expect(container.querySelector('span.recipe-task-badge')).not.toBeNull()
    expect(container.querySelector('.recipe-file-icon')).not.toBeNull()
    expect(container.querySelector('.recipe-task-badge-progress')).toBeNull()
    expect(container.querySelector('.recipe-file-icon-check')).toBeNull()
    expect(container.textContent).toBe('')
  })

  test('task recipe badge removes itself when linked recipe is missing', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const renderer = new RecipeIconRenderer({
      tv: (_, fallback) => fallback,
      getSummary: jest.fn().mockResolvedValue(null),
      onClick: jest.fn(),
    })

    renderer.render(container, {
      instanceId: 'inst-1',
      task: { recipePath: 'TaskChute/Recipes/Missing.md' },
    } as never)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(container.querySelector('.recipe-task-badge')).toBeNull()
  })

  test('run popover stores drag ordering only in daily progress state without saving recipe source', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const saveRecipe = jest.fn()
    const setProgress = jest.fn()
    const openRecipeEditor = jest.fn()
    const popover = new RecipeRunPopover({
      service: {
        loadRecipe: jest.fn(async () => ({
          path: 'TaskChute/Recipes/A.md',
          title: 'aaa',
          file: {},
          steps: [
            { id: 'step-1-a', text: 'a' },
            { id: 'step-2-b', text: 'b' },
          ],
        })),
        saveRecipe,
      } as never,
      getDateKey: () => '2026-05-04',
      getProgress: () => undefined,
      setProgress,
      openRecipeEditor,
      onProgressChanged: jest.fn(),
    })

    await popover.show({
      instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
      task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
    } as never, anchor)

    expect(document.body.textContent).toContain('aaa')
    expect(document.body.textContent).not.toContain('リセット')
    expect(document.body.textContent).not.toContain('Markdownを開く')
    expect(document.body.textContent).not.toContain('0/2')
    expect(document.body.textContent).not.toContain('完了')
    expect(document.querySelector('.recipe-run-summary')).toBeNull()
    expect(document.querySelector('.recipe-run-edit-button')).not.toBeNull()
    expect(document.querySelector('.recipe-run-header > .recipe-run-edit-button')).not.toBeNull()
    expect(document.querySelectorAll('.recipe-step-drag-handle')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('↑')
    expect(document.body.textContent).not.toContain('↓')

    const handles = Array.from(document.querySelectorAll<HTMLButtonElement>('.recipe-step-drag-handle'))
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.recipe-run-step'))
    handles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }))
    rows[1]?.dispatchEvent(new Event('drop', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(saveRecipe).not.toHaveBeenCalled()
    expect(setProgress).toHaveBeenCalledWith(
      'task:TaskChute/Task/A.md::TaskChute/Recipes/A.md',
      expect.objectContaining({
        recipePath: 'TaskChute/Recipes/A.md',
        checkedStepIds: [],
        stepOrder: ['step-2-b', 'step-1-a'],
      }),
      '2026-05-04',
    )
    expect(document.querySelectorAll('.recipe-run-step-text')[0]?.textContent).toBe('b')
    expect(document.querySelectorAll('.recipe-run-step-text')[1]?.textContent).toBe('a')

    document.querySelector<HTMLButtonElement>('.recipe-run-edit-button')?.click()
    expect(openRecipeEditor).toHaveBeenCalledWith('TaskChute/Recipes/A.md')
    expect(document.querySelector('.recipe-run-popover')).toBeNull()
  })

  test('run popover applies saved step order per task/date progress entry only', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const loadRecipe = jest.fn(async () => ({
      path: 'TaskChute/Recipes/A.md',
      title: 'aaa',
      file: {},
      steps: [
        { id: 'step-1-a', text: 'a' },
        { id: 'step-2-b', text: 'b' },
      ],
    }))
    const getProgress = jest.fn((key: string, dateKey: string) => {
      if (key === 'task:TaskChute/Task/A.md::TaskChute/Recipes/A.md' && dateKey === '2026-05-04') {
        return {
          recipePath: 'TaskChute/Recipes/A.md',
          checkedStepIds: [],
          stepOrder: ['step-2-b', 'step-1-a'],
          updatedAt: 1,
        }
      }
      return undefined
    })
    const popover = new RecipeRunPopover({
      service: { loadRecipe, saveRecipe: jest.fn() } as never,
      getDateKey: () => '2026-05-04',
      getProgress,
      setProgress: jest.fn(),
      openRecipeEditor: jest.fn(),
      onProgressChanged: jest.fn(),
    })

    await popover.show({
      instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
      task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
    } as never, anchor)

    expect(document.querySelectorAll('.recipe-run-step-text')[0]?.textContent).toBe('b')
    expect(document.querySelectorAll('.recipe-run-step-text')[1]?.textContent).toBe('a')

    popover.close()
    await popover.show({
      instanceId: 'TaskChute/Task/B.md_2026-05-04_111_bbb',
      task: { path: 'TaskChute/Task/B.md', recipePath: 'TaskChute/Recipes/A.md' },
    } as never, anchor)

    expect(document.querySelectorAll('.recipe-run-step-text')[0]?.textContent).toBe('a')
    expect(document.querySelectorAll('.recipe-run-step-text')[1]?.textContent).toBe('b')
  })

  test('run popover saves progress to click-time date when recipe load resolves after date changes', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    let currentDate = '2026-05-04'
    let resolveRecipe: ((value: unknown) => void) | null = null
    const getDateKey = jest.fn(() => currentDate)
    const getProgress = jest.fn()
    const setProgress = jest.fn()
    const popover = new RecipeRunPopover({
      service: {
        loadRecipe: jest.fn(() => new Promise((resolve) => {
          resolveRecipe = resolve
        })),
      } as never,
      getDateKey,
      getProgress,
      setProgress,
      openRecipeEditor: jest.fn(),
      onProgressChanged: jest.fn(),
    })

    const showPromise = popover.show({
      instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
      task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
    } as never, anchor)
    currentDate = '2026-05-05'
    resolveRecipe?.({
      path: 'TaskChute/Recipes/A.md',
      title: 'aaa',
      file: {},
      steps: [{ id: 'step-1-a', text: 'a' }],
    })
    await showPromise

    const checkbox = document.querySelector<HTMLInputElement>('.recipe-run-step input[type="checkbox"]')
    checkbox!.checked = true
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }))

    expect(getProgress).toHaveBeenCalledWith('task:TaskChute/Task/A.md::TaskChute/Recipes/A.md', '2026-05-04')
    expect(setProgress).toHaveBeenCalledWith(
      'task:TaskChute/Task/A.md::TaskChute/Recipes/A.md',
      expect.objectContaining({
        recipePath: 'TaskChute/Recipes/A.md',
        checkedStepIds: ['step-1-a'],
      }),
      '2026-05-04',
    )
  })

  test('run popover ignores stale recipe loads when another badge is opened first', async () => {
    const anchorA = document.createElement('button')
    const anchorB = document.createElement('button')
    document.body.append(anchorA, anchorB)
    let resolveA: ((value: unknown) => void) | null = null
    let resolveB: ((value: unknown) => void) | null = null
    const loadRecipe = jest.fn((path: string) => new Promise((resolve) => {
      if (path === 'TaskChute/Recipes/A.md') {
        resolveA = resolve
      } else {
        resolveB = resolve
      }
    }))
    const popover = new RecipeRunPopover({
      service: { loadRecipe } as never,
      getDateKey: () => '2026-05-04',
      getProgress: () => undefined,
      setProgress: jest.fn(),
      openRecipeEditor: jest.fn(),
      onProgressChanged: jest.fn(),
    })

    const firstShow = popover.show({
      instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
      task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
    } as never, anchorA)
    const secondShow = popover.show({
      instanceId: 'TaskChute/Task/B.md_2026-05-04_111_bbb',
      task: { path: 'TaskChute/Task/B.md', recipePath: 'TaskChute/Recipes/B.md' },
    } as never, anchorB)

    resolveB?.({
      path: 'TaskChute/Recipes/B.md',
      title: 'new recipe',
      file: {},
      steps: [{ id: 'step-b', text: 'b' }],
    })
    await secondShow
    expect(document.body.textContent).toContain('new recipe')

    resolveA?.({
      path: 'TaskChute/Recipes/A.md',
      title: 'old recipe',
      file: {},
      steps: [{ id: 'step-a', text: 'a' }],
    })
    await firstShow

    expect(document.querySelectorAll('.recipe-run-popover')).toHaveLength(1)
    expect(document.body.textContent).toContain('new recipe')
    expect(document.body.textContent).not.toContain('old recipe')
    popover.close()
  })

  test('run popover removes outside listeners from the document that registered them', async () => {
    const originalActiveDocument = activeDocument
    const sourceDoc = document.implementation.createHTMLDocument('source')
    const focusedDoc = document.implementation.createHTMLDocument('focused')
    const sourceAdd = jest.spyOn(sourceDoc, 'addEventListener')
    const sourceRemove = jest.spyOn(sourceDoc, 'removeEventListener')
    const focusedRemove = jest.spyOn(focusedDoc, 'removeEventListener')
    const anchor = sourceDoc.createElement('button')
    sourceDoc.body.appendChild(anchor)
    const popover = new RecipeRunPopover({
      service: {
        loadRecipe: jest.fn(async () => ({
          path: 'TaskChute/Recipes/A.md',
          title: 'aaa',
          file: {},
          steps: [{ id: 'step-1-a', text: 'a' }],
        })),
      } as never,
      getDateKey: () => '2026-05-04',
      getProgress: () => undefined,
      setProgress: jest.fn(),
      openRecipeEditor: jest.fn(),
      onProgressChanged: jest.fn(),
    })

    try {
      setActiveDocument(sourceDoc)
      await popover.show({
        instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
        task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
      } as never, anchor)

      expect(sourceAdd).toHaveBeenCalledWith('click', expect.any(Function))
      expect(sourceAdd).toHaveBeenCalledWith('touchend', expect.any(Function))

      setActiveDocument(focusedDoc)
      popover.close()

      expect(sourceRemove).toHaveBeenCalledWith('click', expect.any(Function))
      expect(sourceRemove).toHaveBeenCalledWith('touchend', expect.any(Function))
      expect(focusedRemove).not.toHaveBeenCalledWith('click', expect.any(Function))
      expect(focusedRemove).not.toHaveBeenCalledWith('touchend', expect.any(Function))
    } finally {
      popover.close()
      setActiveDocument(originalActiveDocument)
      sourceAdd.mockRestore()
      sourceRemove.mockRestore()
      focusedRemove.mockRestore()
    }
  })

  test('run popover clamps position using the anchor document window', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const popoutDocument = iframe.contentDocument
    const popoutWindow = iframe.contentWindow
    if (!popoutDocument || !popoutWindow) {
      throw new Error('iframe window unavailable')
    }
    Object.defineProperty(popoutWindow, 'innerWidth', { configurable: true, value: 120 })
    Object.defineProperty(popoutWindow, 'innerHeight', { configurable: true, value: 100 })
    const anchor = popoutDocument.createElement('button')
    popoutDocument.body.appendChild(anchor)
    Object.defineProperty(anchor, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 80,
        right: 110,
        bottom: 90,
        left: 100,
        width: 10,
        height: 10,
        x: 100,
        y: 80,
        toJSON: () => ({}),
      } as DOMRect),
    })
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.classList.contains('recipe-run-popover')) {
        return {
          top: 0,
          right: 50,
          bottom: 40,
          left: 0,
          width: 50,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect
      }
      return {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
    const popover = new RecipeRunPopover({
      service: {
        loadRecipe: jest.fn(async () => ({
          path: 'TaskChute/Recipes/A.md',
          title: 'aaa',
          file: {},
          steps: [{ id: 'step-1-a', text: 'a' }],
        })),
      } as never,
      getDateKey: () => '2026-05-04',
      getProgress: () => undefined,
      setProgress: jest.fn(),
      openRecipeEditor: jest.fn(),
      onProgressChanged: jest.fn(),
    })

    try {
      await popover.show({
        instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
        task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
      } as never, anchor)

      const popoverEl = popoutDocument.querySelector<HTMLElement>('.recipe-run-popover')
      expect(popoverEl?.style.getPropertyValue('--taskchute-tooltip-left')).toBe('60px')
      expect(popoverEl?.style.getPropertyValue('--taskchute-tooltip-top')).toBe('34px')
    } finally {
      popover.close()
      rectSpy.mockRestore()
      iframe.remove()
    }
  })

  test('run popover preserves existing completion timestamps when another step is checked', async () => {
    const anchor = document.createElement('button')
    document.body.appendChild(anchor)
    const setProgress = jest.fn()
    const now = new Date('2026-05-04T02:00:00.000Z').getTime()
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(now)
    const popover = new RecipeRunPopover({
      service: {
        loadRecipe: jest.fn(async () => ({
          path: 'TaskChute/Recipes/A.md',
          title: 'aaa',
          file: {},
          steps: [
            { id: 'step-1-a', text: 'a' },
            { id: 'step-2-b', text: 'b' },
          ],
        })),
      } as never,
      getDateKey: () => '2026-05-04',
      getProgress: () => ({
        recipePath: 'TaskChute/Recipes/A.md',
        checkedStepIds: ['step-1-a'],
        completedAtByStepId: {
          'step-1-a': '2026-05-04T01:00:00.000Z',
        },
        updatedAt: 1,
      }),
      setProgress,
      openRecipeEditor: jest.fn(),
      onProgressChanged: jest.fn(),
    })

    try {
      await popover.show({
        instanceId: 'TaskChute/Task/A.md_2026-05-04_111_aaa',
        task: { path: 'TaskChute/Task/A.md', recipePath: 'TaskChute/Recipes/A.md' },
      } as never, anchor)

      const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('.recipe-run-step input[type="checkbox"]'))
      expect(checkboxes[0]?.checked).toBe(true)
      const secondCheckbox = checkboxes[1]
      if (!secondCheckbox) {
        throw new Error('second recipe step checkbox not found')
      }
      secondCheckbox.checked = true
      secondCheckbox.dispatchEvent(new Event('change', { bubbles: true }))

      expect(setProgress).toHaveBeenCalledWith(
        'task:TaskChute/Task/A.md::TaskChute/Recipes/A.md',
        expect.objectContaining({
          checkedStepIds: ['step-1-a', 'step-2-b'],
          completedAtByStepId: {
            'step-1-a': '2026-05-04T01:00:00.000Z',
            'step-2-b': '2026-05-04T02:00:00.000Z',
          },
        }),
        '2026-05-04',
      )
    } finally {
      dateNowSpy.mockRestore()
      popover.close()
    }
  })

  test('recipe manager edit form reorders source recipe steps with drag handle before save', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n- [ ] b\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => [file]),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(async (target: TFile, content: string) => {
            const entry = files.get(target.path)
            if (entry) entry.content = content
          }),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('.modal-header h3')?.textContent).toBe('レシピ一覧')
    expect(document.querySelector('.recipe-source-open-button')).not.toBeNull()
    expect(document.querySelector('.recipe-card-delete-button')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('.recipe-card-edit-button')?.click()

    expect(document.querySelectorAll('.recipe-step-drag-handle')).toHaveLength(2)
    expect(document.querySelector('.recipe-usage-details')).toBeNull()
    expect(document.body.textContent).not.toContain('使用中のタスク')
    expect(document.querySelector('.recipe-edit-form .recipe-danger-button')).toBeNull()
    const handles = Array.from(document.querySelectorAll<HTMLButtonElement>('.recipe-step-drag-handle'))
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.recipe-step-row'))
    handles[0]?.dispatchEvent(new Event('dragstart', { bubbles: true }))
    rows[1]?.dispatchEvent(new Event('drop', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    document.querySelector<HTMLFormElement>('.recipe-edit-form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(files.get(file.path)?.content).toContain('- [ ] b\n- [ ] a')
    modal.close()
  })

  test('recipe manager source button opens recipe markdown file', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const openLinkText = jest.fn()
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => [file]),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.recipe-source-open-button')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openLinkText).toHaveBeenCalledWith('TaskChute/Recipes/A.md', '', false)
    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })

  test('recipe manager closes on cancel when edit was opened directly from task popover', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => [file]),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never, {
      initialRecipePath: 'TaskChute/Recipes/A.md',
    })

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.querySelector('.modal-header h3')?.textContent).toBe('レシピ編集')

    const cancelButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'キャンセル')
    cancelButton?.click()

    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })

  test('recipe manager returns to list on cancel when edit was opened from recipe list', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => [file]),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.recipe-card-edit-button')?.click()

    const cancelButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'キャンセル')
    cancelButton?.click()

    expect(document.querySelector('.modal-header h3')?.textContent).toBe('レシピ一覧')
    expect(document.querySelector('.recipe-modal-content')).not.toBeNull()
    modal.close()
  })

  test('recipe manager deletes recipe from routine-style confirmation modal, not edit form', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const trashFile = jest.fn(async (target: TFile) => {
      files.delete(target.path)
    })
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => Array.from(files.values()).map((entry) => entry.file)),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile, processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.recipe-card-delete-button')?.click()

    expect(document.querySelector('.recipe-delete-confirm')).toBeNull()
    expect(document.querySelector('.recipe-delete-confirm-overlay')).not.toBeNull()
    expect(document.querySelector('.routine-confirm')).not.toBeNull()
    expect(document.querySelector('.routine-confirm')?.closest('.recipe-delete-confirm-overlay')).not.toBeNull()
    expect(document.body.lastElementChild?.classList.contains('recipe-delete-confirm-overlay')).toBe(true)
    expect(document.body.textContent).toContain('「aaa」を削除しますか？')
    expect(document.body.textContent).toContain('紐付いているタスクからも解除されます。')
    expect(document.body.textContent).not.toContain('自動解除されません')

    document.querySelector<HTMLButtonElement>('.routine-confirm__button.mod-danger')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(trashFile).toHaveBeenCalledWith(file)
    expect(document.querySelector('.routine-confirm')).toBeNull()
    modal.close()
  })

  test('recipe manager notifies caller after deleting a recipe', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const trashFile = jest.fn(async (target: TFile) => {
      files.delete(target.path)
    })
    const processFrontMatter = jest.fn()
    const onRecipesChanged = jest.fn()
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => Array.from(files.values()).map((entry) => entry.file)),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile, processFrontMatter },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never, { onRecipesChanged })

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.recipe-card-delete-button')?.click()
    document.querySelector<HTMLButtonElement>('.routine-confirm__button.mod-danger')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(trashFile).toHaveBeenCalledWith(file)
    expect(onRecipesChanged).toHaveBeenCalledTimes(1)
    modal.close()
  })

  test('recipe manager Escape on delete confirmation does not close parent modal', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => Array.from(files.values()).map((entry) => entry.file)),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLButtonElement>('.recipe-card-delete-button')?.click()
    expect(document.querySelector('.routine-confirm')).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.querySelector('.routine-confirm')).toBeNull()
    expect(document.querySelector('.recipe-modal-content')).not.toBeNull()
    expect(document.querySelector('.modal-header h3')?.textContent).toBe('レシピ一覧')
    modal.close()
  })

  test('recipe manager closes when clicking outside the modal content', async () => {
    const file = new TFile()
    file.path = 'TaskChute/Recipes/A.md'
    file.basename = 'A'
    file.extension = 'md'
    const files = new Map([
      [file.path, {
        file,
        content: '---\ntaskchute_recipe: true\ntitle: "aaa"\n---\n\n- [ ] a\n',
        frontmatter: { taskchute_recipe: true, title: 'aaa' },
      }],
    ])
    const plugin = {
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => [file]),
          getAbstractFileByPath: jest.fn((path: string) => files.get(path)?.file ?? null),
          read: jest.fn(async (target: TFile) => files.get(target.path)?.content ?? ''),
          modify: jest.fn(),
          create: jest.fn(),
        },
        metadataCache: {
          getFileCache: jest.fn((target: TFile) => ({ frontmatter: files.get(target.path)?.frontmatter ?? {} })),
        },
        fileManager: { trashFile: jest.fn(), processFrontMatter: jest.fn() },
        workspace: { openLinkText: jest.fn() },
      },
      pathManager: {
        getRecipeFolderPath: () => 'TaskChute/Recipes',
        getTaskFolderPath: () => 'TaskChute/Task',
        ensureFolderExists: jest.fn(),
      },
    }
    const modal = new RecipeManagerModal(plugin.app as never, plugin as never)

    modal.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    document.querySelector<HTMLElement>('.recipe-modal-content')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.recipe-modal-content')).not.toBeNull()

    document.querySelector<HTMLElement>('.task-modal-overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.querySelector('.recipe-modal-content')).toBeNull()
  })
})
