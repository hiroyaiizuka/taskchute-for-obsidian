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

describe("Routine Task Deletion History Bug", () => {
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
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          list: jest.fn(),
          mkdir: jest.fn(),
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
    taskChuteView.currentDate = new Date("2025-08-03")

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

    // getCurrentDateStringのモック
    taskChuteView.getCurrentDateString = jest.fn().mockReturnValue("2025-08-03")

    // getHiddenRoutinesとsaveHiddenRoutinesのモック
    taskChuteView.getHiddenRoutines = jest.fn().mockReturnValue([])
    taskChuteView.saveHiddenRoutines = jest.fn()

    // renderTaskListのモック
    taskChuteView.renderTaskList = jest.fn()

    // saveRunningTasksStateのモック
    taskChuteView.saveRunningTasksState = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
    if (taskChuteView.timerInterval) {
      clearInterval(taskChuteView.timerInterval)
    }
  })

  describe("ルーチンタスク削除時の実行履歴バグ", () => {
    test("【修正後】ルーチンタスクを今日のリストから削除しても過去の実行履歴は保持される", async () => {
      const taskId = "TaskChute/Task/毎日のルーチンタスクA.md"

      // 過去の実行履歴を含むログデータを準備（上記と同じ）
      const augustTasksJson = {
        metadata: {
          version: "2.0",
          month: "2025-08",
          lastUpdated: "2025-08-02T23:59:59.999Z",
          totalDays: 31,
          activeDays: 2,
        },
        dailySummary: {
          "2025-08-01": {
            totalTasks: 3,
            completedTasks: 3,
            totalFocusTime: 1800,
            productivityScore: 0.9,
          },
          "2025-08-02": {
            totalTasks: 3,
            completedTasks: 3,
            totalFocusTime: 1800,
            productivityScore: 0.9,
          },
        },
        taskExecutions: {
          "2025-08-01": [
            {
              taskId: "TaskChute/Task/他のタスク.md",
              taskName: "他のタスク",
              taskType: "project",
              isCompleted: "2025-08-01T10:00:00.000Z",
            },
            {
              taskId: taskId,
              taskName: "毎日のルーチンタスクA",
              taskType: "routine",
              isCompleted: "2025-08-01T11:00:00.000Z",
              actualTime: 30,
              comment: "きちんと実行できた"
            },
            {
              taskId: "TaskChute/Task/別のタスク.md",
              taskName: "別のタスク",
              taskType: "project",
              isCompleted: "2025-08-01T12:00:00.000Z",
            },
          ],
          "2025-08-02": [
            {
              taskId: taskId,
              taskName: "毎日のルーチンタスクA",
              taskType: "routine",
              isCompleted: "2025-08-02T11:30:00.000Z",
              actualTime: 25,
              comment: "今日も完了"
            },
            {
              taskId: "TaskChute/Task/他のタスク2.md",
              taskName: "他のタスク2",
              taskType: "project",
              isCompleted: "2025-08-02T13:00:00.000Z",
            },
          ],
        },
      }

      // ログディレクトリの存在とファイルリストをモック
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        return path === "TaskChute/Log"
          ? Promise.resolve(true)
          : Promise.resolve(false)
      })

      mockApp.vault.adapter.list.mockResolvedValue({
        files: ["2025-08-tasks.json"],
        folders: [],
      })

      // ファイル読み込みのモック
      mockApp.vault.read.mockImplementation((path) => {
        if (path === "TaskChute/Log/2025-08-tasks.json") {
          return Promise.resolve(JSON.stringify(augustTasksJson))
        } else {
          return Promise.reject(new Error("File not found"))
        }
      })

      // ルーチンタスクのインスタンスを作成
      const routineTaskInstance = {
        task: {
          path: taskId,
          title: "毎日のルーチンタスクA",
          isRoutine: true,
          file: { path: taskId }
        },
        state: "idle",
        instanceId: null,
      }

      // deleteTaskLogsをスパイして呼ばれないことを確認
      const deleteTaskLogsSpy = jest.spyOn(taskChuteView, "deleteTaskLogs")

      // ルーチンタスクを削除（今日のリストから非表示）
      await taskChuteView.deleteRoutineTask(routineTaskInstance)

      // 期待動作の確認：deleteTaskLogsが呼ばれていない
      expect(deleteTaskLogsSpy).not.toHaveBeenCalled()

      // ログファイルへの書き込みが発生しないことを確認
      expect(mockApp.vault.modify).not.toHaveBeenCalled()

      // タスクインスタンスは削除されていることを確認
      expect(taskChuteView.taskInstances).not.toContain(routineTaskInstance)

      // 非表示リストに追加されていることを確認
      expect(taskChuteView.saveHiddenRoutines).toHaveBeenCalledWith(
        "2025-08-03",
        [{
          path: taskId,
          instanceId: null
        }]
      )

      deleteTaskLogsSpy.mockRestore()
    })
  })
})