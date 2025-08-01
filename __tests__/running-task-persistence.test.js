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

describe("Running Task Persistence", () => {
  let taskChuteView
  let mockApp
  let mockLeaf
  let mockVaultAdapter

  beforeEach(() => {
    // ファイルシステムのモック
    const mockFileSystem = {}

    mockVaultAdapter = {
      exists: jest.fn((path) => Promise.resolve(!!mockFileSystem[path])),
      read: jest.fn((path) => Promise.resolve(mockFileSystem[path] || "")),
      write: jest.fn((path, content) => {
        mockFileSystem[path] = content
        return Promise.resolve()
      }),
      createFolder: jest.fn(() => Promise.resolve()),
    }

    // モックアプリケーションの設定
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        create: jest.fn(),
        modify: jest.fn(),
        getAbstractFileByPath: jest.fn(),
        adapter: mockVaultAdapter,
        createFolder: jest.fn(),
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
    taskChuteView.currentDate = new Date("2025-07-08")

    // renderTaskListとmanageTimersをモック化
    taskChuteView.renderTaskList = jest.fn()
    taskChuteView.manageTimers = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe("Running Task State Save/Restore", () => {
    test("should save routine task running state correctly", async () => {
      // ルーチンタスクのセットアップ
      const routineTask = {
        id: "routine-task-1",
        title: "朝のルーチン",
        description: "毎朝のタスク",
        path: "Tasks/朝のルーチン.md",
        isRoutine: true,
        file: { path: "Tasks/朝のルーチン.md" },
      }

      const routineInstance = {
        task: routineTask,
        slotKey: "09:00-12:00",
        state: "running",
        startTime: new Date("2025-07-08T01:00:00.000Z"),
        stopTime: null,
      }

      taskChuteView.taskInstances = [routineInstance]

      // 保存実行
      await taskChuteView.saveRunningTasksState()

      // 保存データの確認
      const savedData = JSON.parse(
        await mockVaultAdapter.read(
          "TaskChute/Log/running-task.json",
        ),
      )

      expect(savedData).toHaveLength(1)
      expect(savedData[0]).toMatchObject({
        date: "2025-07-08",
        taskTitle: "朝のルーチン",
        taskPath: "Tasks/朝のルーチン.md",
        startTime: "2025-07-08T01:00:00.000Z",
        taskDescription: "毎朝のタスク",
        slotKey: "09:00-12:00",
        isRoutine: true,
        taskId: "routine-task-1",
      })
    })

    test("should save non-routine task running state correctly", async () => {
      // 非ルーチンタスクのセットアップ
      const nonRoutineTask = {
        id: "temp-task-1",
        title: "一時的なタスク",
        description: "今日だけのタスク",
        path: null, // 非ルーチンタスクはpathがない
        isRoutine: false,
        file: null,
      }

      const nonRoutineInstance = {
        task: nonRoutineTask,
        slotKey: "13:00-16:00",
        state: "running",
        startTime: new Date("2025-07-08T04:30:00.000Z"),
        stopTime: null,
      }

      taskChuteView.taskInstances = [nonRoutineInstance]

      // 保存実行
      await taskChuteView.saveRunningTasksState()

      // 保存データの確認
      const savedData = JSON.parse(
        await mockVaultAdapter.read(
          "TaskChute/Log/running-task.json",
        ),
      )

      expect(savedData).toHaveLength(1)
      expect(savedData[0]).toMatchObject({
        date: "2025-07-08",
        taskTitle: "一時的なタスク",
        taskPath: null,
        startTime: "2025-07-08T04:30:00.000Z",
        taskDescription: "今日だけのタスク",
        slotKey: "13:00-16:00",
        isRoutine: false,
        taskId: "temp-task-1",
      })
    })

    test("should restore routine task running state correctly", async () => {
      // 保存されたデータを準備
      const savedData = [
        {
          date: "2025-07-08",
          taskTitle: "朝のルーチン",
          taskPath: "Tasks/朝のルーチン.md",
          startTime: "2025-07-08T01:00:00.000Z",
          taskDescription: "毎朝のタスク",
          slotKey: "09:00-12:00",
          isRoutine: true,
          taskId: "routine-task-1",
        },
      ]

      // 保存データをファイルシステムに配置
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify(savedData),
      )

      // 既存のタスクインスタンス（復元前の状態）
      const existingTask = {
        id: "routine-task-1",
        title: "朝のルーチン",
        description: "毎朝のタスク",
        path: "Tasks/朝のルーチン.md",
        isRoutine: true,
        file: { path: "Tasks/朝のルーチン.md" },
      }

      const existingInstance = {
        task: existingTask,
        slotKey: "09:00-12:00",
        state: "idle",
        startTime: null,
        stopTime: null,
      }

      taskChuteView.taskInstances = [existingInstance]

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 復元後の状態確認
      expect(taskChuteView.taskInstances).toHaveLength(1)
      expect(taskChuteView.taskInstances[0].state).toBe("running")
      expect(taskChuteView.taskInstances[0].startTime).toEqual(
        new Date("2025-07-08T01:00:00.000Z"),
      )
      expect(taskChuteView.taskInstances[0].stopTime).toBeNull()
      expect(taskChuteView.renderTaskList).toHaveBeenCalled()
      expect(taskChuteView.manageTimers).toHaveBeenCalled()
    })

    test("should restore non-routine task running state by recreating task instance", async () => {
      // 保存されたデータを準備（非ルーチンタスク）
      const savedData = [
        {
          date: "2025-07-08",
          taskTitle: "一時的なタスク",
          taskPath: null,
          startTime: "2025-07-08T04:30:00.000Z",
          taskDescription: "今日だけのタスク",
          slotKey: "13:00-16:00",
          isRoutine: false,
          taskId: "temp-task-1",
        },
      ]

      // 保存データをファイルシステムに配置
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify(savedData),
      )

      // 初期状態：タスクインスタンスが存在しない（再起動後を想定）
      taskChuteView.taskInstances = []

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 復元後の状態確認
      expect(taskChuteView.taskInstances).toHaveLength(1)

      const restoredInstance = taskChuteView.taskInstances[0]
      expect(restoredInstance.state).toBe("running")
      expect(restoredInstance.startTime).toEqual(
        new Date("2025-07-08T04:30:00.000Z"),
      )
      expect(restoredInstance.stopTime).toBeNull()
      expect(restoredInstance.slotKey).toBe("13:00-16:00")

      // 再作成されたタスクの確認
      expect(restoredInstance.task.title).toBe("一時的なタスク")
      expect(restoredInstance.task.description).toBe("今日だけのタスク")
      expect(restoredInstance.task.path).toBeNull()
      expect(restoredInstance.task.isRoutine).toBe(false)
      expect(restoredInstance.task.id).toBe("temp-task-1")

      expect(taskChuteView.renderTaskList).toHaveBeenCalled()
      expect(taskChuteView.manageTimers).toHaveBeenCalled()
    })

    test("should restore routine task running state by recreating task instance when not found", async () => {
      // 保存されたデータを準備（ルーチンタスクだが、現在のタスクリストに存在しない）
      const savedData = [
        {
          date: "2025-07-08",
          taskTitle: "見つからないルーチン",
          taskPath: "Tasks/見つからないルーチン.md",
          startTime: "2025-07-08T02:00:00.000Z",
          taskDescription: "存在しないタスク",
          slotKey: "10:00-12:00",
          isRoutine: true,
          taskId: "missing-routine-task",
        },
      ]

      // 保存データをファイルシステムに配置
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify(savedData),
      )

      // 初期状態：該当するタスクインスタンスが存在しない
      taskChuteView.taskInstances = []

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 復元後の状態確認
      expect(taskChuteView.taskInstances).toHaveLength(1)

      const restoredInstance = taskChuteView.taskInstances[0]
      expect(restoredInstance.state).toBe("running")
      expect(restoredInstance.startTime).toEqual(
        new Date("2025-07-08T02:00:00.000Z"),
      )
      expect(restoredInstance.stopTime).toBeNull()
      expect(restoredInstance.slotKey).toBe("10:00-12:00")

      // 再作成されたタスクの確認
      expect(restoredInstance.task.title).toBe("見つからないルーチン")
      expect(restoredInstance.task.description).toBe("存在しないタスク")
      expect(restoredInstance.task.path).toBe("Tasks/見つからないルーチン.md")
      expect(restoredInstance.task.isRoutine).toBe(true)
      expect(restoredInstance.task.id).toBe("missing-routine-task")

      expect(taskChuteView.renderTaskList).toHaveBeenCalled()
      expect(taskChuteView.manageTimers).toHaveBeenCalled()
    })

    test("should not restore tasks from different dates", async () => {
      // 異なる日付の保存データを準備
      const savedData = [
        {
          date: "2025-07-07", // 前日のデータ
          taskTitle: "昨日のタスク",
          taskPath: "Tasks/昨日のタスク.md",
          startTime: "2025-07-07T01:00:00.000Z",
          taskDescription: "昨日のタスク",
          slotKey: "09:00-12:00",
          isRoutine: true,
          taskId: "yesterday-task",
        },
        {
          date: "2025-07-08", // 今日のデータ
          taskTitle: "今日のタスク",
          taskPath: "Tasks/今日のタスク.md",
          startTime: "2025-07-08T01:00:00.000Z",
          taskDescription: "今日のタスク",
          slotKey: "13:00-16:00",
          isRoutine: true,
          taskId: "today-task",
        },
      ]

      // 保存データをファイルシステムに配置
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify(savedData),
      )

      // 初期状態：タスクインスタンスが存在しない
      taskChuteView.taskInstances = []

      // 復元実行（currentDateは2025-07-08）
      await taskChuteView.restoreRunningTaskState()

      // 今日のタスクのみ復元されることを確認
      expect(taskChuteView.taskInstances).toHaveLength(1)
      expect(taskChuteView.taskInstances[0].task.title).toBe("今日のタスク")
      expect(taskChuteView.taskInstances[0].task.id).toBe("today-task")
    })

    test("should handle empty running task data gracefully", async () => {
      // 空のデータを準備
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify([]),
      )

      taskChuteView.taskInstances = []

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 何も復元されないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.renderTaskList).not.toHaveBeenCalled()
      expect(taskChuteView.manageTimers).not.toHaveBeenCalled()
    })

    test("should handle missing running task file gracefully", async () => {
      // ファイルが存在しない状態
      taskChuteView.taskInstances = []

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 何も復元されないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
      expect(taskChuteView.renderTaskList).not.toHaveBeenCalled()
      expect(taskChuteView.manageTimers).not.toHaveBeenCalled()
    })

    test("should handle multiple running tasks correctly", async () => {
      // 複数の実行中タスクを準備
      const routineTask = {
        id: "routine-1",
        title: "ルーチンタスク",
        description: "ルーチン",
        path: "Tasks/ルーチンタスク.md",
        isRoutine: true,
        file: { path: "Tasks/ルーチンタスク.md" },
      }

      const nonRoutineTask = {
        id: "temp-1",
        title: "一時タスク",
        description: "一時的",
        path: null,
        isRoutine: false,
        file: null,
      }

      const routineInstance = {
        task: routineTask,
        slotKey: "09:00-12:00",
        state: "running",
        startTime: new Date("2025-07-08T01:00:00.000Z"),
        stopTime: null,
      }

      const nonRoutineInstance = {
        task: nonRoutineTask,
        slotKey: "13:00-16:00",
        state: "running",
        startTime: new Date("2025-07-08T04:30:00.000Z"),
        stopTime: null,
      }

      taskChuteView.taskInstances = [routineInstance, nonRoutineInstance]

      // 保存実行
      await taskChuteView.saveRunningTasksState()

      // 保存データの確認
      const savedData = JSON.parse(
        await mockVaultAdapter.read(
          "TaskChute/Log/running-task.json",
        ),
      )

      expect(savedData).toHaveLength(2)
      expect(savedData[0].taskTitle).toBe("ルーチンタスク")
      expect(savedData[1].taskTitle).toBe("一時タスク")

      // 復元テスト用にタスクインスタンスをクリア
      taskChuteView.taskInstances = []

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 両方のタスクが復元されることを確認
      expect(taskChuteView.taskInstances).toHaveLength(2)

      const restoredRoutine = taskChuteView.taskInstances.find(
        (inst) => inst.task.title === "ルーチンタスク",
      )
      const restoredNonRoutine = taskChuteView.taskInstances.find(
        (inst) => inst.task.title === "一時タスク",
      )

      expect(restoredRoutine).toBeDefined()
      expect(restoredRoutine.state).toBe("running")
      expect(restoredRoutine.task.path).toBe("Tasks/ルーチンタスク.md")

      expect(restoredNonRoutine).toBeDefined()
      expect(restoredNonRoutine.state).toBe("running")
      expect(restoredNonRoutine.task.path).toBeNull()
    })
  })

  describe("Edge Cases", () => {
    test("should handle corrupted JSON data gracefully", async () => {
      // 破損したJSONデータを準備
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        "{ invalid json",
      )

      taskChuteView.taskInstances = []

      // 復元実行（エラーが発生しないことを確認）
      await expect(
        taskChuteView.restoreRunningTaskState(),
      ).resolves.not.toThrow()

      // 何も復元されないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
    })

    test("should handle non-array data gracefully", async () => {
      // 配列でないデータを準備
      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify({ not: "an array" }),
      )

      taskChuteView.taskInstances = []

      // 復元実行
      await taskChuteView.restoreRunningTaskState()

      // 何も復元されないことを確認
      expect(taskChuteView.taskInstances).toHaveLength(0)
    })

    test("should handle missing task properties gracefully", async () => {
      // 不完全なデータを準備
      const savedData = [
        {
          date: "2025-07-08",
          taskTitle: "不完全なタスク",
          // taskPath, startTime, 等が欠損
        },
      ]

      await mockVaultAdapter.write(
        "TaskChute/Log/running-task.json",
        JSON.stringify(savedData),
      )

      taskChuteView.taskInstances = []

      // 復元実行（エラーが発生しないことを確認）
      await expect(
        taskChuteView.restoreRunningTaskState(),
      ).resolves.not.toThrow()
    })
  })
})
