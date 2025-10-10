import ProjectController from '../../../src/ui/project/ProjectController'
import { TaskChutePluginLike, TaskData, TaskInstance } from '../../../src/types'
import ProjectSettingsModal from '../../../src/ui/modals/ProjectSettingsModal'
import { TFile } from 'obsidian'

jest.mock('../../../src/ui/modals/ProjectSettingsModal', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      open: jest.fn(),
      close: jest.fn(),
    })),
  }
})

const MockedProjectSettingsModal = ProjectSettingsModal as jest.MockedClass<typeof ProjectSettingsModal>

describe('ProjectController', () => {
  function attachCreateEl(target: HTMLElement): void {
    const typed = target as HTMLElement & {
      createEl?: (tag: string, options?: Record<string, unknown>) => HTMLElement
      empty?: () => void
    }
    typed.createEl = function (this: HTMLElement, tag: string, options: Record<string, unknown> = {}) {
      const el = document.createElement(tag)
      if (options.cls) el.className = options.cls as string
      if (options.text) el.textContent = options.text as string
      if (options.attr) {
        Object.entries(options.attr as Record<string, string>).forEach(([key, value]) => {
          el.setAttribute(key, value)
        })
      }
      attachCreateEl(el)
      this.appendChild(el)
      return el
    }
    typed.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild)
      }
    }
  }

  function createController(overrides: Partial<TaskData> = {}) {
    const projectFolder = 'PROJ'
    const taskList = document.createElement('div')
    attachCreateEl(taskList)

    const app = {
      vault: {
        getMarkdownFiles: jest.fn(() => [] as TFile[]),
        getAbstractFileByPath: jest.fn(() => null),
      },
      metadataCache: {
        getFileCache: jest.fn(() => undefined),
      },
      fileManager: {
        processFrontMatter: jest.fn(),
        trashFile: jest.fn(),
      },
      workspace: {
        getLeaf: jest.fn(() => ({ openFile: jest.fn() })),
        splitActiveLeaf: jest.fn(() => ({ openFile: jest.fn() })),
        setActiveLeaf: jest.fn(),
      },
      setting: {
        open: jest.fn(),
        openTabById: jest.fn(),
      },
    }

    const plugin = {
      settings: {
        projectsFolder: projectFolder,
        projectsFilterEnabled: false,
        projectsFilter: {},
        trimPrefixesInUI: true,
      },
      pathManager: {
        getProjectFolderPath: () => projectFolder,
        getTaskFolderPath: () => 'TASKS',
        getLogDataPath: () => 'LOGS',
        getReviewDataPath: () => 'REVIEWS',
        ensureFolderExists: jest.fn(),
        ensureYearFolder: jest.fn(),
        validatePath: jest.fn(() => ({ valid: true })),
      },
      manifest: { id: 'taskchute-plus' },
      app,
      routineAliasService: {
        loadAliases: jest.fn(),
      },
      dayStateService: {
        loadDay: jest.fn(),
        saveDay: jest.fn(),
        mergeDayState: jest.fn(),
        clearCache: jest.fn(),
        getDateFromKey: jest.fn(),
      },
      saveSettings: jest.fn(),
    } as unknown as TaskChutePluginLike

    const controllerOptions = {
      app,
      plugin,
      tv: (_key: string, fallback: string, vars?: Record<string, string>) => {
        if (vars && vars.title && fallback.includes('{title}')) {
          return fallback.replace('{title}', vars.title)
        }
        return fallback
      },
      getInstanceDisplayTitle: () => 'Sample task',
      renderTaskList: jest.fn(),
      getTaskListElement: () => taskList,
      registerDisposer: jest.fn(),
    }

    const controller = new ProjectController(controllerOptions)

    const task: TaskData = {
      name: 'Sample',
      path: 'TASKS/sample.md',
      projectPath: overrides.projectPath,
      projectTitle: overrides.projectTitle,
      file: overrides.file,
    } as TaskData

    const inst: TaskInstance = {
      task,
      instanceId: 'inst-1',
      slotKey: 'none',
      state: 'idle',
    }

    const taskItem = document.createElement('div')
    attachCreateEl(taskItem)
    taskItem.setAttribute('data-task-path', task.path || '')
    const projectDisplay = document.createElement('div')
    attachCreateEl(projectDisplay)
    projectDisplay.className = 'taskchute-project-display'
    taskItem.appendChild(projectDisplay)
    taskList.appendChild(taskItem)

    return { controller, controllerOptions, inst, projectDisplay, app, plugin }
  }

  test('updateProjectDisplay renders assigned project button and link', () => {
    const { controller, inst, projectDisplay } = createController({
      projectPath: 'PROJ/Project - Alpha.md',
      projectTitle: 'Project - Alpha',
    })

    controller.updateProjectDisplay(inst)

    const button = projectDisplay.querySelector('.taskchute-project-button')
    const name = projectDisplay.querySelector('.taskchute-project-name')
    const link = projectDisplay.querySelector('.taskchute-external-link')

    expect(button).toBeTruthy()
    expect(name?.textContent).toBe('Alpha')
    expect(link).toBeTruthy()
  })

  test('updateProjectDisplay renders placeholder when project missing', () => {
    const { controller, inst, projectDisplay } = createController({ projectPath: undefined, projectTitle: undefined })

    controller.updateProjectDisplay(inst)

    const placeholder = projectDisplay.querySelector('.taskchute-project-placeholder')
    expect(placeholder).toBeTruthy()
    expect(placeholder?.textContent).toBe('Click to set project')
  })

  test('showProjectModal opens ProjectSettingsModal with project options', async () => {
    const { controller, controllerOptions, inst, app } = createController()
    const projectFile = new TFile()
    projectFile.path = 'PROJ/Project - Alpha.md'
    projectFile.basename = 'Project - Alpha'
    ;(app.vault.getMarkdownFiles as jest.Mock).mockReturnValue([projectFile])

    MockedProjectSettingsModal.mockClear()

    await controller.showProjectModal(inst)

    expect(MockedProjectSettingsModal).toHaveBeenCalledTimes(1)
    const [modalAppArg, modalOptions] = MockedProjectSettingsModal.mock.calls[0] as [
      unknown,
      {
        displayTitle: string
        projectFiles: TFile[]
        onSubmit?: (projectPath: string) => Promise<void> | void
      },
    ]
    expect(modalAppArg).toBe(app)
    expect(modalOptions.displayTitle).toBe('Sample task')
    expect(modalOptions.projectFiles).toHaveLength(1)

    const submitSpy = jest.spyOn(controller, 'setProjectForTask' as never)
    const updateSpy = jest.spyOn(controller, 'updateProjectDisplay' as never)

    await modalOptions.onSubmit?.(projectFile.path)

    expect(submitSpy).toHaveBeenCalledWith(inst.task, projectFile.path)
    expect(updateSpy).toHaveBeenCalledWith(inst)

    expect(controllerOptions.registerDisposer).toHaveBeenCalledTimes(1)
    const disposer = (controllerOptions.registerDisposer as jest.Mock).mock.calls[0][0] as () => void
    const instance = MockedProjectSettingsModal.mock.results[0]?.value as {
      open: jest.Mock
      close?: jest.Mock
    }
    expect(instance?.close?.mock.calls.length ?? 0).toBe(0)
    disposer()
    expect(instance?.close).toHaveBeenCalled()
  })
})
