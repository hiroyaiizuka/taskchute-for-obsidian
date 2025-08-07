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

describe("TaskChute Comment Functionality - Final Tests", () => {
  let taskChuteView
  let mockApp
  let mockVaultAdapter

  beforeEach(() => {
    // Vault adapter のモック
    mockVaultAdapter = {
      exists: jest.fn(),
      mkdir: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
    }

    // シンプルなアプリケーションモック
    const mockVault = {
      adapter: mockVaultAdapter,
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      modify: jest.fn(),
      create: jest.fn(),
      createFolder: jest.fn(),
    }
    
    mockApp = {
      vault: mockVault,
    }

    // TaskChuteView インスタンスを作成（最小限の設定）
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView({}, mockPlugin)
    taskChuteView.app = mockApp
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe("getExistingTaskComment - Unit Tests", () => {
    test("should return null when instanceId is not provided", async () => {
      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask, // instanceIdを意図的に省略
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toBeNull()
      // instanceIdがない場合は早期リターンするため、exists()は呼ばれない
      expect(mockVaultAdapter.exists).not.toHaveBeenCalled()
    })

    test("should return null when log file does not exist", async () => {
      // ファイルが存在しない場合のモック
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        instanceId: "test-instance-123", // instanceIdを追加
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toBeNull()
      expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalled()
    })

    test("should return existing comment when found", async () => {
      // 現在の日付を使用してテストデータを動的に生成
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const day = today.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      // 期待されるファイルパスを生成
      const expectedFilePath = `TaskChute/Log/${year}-${month}-tasks.json`

      const testInstanceId = "test-instance-123"
      const mockLogData = {
        taskExecutions: {
          [dateString]: [
            {
              taskName: "Test Task",
              instanceId: testInstanceId,
              executionComment: "Great work!",
              focusLevel: 4,
              energyLevel: 5,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: expectedFilePath }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(mockLogData))

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        instanceId: testInstanceId, // instanceIdを追加
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toEqual({
        taskName: "Test Task",
        instanceId: testInstanceId,
        executionComment: "Great work!",
        focusLevel: 4,
        energyLevel: 5,
        timestamp: expect.any(String),
      })
    })

    test("should handle JSON parse errors gracefully", async () => {
      // 現在の日付を使用してテストデータを動的に生成
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const expectedFilePath = `TaskChute/Log/${year}-${month}-tasks.json`

      // TFileインスタンスのモック（不正なJSON）
      const mockLogFile = { path: expectedFilePath }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue("invalid json")

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        instanceId: "test-instance-123", // instanceIdを追加
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toBeNull()
      // エラーが静かに処理されることを確認
      expect(mockApp.vault.read).toHaveBeenCalledWith(mockLogFile)


    })

    test("should return null when task has no meaningful comment", async () => {
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const day = today.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      // 期待されるファイルパスを生成
      const expectedFilePath = `TaskChute/Log/${year}-${month}-tasks.json`

      const testInstanceId = "test-instance-456"
      const mockLogData = {
        taskExecutions: {
          [dateString]: [
            {
              taskName: "Test Task",
              instanceId: testInstanceId,
              executionComment: "",
              focusLevel: 0,
              energyLevel: 0,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: expectedFilePath }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(mockLogData))

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        instanceId: testInstanceId, // instanceIdを追加
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toBeNull()
    })

    test("should find task with rating but no comment", async () => {
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const day = today.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      // 期待されるファイルパスを生成
      const expectedFilePath = `TaskChute/Log/${year}-${month}-tasks.json`

      const testInstanceId = "test-instance-789"
      const mockLogData = {
        taskExecutions: {
          [dateString]: [
            {
              taskName: "Test Task",
              instanceId: testInstanceId,
              executionComment: "",
              focusLevel: 4,
              energyLevel: 3,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: expectedFilePath }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(mockLogData))

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        instanceId: testInstanceId, // instanceIdを追加
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toEqual({
        taskName: "Test Task",
        instanceId: testInstanceId,
        executionComment: "",
        focusLevel: 4,
        energyLevel: 3,
      })
    })
  })

  describe("saveTaskCompletion - Integration Tests", () => {
    test("should handle save process without errors", async () => {
      const expectedFilePath = `TaskChute/Log/2024-01-tasks.json`
      
      // TFileインスタンスのモック
      const mockLogFile = { path: expectedFilePath }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        '{"taskExecutions": {}, "metadata": {}}',
      )
      mockApp.vault.modify.mockResolvedValue()

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T10:30:00"),
        slotKey: "morning",
      }

      const completionData = {
        executionComment: "Great job!",
        focusLevel: 4,
        energyLevel: 5,
        timestamp: "2024-01-15T10:30:00.000Z",
      }

      // Should not throw
      await expect(
        taskChuteView.saveTaskCompletion(instance, completionData),
      ).resolves.not.toThrow()

      expect(mockApp.vault.modify).toHaveBeenCalled()
    })

    test("should handle error conditions gracefully", async () => {
      // console.logをモック
      const consoleSpy = jest.spyOn(console, "log").mockImplementation()

      // Vault APIでエラーを発生させる
      mockApp.vault.getAbstractFileByPath.mockImplementation(() => {
        throw new Error("File system error")
      })

      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
      }
      const instance = {
        task: mockTask,
        state: "done",
      }

      const completionData = {
        executionComment: "Test comment",
        focusLevel: 3,
        energyLevel: 3,
        timestamp: "2024-01-15T10:30:00.000Z",
      }

      // Should not throw
      await expect(
        taskChuteView.saveTaskCompletion(instance, completionData),
      ).resolves.not.toThrow()

      expect(Notice).toHaveBeenCalledWith("タスク記録の保存に失敗しました")


    })

    test("should create new log structure when file doesn't exist", async () => {
      // ファイルが存在しない場合
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)
      mockApp.vault.create.mockResolvedValue()
      mockApp.vault.createFolder.mockResolvedValue()

      const mockTask = {
        title: "New Task",
        path: "new-task.md",
      }
      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T10:30:00"),
      }

      const completionData = {
        executionComment: "First comment",
        focusLevel: 3,
        energyLevel: 4,
        timestamp: "2024-01-15T10:30:00.000Z",
      }

      await taskChuteView.saveTaskCompletion(instance, completionData)

      // ディレクトリ作成またはファイル作成が呼ばれているか確認
      const createCalled = mockApp.vault.create.mock.calls.length > 0
      const createFolderCalled = mockApp.vault.createFolder.mock.calls.length > 0
      expect(createCalled || createFolderCalled).toBe(true)
      
      // createが呼ばれていればその内容を確認
      if (createCalled) {
        const writeCall = mockApp.vault.create.mock.calls[0]
        const writtenData = JSON.parse(writeCall[1])

        expect(writtenData.metadata).toBeDefined()
        expect(writtenData.taskExecutions).toBeDefined()
        expect(writtenData.dailySummary).toBeDefined()
      }
    })

    test("should preserve existing data structure when updating", async () => {
      const existingLogData = {
        metadata: {
          version: "2.0",
          month: "2024-01",
          lastUpdated: "2024-01-15T09:00:00.000Z",
          totalDays: 31,
          activeDays: 1,
        },
        dailySummary: {
          "2024-01-14": {
            totalTasks: 5,
            completedTasks: 4,
          },
        },
        taskExecutions: {
          "2024-01-14": [
            {
              taskName: "Yesterday Task",
              executionComment: "Previous task",
              focusLevel: 3,
              energyLevel: 3,
            },
          ],
        },
        patterns: {},
      }

      // TFileインスタンスのモック
      const mockFile = { path: 'mock-file' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(existingLogData))
      mockApp.vault.modify.mockResolvedValue()

      const mockTask = {
        title: "Today Task",
        path: "today-task.md",
      }
      const instance = {
        task: mockTask,
        state: "done",
      }

      const completionData = {
        executionComment: "Today's comment",
        focusLevel: 5,
        energyLevel: 4,
        timestamp: "2024-01-15T10:35:00.000Z",
      }

      await taskChuteView.saveTaskCompletion(instance, completionData)

      expect(mockApp.vault.modify).toHaveBeenCalled()
      const writeCall = mockApp.vault.modify.mock.calls[0]
      const writtenData = JSON.parse(writeCall[1])

      // 既存のデータが保持されていることを確認
      expect(writtenData.dailySummary["2024-01-14"]).toEqual({
        totalTasks: 5,
        completedTasks: 4,
      })
      expect(writtenData.taskExecutions["2024-01-14"]).toHaveLength(1)
      expect(writtenData.metadata.version).toBe("2.0")
    })
  })

  describe("Rating System - Unit Tests", () => {
    test("should update rating display correctly", () => {
      const mockStars = [
        { style: {} },
        { style: {} },
        { style: {} },
        { style: {} },
        { style: {} },
      ]
      const mockRatingEl = {
        querySelectorAll: jest.fn().mockReturnValue(mockStars),
      }

      taskChuteView.updateRatingDisplay(mockRatingEl, 3)

      // 3つの星がハイライトされることを確認
      expect(mockStars[0].style.opacity).toBe("1")
      expect(mockStars[1].style.opacity).toBe("1")
      expect(mockStars[2].style.opacity).toBe("1")
      expect(mockStars[3].style.opacity).toBe("0.3")
      expect(mockStars[4].style.opacity).toBe("0.3")
    })

    test("should set rating correctly", () => {
      const mockRatingEl = {
        setAttribute: jest.fn(),
        querySelectorAll: jest
          .fn()
          .mockReturnValue([
            { style: {} },
            { style: {} },
            { style: {} },
            { style: {} },
            { style: {} },
          ]),
      }

      taskChuteView.setRating(mockRatingEl, 4)

      expect(mockRatingEl.setAttribute).toHaveBeenCalledWith("data-rating", "4")
    })

    test("should reset rating highlight correctly", () => {
      const mockStars = [
        { style: {} },
        { style: {} },
        { style: {} },
        { style: {} },
        { style: {} },
      ]
      const mockRatingEl = {
        getAttribute: jest.fn().mockReturnValue("2"),
        querySelectorAll: jest.fn().mockReturnValue(mockStars),
      }

      taskChuteView.resetRatingHighlight(mockRatingEl)

      // 現在の評価（2）に基づいて表示がリセットされることを確認
      expect(mockStars[0].style.opacity).toBe("1")
      expect(mockStars[1].style.opacity).toBe("1")
      expect(mockStars[2].style.opacity).toBe("0.3")
      expect(mockStars[3].style.opacity).toBe("0.3")
      expect(mockStars[4].style.opacity).toBe("0.3")
    })

    test("should handle edge cases for rating display", () => {
      const mockStars = [
        { style: {} },
        { style: {} },
        { style: {} },
        { style: {} },
        { style: {} },
      ]
      const mockRatingEl = {
        querySelectorAll: jest.fn().mockReturnValue(mockStars),
      }

      // 最低評価（0）のテスト
      taskChuteView.updateRatingDisplay(mockRatingEl, 0)
      mockStars.forEach((star) => {
        expect(star.style.opacity).toBe("0.3")
      })

      // 最高評価（5）のテスト
      taskChuteView.updateRatingDisplay(mockRatingEl, 5)
      mockStars.forEach((star) => {
        expect(star.style.opacity).toBe("1")
      })
    })
  })

  describe("Comment Button Functionality - Basic Tests", () => {
    test("hasCommentData should return false when no log file exists", async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)

      const mockInstance = {
        task: {
          title: "Test Task",
          path: "test-task.md",
        },
        instanceId: "test-instance-hascomment-1",
        state: "done",
        startTime: new Date("2025-01-23T10:00:00"),
        stopTime: new Date("2025-01-23T11:00:00"),
      }

      const result = await taskChuteView.hasCommentData(mockInstance)

      expect(result).toBe(false)
      expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalled()
    })

    test("hasCommentData should return true when comment exists", async () => {
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const day = today.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      const testInstanceId = "test-instance-hascomment-2"
      const mockLogData = {
        taskExecutions: {
          [dateString]: [
            {
              taskName: "Test Task",
              instanceId: testInstanceId,
              executionComment: "Great work!",
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockFile = { path: 'mock-file' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(mockLogData))

      const mockInstance = {
        task: {
          title: "Test Task",
          path: "test-task.md",
        },
        instanceId: testInstanceId,
        state: "done",
        startTime: new Date(),
        stopTime: new Date(),
      }

      const result = await taskChuteView.hasCommentData(mockInstance)

      expect(result).toBe(true)
    })

    test("hasCommentData should return false for empty comment", async () => {
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const day = today.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      const mockLogData = {
        taskExecutions: {
          [dateString]: [
            {
              taskName: "Test Task",
              executionComment: "", // 空のコメント
              startTime: new Date().toISOString(),
              endTime: new Date().toISOString(),
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockFile = { path: 'mock-file' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.vault.read.mockResolvedValue(JSON.stringify(mockLogData))

      const mockInstance = {
        task: {
          title: "Test Task",
          path: "test-task.md",
        },
        state: "done",
        startTime: new Date(),
        stopTime: new Date(),
      }

      const result = await taskChuteView.hasCommentData(mockInstance)

      expect(result).toBe(false)
    })

    test("hasCommentData should handle errors gracefully", async () => {
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockRejectedValue(new Error("File system error"))

      const mockInstance = {
        task: {
          title: "Test Task",
          path: "test-task.md",
        },
        instanceId: "test-instance-hascomment-3",
        state: "done",
        startTime: new Date(),
        stopTime: new Date(),
      }

      const result = await taskChuteView.hasCommentData(mockInstance)

      expect(result).toBe(false)
      // エラーが静かに処理されることを確認
      expect(mockApp.vault.getAbstractFileByPath).toHaveBeenCalled()


    })
  })
})
