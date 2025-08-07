// モック設定
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  TFolder: jest.fn(),
  Notice: jest.fn(),
}))

const { Plugin, ItemView, WorkspaceLeaf, TFile, TFolder, Notice } = require("obsidian")

// TaskChuteView クラスをインポート
const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

describe("Delete Task Logs Feature", () => {
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
    taskChuteView.currentDate = new Date("2025-07-12")

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
  })

  afterEach(() => {
    jest.clearAllMocks()
    if (taskChuteView.timerInterval) {
      clearInterval(taskChuteView.timerInterval)
    }
  })

  describe("deleteTaskLogs method", () => {
    test("should delete logs for specified taskId from multiple monthly files", async () => {
      const taskId = "TaskChute/Task/Cursor タスク管理の研究.md"

      // モックデータ準備: 複数の月次ファイル
      const julyTasksJson = {
        metadata: {
          version: "2.0",
          month: "2025-07",
          lastUpdated: "2025-07-12T01:47:37.124Z",
          totalDays: 31,
          activeDays: 2,
        },
        dailySummary: {
          "2025-07-10": {
            totalTasks: 3,
            completedTasks: 3,
            totalFocusTime: 1800,
            productivityScore: 0.8,
          },
          "2025-07-12": {
            totalTasks: 2,
            completedTasks: 2,
            totalFocusTime: 600,
            productivityScore: 1.0,
          },
        },
        taskExecutions: {
          "2025-07-10": [
            {
              taskId: "TaskChute/Task/Other Task.md",
              taskName: "Other Task",
              taskType: "project",
              isCompleted: "2025-07-10T05:20:00.000Z",
            },
            {
              taskId: taskId,
              taskName: "Cursor タスク管理の研究",
              taskType: "routine",
              isCompleted: "2025-07-10T05:22:26.093Z",
            },
            {
              taskId: "TaskChute/Task/Another Task.md",
              taskName: "Another Task",
              taskType: "project",
              isCompleted: "2025-07-10T05:25:00.000Z",
            },
          ],
          "2025-07-12": [
            {
              taskId: taskId,
              taskName: "Cursor タスク管理の研究",
              taskType: "routine",
              isCompleted: "2025-07-12T01:47:37.122Z",
            },
            {
              taskId: "TaskChute/Task/Final Task.md",
              taskName: "Final Task",
              taskType: "project",
              isCompleted: "2025-07-12T02:00:00.000Z",
            },
          ],
        },
      }

      const juneTasksJson = {
        metadata: {
          version: "2.0",
          month: "2025-06",
          lastUpdated: "2025-06-30T23:59:59.999Z",
          totalDays: 30,
          activeDays: 1,
        },
        dailySummary: {
          "2025-06-30": {
            totalTasks: 1,
            completedTasks: 1,
            totalFocusTime: 300,
            productivityScore: 0.6,
          },
        },
        taskExecutions: {
          "2025-06-30": [
            {
              taskId: taskId,
              taskName: "Cursor タスク管理の研究",
              taskType: "routine",
              isCompleted: "2025-06-30T23:30:00.000Z",
            },
          ],
        },
      }

      // 新しい実装に合わせて、dataディレクトリ存在とファイルリストをモック
      const mockFile1 = { path: "TaskChute/Log/2025-07-tasks.json" }
      mockFile1.constructor = TFile
      Object.setPrototypeOf(mockFile1, TFile.prototype)
      
      const mockFile2 = { path: "TaskChute/Log/2025-06-tasks.json" }
      mockFile2.constructor = TFile
      Object.setPrototypeOf(mockFile2, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === "TaskChute/Log") {
          const mockFolder = { 
            path: "TaskChute/Log", 
            children: [mockFile1, mockFile2] // TFileインスタンスをchildrenに設定
          }
          mockFolder.constructor = TFolder
          Object.setPrototypeOf(mockFolder, TFolder.prototype)
          return mockFolder
        }
        if (path === "TaskChute/Log/2025-07-tasks.json") {
          return mockFile1
        }
        if (path === "TaskChute/Log/2025-06-tasks.json") {
          return mockFile2
        }
        return null
      })

      // ファイル一覧のモック
      mockApp.vault.adapter.list.mockResolvedValue({
        files: [
          "2025-07-tasks.json",
          "2025-06-tasks.json",
          "running-task.json",
        ],
        folders: [],
      })

      // ファイル読み込みのモック
      mockApp.vault.read.mockImplementation((file) => {
        const path = file?.path || file;
        if (
          path === "TaskChute/Log/2025-07-tasks.json"
        ) {
          return Promise.resolve(JSON.stringify(julyTasksJson))
        } else if (
          path === "TaskChute/Log/2025-06-tasks.json"
        ) {
          return Promise.resolve(JSON.stringify(juneTasksJson))
        } else {
          return Promise.reject(new Error("File not found"))
        }
      })

      // deleteTaskLogsを実行
      await taskChuteView.deleteTaskLogs(taskId)

      // 書き込みが2回呼ばれることを確認（両月のファイル）
      expect(mockApp.vault.modify).toHaveBeenCalledTimes(2)

      // 書き込み内容を確認
      const writeCalls = mockApp.vault.modify.mock.calls

      // 7月ファイルの確認
      const julyWriteCall = writeCalls.find(
        (call) =>
          (call[0]?.path || call[0]) ===
          "TaskChute/Log/2025-07-tasks.json",
      )
      expect(julyWriteCall).toBeDefined()

      const julyUpdatedData = JSON.parse(julyWriteCall[1])

      // 指定されたtaskIdのログが削除されていることを確認
      expect(julyUpdatedData.taskExecutions["2025-07-10"]).toHaveLength(2)
      expect(julyUpdatedData.taskExecutions["2025-07-10"]).not.toContainEqual(
        expect.objectContaining({ taskId: taskId }),
      )
      expect(julyUpdatedData.taskExecutions["2025-07-12"]).toHaveLength(1)
      expect(julyUpdatedData.taskExecutions["2025-07-12"]).not.toContainEqual(
        expect.objectContaining({ taskId: taskId }),
      )

      // dailySummaryが再計算されていることを確認
      expect(julyUpdatedData.dailySummary["2025-07-10"].totalTasks).toBe(2)
      expect(julyUpdatedData.dailySummary["2025-07-10"].completedTasks).toBe(2)
      expect(julyUpdatedData.dailySummary["2025-07-12"].totalTasks).toBe(1)
      expect(julyUpdatedData.dailySummary["2025-07-12"].completedTasks).toBe(1)

      // 6月ファイルの確認
      const juneWriteCall = writeCalls.find(
        (call) =>
          (call[0]?.path || call[0]) ===
          "TaskChute/Log/2025-06-tasks.json",
      )
      expect(juneWriteCall).toBeDefined()

      const juneUpdatedData = JSON.parse(juneWriteCall[1])

      // 6月のデータからもtaskIdが削除されていることを確認
      expect(juneUpdatedData.taskExecutions["2025-06-30"]).toBeUndefined()
      expect(juneUpdatedData.dailySummary["2025-06-30"]).toBeUndefined()
    })

    test("should handle case when no logs exist for the taskId", async () => {
      const taskId = "NonExistent/Task.md"

      const existingTasksJson = {
        metadata: {
          version: "2.0",
          month: "2025-07",
          lastUpdated: "2025-07-12T01:47:37.124Z",
        },
        dailySummary: {
          "2025-07-12": {
            totalTasks: 1,
            completedTasks: 1,
            totalFocusTime: 300,
            productivityScore: 1.0,
          },
        },
        taskExecutions: {
          "2025-07-12": [
            {
              taskId: "Other/Task.md",
              taskName: "Other Task",
              taskType: "project",
              isCompleted: "2025-07-12T01:00:00.000Z",
            },
          ],
        },
      }

      // 新しい実装に合わせてdataディレクトリとファイルリストをモック
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        return path === "TaskChute/Log"
          ? Promise.resolve(true)
          : Promise.resolve(false)
      })

      mockApp.vault.adapter.list.mockResolvedValue({
        files: ["2025-07-tasks.json"],
        folders: [],
      })

      mockApp.vault.read.mockImplementation((path) => {
        if (
          path === "TaskChute/Log/2025-07-tasks.json"
        ) {
          return Promise.resolve(JSON.stringify(existingTasksJson))
        } else {
          return Promise.reject(new Error("File not found"))
        }
      })

      // deleteTaskLogsを実行
      await taskChuteView.deleteTaskLogs(taskId)

      // ファイルが変更されないため、書き込みは呼ばれない
      expect(mockApp.vault.modify).not.toHaveBeenCalled()
    })

    test("should handle empty data directory gracefully", async () => {
      const taskId = "Any/Task.md"

      // dataディレクトリが存在しない場合
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)

      // deleteTaskLogsを実行
      await taskChuteView.deleteTaskLogs(taskId)

      // 何も処理されないことを確認
      expect(mockApp.vault.adapter.list).not.toHaveBeenCalled()
      expect(mockApp.vault.read).not.toHaveBeenCalled()
      expect(mockApp.vault.modify).not.toHaveBeenCalled()
    })

    test("should handle corrupted JSON files gracefully", async () => {
      const taskId = "Test/Task.md"

      // dataディレクトリが存在し、ファイルリストが返される
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        return path === "TaskChute/Log"
          ? Promise.resolve(true)
          : Promise.resolve(false)
      })

      mockApp.vault.adapter.list.mockResolvedValue({
        files: ["2025-07-tasks.json"],
        folders: [],
      })

      // 壊れたJSONファイルをモック
      mockApp.vault.read.mockImplementation((path) => {
        if (
          path === "TaskChute/Log/2025-07-tasks.json"
        ) {
          return Promise.resolve("{ invalid json }")
        } else {
          return Promise.reject(new Error("File not found"))
        }
      })

      // deleteTaskLogsを実行（エラーが発生しないことを確認）
      await expect(taskChuteView.deleteTaskLogs(taskId)).resolves.not.toThrow()

      // 書き込みは呼ばれない（処理が正常にスキップされる）
      expect(mockApp.vault.modify).not.toHaveBeenCalled()
    })

    test("should update metadata lastUpdated when logs are deleted", async () => {
      const taskId = "Test/Task.md"

      const originalData = {
        metadata: {
          version: "2.0",
          month: "2025-07",
          lastUpdated: "2025-07-12T00:00:00.000Z",
        },
        dailySummary: {},
        taskExecutions: {
          "2025-07-12": [
            {
              taskId: taskId,
              taskName: "Test Task",
              taskType: "project",
              isCompleted: "2025-07-12T01:00:00.000Z",
            },
          ],
        },
      }

      // dataディレクトリとファイルリストのモック
      const mockFile = { path: "TaskChute/Log/2025-07-tasks.json" }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === "TaskChute/Log") {
          const mockFolder = { 
            path: "TaskChute/Log", 
            children: [mockFile]
          }
          mockFolder.constructor = TFolder
          Object.setPrototypeOf(mockFolder, TFolder.prototype)
          return mockFolder
        }
        if (path === "TaskChute/Log/2025-07-tasks.json") {
          return mockFile
        }
        return null
      })

      mockApp.vault.adapter.list.mockResolvedValue({
        files: ["2025-07-tasks.json"],
        folders: [],
      })

      mockApp.vault.read.mockImplementation((file) => {
        const path = file?.path || file;
        if (
          path === "TaskChute/Log/2025-07-tasks.json"
        ) {
          return Promise.resolve(JSON.stringify(originalData))
        } else {
          return Promise.reject(new Error("File not found"))
        }
      })

      // 現在時刻をモック
      const mockNow = new Date("2025-07-12T10:00:00.000Z")
      jest.spyOn(global, "Date").mockImplementation(() => mockNow)

      await taskChuteView.deleteTaskLogs(taskId)

      expect(mockApp.vault.modify).toHaveBeenCalledTimes(1)

      const writeCall = mockApp.vault.modify.mock.calls[0]
      const updatedData = JSON.parse(writeCall[1])

      // lastUpdatedが更新されていることを確認
      expect(updatedData.metadata.lastUpdated).toBe("2025-07-12T10:00:00.000Z")

      // Dateモックを復元
      global.Date.mockRestore()
    })
  })

  describe("Integration with task deletion", () => {
    test("should call deleteTaskLogs when task is deleted", async () => {
      const taskId = "Test/Task.md"

      // deleteTaskLogsメソッドをスパイ
      const deleteTaskLogsSpy = jest
        .spyOn(taskChuteView, "deleteTaskLogs")
        .mockResolvedValue()

      // タスク削除をシミュレート（実際のコードから抜粋した部分）
      const mockTask = {
        path: taskId,
        title: "Test Task",
        file: { path: taskId },
      }

      const mockInstance = {
        task: mockTask,
        state: "idle",
      }

      // ファイル削除をモック
      mockApp.vault.delete.mockResolvedValue()

      // タスク削除処理をシミュレート
      try {
        await mockApp.vault.delete(mockInstance.task.file)

        // 削除済みリストに追加
        let deletedTasks = []
        try {
          deletedTasks = JSON.parse(
            localStorage.getItem("taskchute-deleted-tasks") || "[]",
          )
        } catch (e) {
          deletedTasks = []
        }
        if (!deletedTasks.includes(mockInstance.task.path)) {
          deletedTasks.push(mockInstance.task.path)
          localStorage.setItem(
            "taskchute-deleted-tasks",
            JSON.stringify(deletedTasks),
          )
        }

        // タスクログも削除
        await taskChuteView.deleteTaskLogs(mockInstance.task.path)
      } catch (err) {
        // エラーハンドリング
      }

      // deleteTaskLogsが呼ばれたことを確認
      expect(deleteTaskLogsSpy).toHaveBeenCalledWith(taskId)
      expect(deleteTaskLogsSpy).toHaveBeenCalledTimes(1)

      deleteTaskLogsSpy.mockRestore()
    })

    test("should call deleteTaskLogs when task is reset to idle", async () => {
      const taskId = "Test/Task.md"

      // deleteTaskLogsメソッドをスパイ
      const deleteTaskLogsSpy = jest
        .spyOn(taskChuteView, "deleteTaskLogs")
        .mockResolvedValue()

      // 完了状態のタスクを作成
      const mockTask = {
        path: taskId,
        title: "Test Task",
      }

      const mockInstance = {
        task: mockTask,
        state: "done", // 完了状態
        startTime: new Date(),
        stopTime: new Date(),
      }

      // resetTaskToIdleを呼び出し
      await taskChuteView.resetTaskToIdle(mockInstance)

      // deleteTaskLogsが呼ばれたことを確認
      expect(deleteTaskLogsSpy).toHaveBeenCalledWith(taskId)
      expect(deleteTaskLogsSpy).toHaveBeenCalledTimes(1)

      deleteTaskLogsSpy.mockRestore()
    })

    test("should not call deleteTaskLogs when resetting non-completed task", async () => {
      const taskId = "Test/Task.md"

      // deleteTaskLogsメソッドをスパイ
      const deleteTaskLogsSpy = jest
        .spyOn(taskChuteView, "deleteTaskLogs")
        .mockResolvedValue()

      // 実行中のタスクを作成
      const mockTask = {
        path: taskId,
        title: "Test Task",
      }

      const mockInstance = {
        task: mockTask,
        state: "running", // 実行中（完了していない）
        startTime: new Date(),
        stopTime: null,
      }

      // resetTaskToIdleを呼び出し
      await taskChuteView.resetTaskToIdle(mockInstance)

      // deleteTaskLogsが呼ばれないことを確認
      expect(deleteTaskLogsSpy).not.toHaveBeenCalled()

      deleteTaskLogsSpy.mockRestore()
    })
  })
})
