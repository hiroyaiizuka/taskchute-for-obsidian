const { Plugin, ItemView, WorkspaceLeaf, TFile, Notice } = require("obsidian")

// モック設定
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

// TaskChuteView クラスをインポート
const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

describe("Routine Task Deletion via Hotkey", () => {
  let taskChuteView
  let mockApp
  let mockLeaf

  beforeEach(() => {
    // モックアプリケーションの設定
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        create: jest.fn(),
        modify: jest.fn(),
        getAbstractFileByPath: jest.fn(),
        delete: jest.fn(),
        adapter: {
          getFullPath: jest.fn().mockReturnValue("/test/path"),
          exists: jest.fn().mockReturnValue(false),
          write: jest.fn(),
          read: jest.fn(),
        },
      },
      workspace: {
        openLinkText: jest.fn(),
        getLeavesOfType: jest.fn().mockReturnValue([]),
      },
      metadataCache: {
        getFileCache: jest.fn(),
      },
      fileManager: {
        processFrontMatter: jest.fn(),
      },
      plugins: {
        plugins: {
          "taskchute-plus": {
            settings: {
              enableCelebration: true,
              enableSound: true,
              enableFireworks: true,
              enableConfetti: true,
            },
          },
        },
      },
    }

    // モックリーフの設定
    mockLeaf = {
      containerEl: {
        children: [
          {},
          {
            empty: jest.fn(),
            createEl: jest.fn().mockReturnValue({
              empty: jest.fn(),
              createEl: jest.fn().mockReturnValue({
                addEventListener: jest.fn(),
                style: {},
                textContent: "",
                innerHTML: "",
                setAttribute: jest.fn(),
                getAttribute: jest.fn(),
                classList: {
                  add: jest.fn(),
                  remove: jest.fn(),
                  contains: jest.fn(),
                },
              }),
              addEventListener: jest.fn(),
              style: {},
              textContent: "",
              innerHTML: "",
            }),
          },
        ],
      },
    }

    // TaskChuteView インスタンスを作成
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = mockApp

    // 必要なプロパティを初期化
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    taskChuteView.isRunning = false
    taskChuteView.currentInstance = null
    taskChuteView.timerInterval = null
    taskChuteView.currentDate = new Date("2024-01-01")
    
    // taskListのモックを追加
    const mockEl = () => {
      const el = {
        addEventListener: jest.fn(),
        classList: { add: jest.fn(), remove: jest.fn() },
        style: {},
        textContent: "",
        innerHTML: "",
        setAttribute: jest.fn(),
        getAttribute: jest.fn(),
        appendChild: jest.fn(),
        remove: jest.fn(),
        querySelector: jest.fn(),
        insertBefore: jest.fn(),
      }
      el.createEl = jest.fn().mockImplementation(() => mockEl())
      return el
    }
    taskChuteView.taskList = {
      empty: jest.fn(),
      createEl: jest.fn().mockImplementation(() => mockEl()),
    }

    // renderTaskListのモック
    taskChuteView.renderTaskList = jest.fn()
    
    // showDeleteConfirmDialogのモック（常にtrueを返す）
    taskChuteView.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)
    
    // clearTaskSelectionのモック
    taskChuteView.clearTaskSelection = jest.fn()
    
    // deleteTaskLogsのモック
    taskChuteView.deleteTaskLogs = jest.fn().mockResolvedValue(undefined)
    
    // saveRunningTasksStateのモック
    taskChuteView.saveRunningTasksState = jest.fn().mockResolvedValue(undefined)
    
    // 削除関連のメソッドのモック
    taskChuteView.getDeletedInstances = jest.fn().mockReturnValue([])
    taskChuteView.saveDeletedInstances = jest.fn()
    taskChuteView.getHiddenRoutines = jest.fn().mockReturnValue([])
    taskChuteView.saveHiddenRoutines = jest.fn()
    taskChuteView.getDuplicatedInstances = jest.fn().mockReturnValue([])
    taskChuteView.generateInstanceId = jest.fn().mockImplementation(path => `instance-${path}`)
    
    // deleteNonRoutineTaskとdeleteRoutineTaskのモック
    taskChuteView.deleteNonRoutineTask = jest.fn().mockImplementation(async function(inst) {
      const samePathInstances = this.taskInstances.filter(
        i => i !== inst && i.task.path === inst.task.path
      )
      
      if (samePathInstances.length > 0) {
        // 複製インスタンスの削除
        this.taskInstances = this.taskInstances.filter((i) => i !== inst)
        new Notice(`「${inst.task.title}」を削除しました。`)
      } else {
        // 最後のインスタンス：ファイルも削除
        this.taskInstances = this.taskInstances.filter((i) => i !== inst)
        this.tasks = this.tasks.filter((t) => t.path !== inst.task.path)
        await mockApp.vault.delete(inst.task.file)
        await this.deleteTaskLogs(inst.task.path)
        if (inst.state === "running") {
          await this.saveRunningTasksState()
        }
        this.renderTaskList()
        new Notice(`「${inst.task.title}」を完全に削除しました。`)
      }
    })
    
    taskChuteView.deleteRoutineTask = jest.fn().mockImplementation(async function(inst) {
      this.taskInstances = this.taskInstances.filter((i) => i !== inst)
      await this.deleteTaskLogs(inst.task.path)
      if (inst.state === "running") {
        await this.saveRunningTasksState()
      }
      this.renderTaskList()
      new Notice(`「${inst.task.title}」を本日のリストから削除しました`)
    })

    // localStorageのモック
    const localStorageMock = {
      getItem: jest.fn().mockReturnValue("[]"),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    }
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true
    })
    global.localStorage = localStorageMock
  })

  afterEach(() => {
    jest.clearAllMocks()
    if (taskChuteView.timerInterval) {
      clearInterval(taskChuteView.timerInterval)
    }
  })

  describe("deleteSelectedTask with routine tasks", () => {
    test("should NOT delete routine task file when using hotkey (Control+D)", async () => {
      // ルーチンタスクを作成
      const mockRoutineTaskFile = {
        path: "TaskChute/Task/routine-task.md",
        basename: "routine-task",
        extension: "md",
      }

      const mockRoutineTask = {
        title: "routine-task",
        path: "TaskChute/Task/routine-task.md",
        file: mockRoutineTaskFile,
        isRoutine: true,
        scheduledTime: "09:00",
        slotKey: "8:00-12:00",
      }

      const mockRoutineInstance = {
        task: mockRoutineTask,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "8:00-12:00",
      }

      // 初期状態を設定
      taskChuteView.tasks = [mockRoutineTask]
      taskChuteView.taskInstances = [mockRoutineInstance]
      taskChuteView.selectedTaskInstance = mockRoutineInstance

      // deleteSelectedTaskを実行
      await taskChuteView.deleteSelectedTask()

      // ファイルが削除されていないことを確認
      expect(mockApp.vault.delete).not.toHaveBeenCalled()

      // インスタンスがtaskInstancesから削除されたことを確認
      expect(taskChuteView.taskInstances).not.toContain(mockRoutineInstance)

      // deleteRoutineTaskが呼ばれたことを確認
      expect(taskChuteView.deleteRoutineTask).toHaveBeenCalledWith(mockRoutineInstance)

      // タスクログが削除されたことを確認
      expect(taskChuteView.deleteTaskLogs).toHaveBeenCalledWith(mockRoutineTask.path)

      // UIが更新されたことを確認
      expect(taskChuteView.renderTaskList).toHaveBeenCalled()

      // 通知が表示されたことを確認
      expect(Notice).toHaveBeenCalledWith("「routine-task」を本日のリストから削除しました")
    })

    test("should delete non-routine task file when using hotkey", async () => {
      // 通常タスクを作成
      const mockNormalTaskFile = {
        path: "TaskChute/Task/normal-task.md",
        basename: "normal-task",
        extension: "md",
      }

      const mockNormalTask = {
        title: "normal-task",
        path: "TaskChute/Task/normal-task.md",
        file: mockNormalTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const mockNormalInstance = {
        task: mockNormalTask,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "none",
      }

      // 初期状態を設定
      taskChuteView.tasks = [mockNormalTask]
      taskChuteView.taskInstances = [mockNormalInstance]
      taskChuteView.selectedTaskInstance = mockNormalInstance

      // deleteSelectedTaskを実行
      await taskChuteView.deleteSelectedTask()

      // ファイルが削除されることを確認（修正後は非ルーチンタスクは完全削除）
      expect(mockApp.vault.delete).toHaveBeenCalledWith(mockNormalTaskFile)

      // インスタンスが削除されたことを確認（修正後はtasksも削除される）
      expect(taskChuteView.taskInstances).not.toContain(mockNormalInstance)
      expect(taskChuteView.tasks).not.toContain(mockNormalTask)

      // タスクログが削除されたことを確認
      expect(taskChuteView.deleteTaskLogs).toHaveBeenCalledWith(mockNormalTask.path)

      // UIが更新されたことを確認
      expect(taskChuteView.renderTaskList).toHaveBeenCalled()

      // 通知が表示されたことを確認（修正後は完全削除メッセージ）
      expect(Notice).toHaveBeenCalledWith("「normal-task」を完全に削除しました。")
    })

    test("should handle running routine task deletion properly", async () => {
      // 実行中のルーチンタスクを作成
      const mockRunningRoutineTaskFile = {
        path: "TaskChute/Task/running-routine-task.md",
        basename: "running-routine-task",
        extension: "md",
      }

      const mockRunningRoutineTask = {
        title: "running-routine-task",
        path: "TaskChute/Task/running-routine-task.md",
        file: mockRunningRoutineTaskFile,
        isRoutine: true,
        scheduledTime: "10:00",
        slotKey: "8:00-12:00",
      }

      const mockRunningRoutineInstance = {
        task: mockRunningRoutineTask,
        state: "running",
        startTime: new Date("2024-01-01T10:00:00"),
        stopTime: null,
        slotKey: "8:00-12:00",
      }

      // 初期状態を設定
      taskChuteView.tasks = [mockRunningRoutineTask]
      taskChuteView.taskInstances = [mockRunningRoutineInstance]
      taskChuteView.selectedTaskInstance = mockRunningRoutineInstance

      // deleteSelectedTaskを実行
      await taskChuteView.deleteSelectedTask()

      // ファイルが削除されていないことを確認
      expect(mockApp.vault.delete).not.toHaveBeenCalled()

      // 実行中タスクの状態が保存されたことを確認
      expect(taskChuteView.saveRunningTasksState).toHaveBeenCalled()

      // インスタンスが削除されたことを確認
      expect(taskChuteView.taskInstances).not.toContain(mockRunningRoutineInstance)

      // deleteRoutineTaskが呼ばれたことを確認
      expect(taskChuteView.deleteRoutineTask).toHaveBeenCalledWith(mockRunningRoutineInstance)
    })
  })
})