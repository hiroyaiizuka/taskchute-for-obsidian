import { Notice, TFile } from 'obsidian'
import NavigationRoutineController, { NavigationRoutineHost } from '../../../src/ui/navigation/NavigationRoutineController'
import type { RoutineTaskShape } from '../../../src/types/routine'

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian')
  return {
    ...actual,
    Notice: jest.fn(),
  }
})

const NoticeMock = Notice as unknown as jest.Mock

type FrontmatterMap = Map<TFile, Record<string, unknown>>

describe('NavigationRoutineController', () => {
  function ensurePrototypeAugmentations(): void {
    const proto = HTMLElement.prototype as unknown as {
      createEl?: (tag: string, options?: Record<string, unknown>) => HTMLElement
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

  function createMockTFile(path: string): TFile {
    const file = new TFile()
    Object.defineProperty(file, 'path', {
      value: path,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(file, 'basename', {
      value: path.split('/').pop() ?? 'task',
      writable: true,
      configurable: true,
    })
    Object.defineProperty(file, 'extension', {
      value: 'md',
      writable: true,
      configurable: true,
    })
    return file
  }

  function translate(_key: string, fallback: string, vars?: Record<string, string | number>): string {
    if (!vars) return fallback
    return fallback.replace(/\{(\w+)\}/g, (_, name: string) => {
      const value = vars[name]
      return value !== undefined ? String(value) : `{${name}}`
    })
  }

  function createHost(options: {
    frontmatter: FrontmatterMap
    files: TFile[]
    nonRoutineFiles?: TFile[]
    navigationContent?: HTMLElement
  }): NavigationRoutineHost & {
    navigationContent: HTMLElement
    reloadTasksAndRestore: jest.Mock
    showRoutineEditModal: jest.Mock
  } {
    const navigationContent = options.navigationContent ?? document.createElement('div')
    const frontmatter = options.frontmatter
    const files = [...options.files, ...(options.nonRoutineFiles ?? [])]

    return {
      tv: (key, fallback, vars) => translate(key, fallback, vars),
      app: {
        vault: {
          getMarkdownFiles: jest.fn(() => files),
        },
        metadataCache: {
          getFileCache: jest.fn((file: TFile) => {
            const data = frontmatter.get(file)
            return data ? { frontmatter: data } : undefined
          }),
        },
        fileManager: {
          processFrontMatter: jest.fn(async (file: TFile, updater: (fm: Record<string, unknown>) => Record<string, unknown>) => {
            const data = frontmatter.get(file) ?? {}
            const updated = updater({ ...data })
            frontmatter.set(file, updated)
          }),
        },
      } as unknown as NavigationRoutineHost['app'],
      plugin: {
        pathManager: {
          getTaskFolderPath: () => 'TASKS',
        },
      } as NavigationRoutineHost['plugin'],
      navigationContent,
      reloadTasksAndRestore: jest.fn(),
      showRoutineEditModal: jest.fn(),
      getWeekdayNames: () => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ensurePrototypeAugmentations()
  })

  it('renders routine list with localized header and task rows', async () => {
    const routineFile = createMockTFile('TASKS/routine.md')
    const nonRoutineFile = createMockTFile('TASKS/other.md')
    const frontmatter: FrontmatterMap = new Map([
      [routineFile, { isRoutine: true, routine_type: 'weekly', routine_weekday: 1, routine_interval: 1 }],
      [nonRoutineFile, { isRoutine: false }],
    ])

    const host = createHost({ frontmatter, files: [routineFile], nonRoutineFiles: [nonRoutineFile] })
    const controller = new NavigationRoutineController(host)

    await controller.renderRoutineList()

    const header = host.navigationContent.querySelector('.routine-list-header h3')
    const rows = host.navigationContent.querySelectorAll('.routine-row')
    expect(header?.textContent).toBe('Routine list')
    expect(rows.length).toBe(1)
    const badge = rows[0].querySelector('.routine-type-badge')
    expect(badge?.textContent).toBe('Every 1 week(s) on Mon')
  })

  it('toggles routine state via processFrontMatter and reloads tasks', async () => {
    const routineFile = createMockTFile('TASKS/routine.md')
    const frontmatter: FrontmatterMap = new Map([
      [routineFile, { isRoutine: true, routine_type: 'daily', routine_interval: 1, routine_enabled: true }],
    ])

    const host = createHost({ frontmatter, files: [routineFile] })
    const controller = new NavigationRoutineController(host)

    await controller.renderRoutineList()

    const toggle = host.navigationContent.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(toggle).not.toBeNull()
    if (!toggle) throw new Error('toggle not found')

    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(host.app.fileManager.processFrontMatter).toHaveBeenCalledTimes(1)
    expect(frontmatter.get(routineFile)?.routine_enabled).toBe(false)
    expect(host.reloadTasksAndRestore).toHaveBeenCalledWith({ runBoundaryCheck: true })
    expect(NoticeMock).toHaveBeenCalledWith('Routine disabled')
  })

  it('opens routine edit modal when edit button is clicked', async () => {
    const routineFile = createMockTFile('TASKS/routine.md')
    const frontmatter: FrontmatterMap = new Map([
      [routineFile, { isRoutine: true, displayTitle: 'My Routine' }],
    ])

    const host = createHost({ frontmatter, files: [routineFile] })
    const controller = new NavigationRoutineController(host)

    await controller.renderRoutineList()

    const editButton = host.navigationContent.querySelector<HTMLButtonElement>('.routine-edit-btn')
    expect(editButton).not.toBeNull()
    if (!editButton) throw new Error('edit button not found')

    editButton.click()

    expect(host.showRoutineEditModal).toHaveBeenCalledTimes(1)
    const [taskArg, elementArg] = host.showRoutineEditModal.mock.calls[0] as [RoutineTaskShape, HTMLElement]
    expect(taskArg.displayTitle).toBe('My Routine')
    expect(elementArg).toBe(editButton)
  })
})
