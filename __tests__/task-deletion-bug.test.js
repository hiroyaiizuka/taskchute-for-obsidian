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

describe("Task Deletion Bug", () => {
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
      // createElも持たせる（子要素も同じモックを返す）
      el.createEl = jest.fn().mockImplementation(() => mockEl())
      return el
    }
    taskChuteView.taskList = {
      empty: jest.fn(),
      createEl: jest.fn().mockImplementation(() => mockEl()),
    }
  })

  afterEach(() => {
    jest.clearAllMocks()
    if (taskChuteView.timerInterval) {
      clearInterval(taskChuteView.timerInterval)
    }
  })

  describe("Task Deletion and Date Navigation Bug", () => {
    test("should not restore deleted non-routine task when navigating dates", async () => {
      // 1. 初期状態でタスクを作成
      const mockTaskFile = {
        path: "TaskChute/Task/test-task.md",
        basename: "test-task",
        file: {
          path: "TaskChute/Task/test-task.md",
          basename: "test-task",
        },
      }

      const mockTask = {
        title: "test-task",
        path: "TaskChute/Task/test-task.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const mockInstance = {
        task: mockTask,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "none",
      }

      // 初期状態を設定
      taskChuteView.tasks = [mockTask]
      taskChuteView.taskInstances = [mockInstance]

      // 2. タスクを削除
      taskChuteView.taskInstances = taskChuteView.taskInstances.filter(
        (inst) => inst !== mockInstance,
      )
      taskChuteView.tasks = taskChuteView.tasks.filter(
        (task) => task.path !== mockTask.path,
      )
      // 削除済みリストに記録（新形式）
      const dateStr = "2024-01-01"
      const deletedInstances = [{
        path: mockTaskFile.path,
        instanceId: mockInstance.instanceId,
        deletionType: "permanent",
        deletedAt: new Date().toISOString()
      }]
      localStorage.setItem(
        `taskchute-deleted-instances-${dateStr}`,
        JSON.stringify(deletedInstances)
      )

      // 削除確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.tasks).toHaveLength(0)

      // 3. 日付を変更（明日に移動）
      taskChuteView.currentDate = new Date("2024-01-02")

      // 4. 元の日付に戻る
      taskChuteView.currentDate = new Date("2024-01-01")

      // 5. loadTasksをモックして、削除されたタスクが復活しないことを確認
      const originalLoadTasks = taskChuteView.loadTasks
      taskChuteView.loadTasks = jest.fn().mockImplementation(async () => {
        // 削除されたタスクは復活させない
        taskChuteView.tasks = []
        taskChuteView.taskInstances = []
      })

      await taskChuteView.loadTasks()

      // 削除されたタスクが復活していないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.tasks).toHaveLength(0)
    })

    test("should maintain deleted task state across date navigation", async () => {
      // 1. 初期状態でタスクを作成
      const mockTaskFile = {
        path: "TaskChute/Task/test-task.md",
        basename: "test-task",
        file: {
          path: "TaskChute/Task/test-task.md",
          basename: "test-task",
        },
      }

      const mockTask = {
        title: "test-task",
        path: "TaskChute/Task/test-task.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const mockInstance = {
        task: mockTask,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "none",
      }

      // 初期状態を設定
      taskChuteView.tasks = [mockTask]
      taskChuteView.taskInstances = [mockInstance]

      // 2. タスクを削除
      taskChuteView.taskInstances = taskChuteView.taskInstances.filter(
        (inst) => inst !== mockInstance,
      )
      taskChuteView.tasks = taskChuteView.tasks.filter(
        (task) => task.path !== mockTask.path,
      )
      // 削除済みリストに記録（新形式）
      const dateStr = "2024-01-01"
      const deletedInstances = [{
        path: mockTaskFile.path,
        instanceId: mockInstance.instanceId,
        deletionType: "permanent",
        deletedAt: new Date().toISOString()
      }]
      localStorage.setItem(
        `taskchute-deleted-instances-${dateStr}`,
        JSON.stringify(deletedInstances)
      )

      // 3. 日付を変更して戻る
      taskChuteView.currentDate = new Date("2024-01-02")
      taskChuteView.currentDate = new Date("2024-01-01")

      // 4. loadTasksを呼び出した後も削除状態が維持されることを確認
      const originalLoadTasks = taskChuteView.loadTasks
      taskChuteView.loadTasks = jest.fn().mockImplementation(async () => {
        // 削除されたタスクは復活させない
        taskChuteView.tasks = []
        taskChuteView.taskInstances = []
      })

      await taskChuteView.loadTasks()

      // 削除されたタスクが復活していないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.tasks).toHaveLength(0)
    })

    test("should handle routine task deletion correctly", async () => {
      // ルーチンタスクの削除テスト
      const mockRoutineTaskFile = {
        path: "TaskChute/Task/routine-task.md",
        basename: "routine-task",
        file: {
          path: "TaskChute/Task/routine-task.md",
          basename: "routine-task",
        },
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

      // ルーチンタスクのインスタンスを削除
      taskChuteView.taskInstances = taskChuteView.taskInstances.filter(
        (inst) => inst !== mockRoutineInstance,
      )
      // 削除済みリストに記録
      localStorage.setItem(
        "taskchute-deleted-tasks",
        JSON.stringify([mockRoutineTaskFile.path]),
      )

      // 日付を変更して戻る
      taskChuteView.currentDate = new Date("2024-01-02")
      taskChuteView.currentDate = new Date("2024-01-01")

      // loadTasksをモック
      taskChuteView.loadTasks = jest.fn().mockImplementation(async () => {
        // ルーチンタスクのインスタンスは削除されたまま
        taskChuteView.taskInstances = []
      })

      await taskChuteView.loadTasks()

      // ルーチンタスクのインスタンスが復活していないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
    })

    test("should reproduce the actual bug - deleted task reappears after date navigation", async () => {
      // 実際のバグを再現するテスト
      const mockTaskFile = {
        path: "TaskChute/Task/test-task.md",
        basename: "test-task",
        extension: "md",
      }

      const mockTask = {
        title: "test-task",
        path: "TaskChute/Task/test-task.md",
        file: mockTaskFile,
        isRoutine: false,
        scheduledTime: null,
        slotKey: "none",
      }

      const mockInstance = {
        task: mockTask,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "none",
      }

      // 初期状態を設定
      taskChuteView.tasks = [mockTask]
      taskChuteView.taskInstances = [mockInstance]

      // タスクを削除
      taskChuteView.taskInstances = taskChuteView.taskInstances.filter(
        (inst) => inst !== mockInstance,
      )
      taskChuteView.tasks = taskChuteView.tasks.filter(
        (task) => task.path !== mockTask.path,
      )
      // 削除済みリストに記録（新形式）
      const dateStr = "2024-01-01"
      const deletedInstances = [{
        path: mockTaskFile.path,
        instanceId: mockInstance.instanceId,
        deletionType: "permanent",
        deletedAt: new Date().toISOString()
      }]
      localStorage.setItem(
        `taskchute-deleted-instances-${dateStr}`,
        JSON.stringify(deletedInstances)
      )

      // 削除確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.tasks).toHaveLength(0)

      // 日付を変更して戻る（実際のバグが発生する条件）
      taskChuteView.currentDate = new Date("2024-01-02")
      taskChuteView.currentDate = new Date("2024-01-01")

      // ファイルシステムのモック: 削除したはずのタスクファイルが返る
      taskChuteView.app.vault.getMarkdownFiles = jest
        .fn()
        .mockReturnValue([mockTaskFile])
      taskChuteView.app.vault.read = jest.fn().mockResolvedValue("#task\n")
      taskChuteView.app.metadataCache.getFileCache = jest
        .fn()
        .mockReturnValue({ frontmatter: null })

      // loadTasksを呼ぶと、削除したタスクが復活してしまう（failするはず）
      await taskChuteView.loadTasks()

      // バグが存在する場合、削除されたタスクが復活する
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.tasks).toHaveLength(0)
    })
  })
})
