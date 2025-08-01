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
    mockApp = {
      vault: {
        adapter: mockVaultAdapter,
      },
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
      mockVaultAdapter.exists.mockResolvedValue(false)

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
      expect(mockVaultAdapter.exists).toHaveBeenCalled()
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

      // 特定のファイルパスに対するモックを設定
      mockVaultAdapter.exists.mockImplementation((path) => {
        return Promise.resolve(path === expectedFilePath)
      })
      mockVaultAdapter.read.mockImplementation((path) => {
        if (path === expectedFilePath) {
          return Promise.resolve(JSON.stringify(mockLogData))
        }
        return Promise.reject(new Error(`Unexpected file path: ${path}`))
      })

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
      mockVaultAdapter.exists.mockResolvedValue(true)
      mockVaultAdapter.read.mockResolvedValue("invalid json")

      // console.errorをモック
      const consoleSpy = jest.spyOn(console, "error").mockImplementation()

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
      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
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

      // 特定のファイルパスに対するモックを設定
      mockVaultAdapter.exists.mockImplementation((path) => {
        return Promise.resolve(path === expectedFilePath)
      })
      mockVaultAdapter.read.mockImplementation((path) => {
        if (path === expectedFilePath) {
          return Promise.resolve(JSON.stringify(mockLogData))
        }
        return Promise.reject(new Error(`Unexpected file path: ${path}`))
      })

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

      // 特定のファイルパスに対するモックを設定
      mockVaultAdapter.exists.mockImplementation((path) => {
        return Promise.resolve(path === expectedFilePath)
      })
      mockVaultAdapter.read.mockImplementation((path) => {
        if (path === expectedFilePath) {
          return Promise.resolve(JSON.stringify(mockLogData))
        }
        return Promise.reject(new Error(`Unexpected file path: ${path}`))
      })

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
      mockVaultAdapter.exists.mockResolvedValue(true)
      mockVaultAdapter.read.mockResolvedValue(
        '{"taskExecutions": {}, "metadata": {}}',
      )
      mockVaultAdapter.write.mockResolvedValue()

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

      expect(mockVaultAdapter.write).toHaveBeenCalled()
    })

    test("should handle error conditions gracefully", async () => {
      // console.logをモック
      const consoleSpy = jest.spyOn(console, "log").mockImplementation()

      mockVaultAdapter.exists.mockRejectedValue(new Error("File system error"))

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

      consoleSpy.mockRestore()
    })

    test("should create new log structure when file doesn't exist", async () => {
      mockVaultAdapter.exists.mockResolvedValueOnce(true) // data dir exists
      mockVaultAdapter.exists.mockResolvedValueOnce(false) // log file doesn't exist
      mockVaultAdapter.write.mockResolvedValue()

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

      expect(mockVaultAdapter.write).toHaveBeenCalled()
      const writeCall = mockVaultAdapter.write.mock.calls[0]
      const writtenData = JSON.parse(writeCall[1])

      expect(writtenData.metadata).toBeDefined()
      expect(writtenData.taskExecutions).toBeDefined()
      expect(writtenData.dailySummary).toBeDefined()
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

      mockVaultAdapter.exists.mockResolvedValue(true)
      mockVaultAdapter.read.mockResolvedValue(JSON.stringify(existingLogData))
      mockVaultAdapter.write.mockResolvedValue()

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

      expect(mockVaultAdapter.write).toHaveBeenCalled()
      const writeCall = mockVaultAdapter.write.mock.calls[0]
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
      mockVaultAdapter.exists.mockResolvedValue(false)

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
      expect(mockVaultAdapter.exists).toHaveBeenCalled()
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

      mockVaultAdapter.exists.mockResolvedValue(true)
      mockVaultAdapter.read.mockResolvedValue(JSON.stringify(mockLogData))

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

      mockVaultAdapter.exists.mockResolvedValue(true)
      mockVaultAdapter.read.mockResolvedValue(JSON.stringify(mockLogData))

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
      const consoleSpy = jest.spyOn(console, "error").mockImplementation()

      mockVaultAdapter.exists.mockRejectedValue(new Error("File system error"))

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
      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
    })
  })
})
