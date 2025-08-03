const { TaskChuteView } = require("../main.js")

describe("Task Replay Comment Fix", () => {
  let mockApp
  let mockLeaf
  let taskChuteView

  beforeEach(() => {
    // mockAppのセットアップ
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          mkdir: jest.fn(),
          list: jest.fn(),
          getFullPath: jest.fn(),
        },
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        delete: jest.fn(),
        createFolder: jest.fn(),
        create: jest.fn(),
      },
      workspace: {
        openLinkText: jest.fn(),
        openFile: jest.fn(),
        splitActiveLeaf: jest.fn(),
        setActiveLeaf: jest.fn(),
        getLeavesOfType: jest.fn(),
        getRightLeaf: jest.fn(),
        on: jest.fn(),
      },
      metadataCache: {
        getFileCache: jest.fn(),
      },
      fileManager: {
        processFrontMatter: jest.fn(),
      },
      plugins: {
        plugins: {},
      },
    }

    mockLeaf = {
      view: null,
    }

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
    taskChuteView.currentDate = new Date(2024, 0, 15) // 2024-01-15

    // getCurrentTimeSlotのモック
    taskChuteView.getCurrentTimeSlot = jest.fn().mockReturnValue("8:00-12:00")
  })

  describe("duplicateAndStartInstance behavior", () => {
    test("should not copy comments when using replay button", async () => {
      const originalInstanceId = "test-task.md#1642204800000#abc123"
      const completedTask = {
        task: { title: "Test Task", path: "test-task.md" },
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T11:00:00"),
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: originalInstanceId,
      }

      // モックJSONデータの準備（元のタスクのコメント）
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: originalInstanceId,
              taskName: "Test Task",
              executionComment: "Original task completed with comment",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
          ],
        },
      }

      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      // タスクインスタンスの初期状態
      taskChuteView.taskInstances = [completedTask]

      // generateInstanceIdのモック
      const newInstanceId = "test-task.md#1642204800001#def456"
      taskChuteView.generateInstanceId = jest.fn().mockReturnValue(newInstanceId)

      // startInstanceのモック
      taskChuteView.startInstance = jest.fn()

      // renderTaskListのモック
      taskChuteView.renderTaskList = jest.fn()

      // duplicateAndStartInstanceを実行
      await taskChuteView.duplicateAndStartInstance(completedTask)

      // 新しいインスタンスが作成されたことを確認
      expect(taskChuteView.taskInstances).toHaveLength(2)
      const newInstance = taskChuteView.taskInstances[1]

      // 新しいインスタンスが異なるinstanceIdを持つことを確認
      expect(newInstance.instanceId).toBe(newInstanceId)
      expect(newInstance.instanceId).not.toBe(originalInstanceId)

      // 新しいインスタンスのコメントを取得（nullであるべき）
      const newInstanceComment = await taskChuteView.getExistingTaskComment(newInstance)
      expect(newInstanceComment).toBeNull()

      // 元のインスタンスのコメントは引き続き取得できることを確認
      const originalComment = await taskChuteView.getExistingTaskComment(completedTask)
      expect(originalComment).toBeTruthy()
      expect(originalComment.executionComment).toBe("Original task completed with comment")
    })

    test("should show modal without existing comment for replayed task", async () => {
      const originalInstanceId = "test-task.md#1642204800000#abc123"
      const newInstanceId = "test-task.md#1642204800001#def456"

      const completedTask = {
        task: { title: "Test Task", path: "test-task.md" },
        state: "done",
        instanceId: originalInstanceId,
      }

      const newTask = {
        task: { title: "Test Task", path: "test-task.md" },
        state: "running",
        instanceId: newInstanceId,
      }

      // モックJSONデータ（元のタスクのコメントのみ）
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: originalInstanceId,
              taskName: "Test Task",
              executionComment: "Should not appear in new task",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
          ],
        },
      }

      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      // showTaskCompletionModalの動作を確認
      // getExistingTaskCommentが新しいタスクに対してnullを返すことを確認
      const existingComment = await taskChuteView.getExistingTaskComment(newTask)
      expect(existingComment).toBeNull()

      // モーダルが新規コメントモードで表示されることを想定
      // （実際のDOM操作はテストできないため、getExistingTaskCommentの結果を確認）
    })
  })

  describe("Comment data isolation", () => {
    test("multiple instances of same task should have independent comments", async () => {
      const instanceId1 = "test-task.md#1642204800000#abc123"
      const instanceId2 = "test-task.md#1642204800001#def456"
      const instanceId3 = "test-task.md#1642204800002#ghi789"

      // 3つの異なるインスタンスのコメントデータ
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: instanceId1,
              taskName: "Test Task",
              executionComment: "First execution",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
            {
              instanceId: instanceId2,
              taskName: "Test Task",
              executionComment: "Second execution",
              focusLevel: 3,
              energyLevel: 4,
              isCompleted: true,
            },
            // instanceId3はまだコメントなし
          ],
        },
      }

      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      // 各インスタンスのコメントを取得
      const instance1 = { instanceId: instanceId1, task: { title: "Test Task" } }
      const instance2 = { instanceId: instanceId2, task: { title: "Test Task" } }
      const instance3 = { instanceId: instanceId3, task: { title: "Test Task" } }

      const comment1 = await taskChuteView.getExistingTaskComment(instance1)
      const comment2 = await taskChuteView.getExistingTaskComment(instance2)
      const comment3 = await taskChuteView.getExistingTaskComment(instance3)

      // それぞれ独立したコメントを持つことを確認
      expect(comment1.executionComment).toBe("First execution")
      expect(comment2.executionComment).toBe("Second execution")
      expect(comment3).toBeNull() // まだコメントがない
    })
  })
})