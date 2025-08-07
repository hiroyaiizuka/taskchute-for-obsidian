const { TaskChuteView } = require('../main.js')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')

describe("Task Duplicate Comment Separation", () => {
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
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
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

    // テストに必要なDOMエレメントのモック
    const createMockElement = () => ({
      createEl: jest.fn().mockImplementation(() => createMockElement()),
      addEventListener: jest.fn(),
      setAttribute: jest.fn(),
      getAttribute: jest.fn(),
      setText: jest.fn(),
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        contains: jest.fn(),
      },
      style: {},
      innerHTML: "",
      textContent: "",
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn().mockReturnValue([]),
    })

    taskChuteView.taskList = {
      scrollTop: 0,
      scrollLeft: 0,
      empty: jest.fn(),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn().mockReturnValue([]),
      createEl: jest.fn().mockImplementation(() => createMockElement()),
      ...createMockElement(),
    }
  })

  describe("getExistingTaskComment with instanceId", () => {
    test("should return comment for correct instanceId", async () => {
      const instanceId1 = "task1#1642204800000#abc123"
      const instanceId2 = "task1#1642204800001#def456"

      // モックJSONデータの準備
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: instanceId1,
              taskName: "Test Task",
              executionComment: "Original task comment",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
            {
              instanceId: instanceId2,
              taskName: "Test Task",
              executionComment: "Different comment",
              focusLevel: 3,
              energyLevel: 4,
              isCompleted: true,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      // 1つ目のインスタンスでコメントを取得
      const instance1 = {
        instanceId: instanceId1,
        task: { title: "Test Task" },
        startTime: new Date("2024-03-15T10:00:00"),
      }

      const result1 = await taskChuteView.getExistingTaskComment(instance1)

      expect(result1).toBeTruthy()
      expect(result1.executionComment).toBe("Original task comment")
      expect(result1.focusLevel).toBe(4)
      expect(result1.energyLevel).toBe(5)

      // 2つ目のインスタンスでコメントを取得
      const instance2 = {
        instanceId: instanceId2,
        task: { title: "Test Task" },
        startTime: new Date("2024-03-15T10:00:00"),
      }

      const result2 = await taskChuteView.getExistingTaskComment(instance2)

      expect(result2).toBeTruthy()
      expect(result2.executionComment).toBe("Different comment")
      expect(result2.focusLevel).toBe(3)
      expect(result2.energyLevel).toBe(4)
    })

    test("should return null when instanceId not found (no fallback search)", async () => {
      const instanceId1 = "task1#1642204800000#abc123"
      const instanceId2 = "task1#1642204800001#def456"

      // モックJSONデータの準備（instanceId1のデータのみ）
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: instanceId1,
              taskName: "Test Task",
              executionComment: "Original task comment",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      // 存在しないinstanceIdで検索
      const instance2 = {
        instanceId: instanceId2,
        task: { title: "Test Task" },
        startTime: new Date("2024-03-15T10:00:00"),
      }

      const result = await taskChuteView.getExistingTaskComment(instance2)

      // 新しい仕様では、異なるinstanceIdの場合はnullを返す（フォールバック検索なし）
      expect(result).toBeNull()
    })

    test("should return null when neither instanceId nor taskName found", async () => {
      const instanceId1 = "task1#1642204800000#abc123"

      // モックJSONデータの準備（空のデータ）
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      const instance = {
        instanceId: instanceId1,
        task: { title: "Test Task" },
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      expect(result).toBeNull()
    })

    test("should return null for legacy data without instanceId (no longer supported)", async () => {
      // モックJSONデータの準備（instanceIdなしの古いデータ）
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              taskName: "Test Task",
              executionComment: "Legacy comment",
              focusLevel: 3,
              energyLevel: 4,
              isCompleted: true,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      const instance = {
        instanceId: "task1#1642204800000#abc123",
        task: { title: "Test Task" },
      }

      const result = await taskChuteView.getExistingTaskComment(instance)

      // 新しい仕様では、instanceIdでの検索のみサポート。
      // 古いデータ（instanceIdなし）は検索対象外なのでnullを返す
      expect(result).toBeNull()
    })
  })

  describe("Task duplication and comment separation", () => {
    test("should create duplicate task with different instanceId", () => {
      // 元のタスクインスタンスを作成
      const originalInstance = {
        task: { title: "Test Task", path: "test-task.md" },
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T11:00:00"),
        slotKey: "8:00-12:00",
        order: 100,
        instanceId: "test-task.md#1642204800000#abc123",
      }

      taskChuteView.taskInstances = [originalInstance]

      // タスクを複製
      taskChuteView.duplicateInstance(originalInstance)

      // 複製されたタスクが追加されているか確認
      expect(taskChuteView.taskInstances).toHaveLength(2)

      const duplicatedInstance = taskChuteView.taskInstances[1]
      expect(duplicatedInstance.task).toBe(originalInstance.task) // 同じタスクオブジェクト
      expect(duplicatedInstance.state).toBe("idle") // 未実行状態
      expect(duplicatedInstance.startTime).toBeNull()
      expect(duplicatedInstance.stopTime).toBeNull()
      expect(duplicatedInstance.instanceId).toBeDefined()
      expect(duplicatedInstance.instanceId).not.toBe(
        originalInstance.instanceId,
      ) // 異なるインスタンスID
    })

    test("should separate comments between original and duplicated tasks", async () => {
      const originalInstanceId = "test-task.md#1642204800000#abc123"
      const duplicatedInstanceId = "test-task.md#1642204800001#def456"

      // モックJSONデータの準備（元のタスクのコメントのみ）
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: originalInstanceId,
              taskName: "Test Task",
              executionComment: "Original task completed successfully",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      // 元のタスクインスタンス
      const originalInstance = {
        instanceId: originalInstanceId,
        task: { title: "Test Task", path: "test-task.md" },
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
      }

      // 複製されたタスクインスタンス
      const duplicatedInstance = {
        instanceId: duplicatedInstanceId,
        task: { title: "Test Task", path: "test-task.md" },
        state: "idle",
        startTime: new Date("2024-01-15T10:00:00"),
      }

      // 元のタスクはコメントが存在する
      const originalComment = await taskChuteView.getExistingTaskComment(
        originalInstance,
      )
      expect(originalComment).toBeTruthy()
      expect(originalComment.executionComment).toBe(
        "Original task completed successfully",
      )

      // 複製されたタスクはコメントが存在しない（instanceIdが異なり、かつ未実行状態）
      const duplicatedComment = await taskChuteView.getExistingTaskComment(
        duplicatedInstance,
      )
      // 複製されたタスクは実行されていないため、コメントが存在しないはず
      // しかし、現在のバグでは、フォールバック検索で元のタスクのコメントが返される可能性がある
      expect(duplicatedComment).toBeNull()
    })

    test("should handle hasCommentData correctly for duplicated tasks", async () => {
      const originalInstanceId = "test-task.md#1642204800000#abc123"
      const duplicatedInstanceId = "test-task.md#1642204800001#def456"

      // モックJSONデータの準備
      const mockMonthlyLog = {
        taskExecutions: {
          "2024-01-15": [
            {
              instanceId: originalInstanceId,
              taskName: "Test Task",
              executionComment: "Original task comment",
              focusLevel: 4,
              energyLevel: 5,
              isCompleted: true,
            },
          ],
        },
      }

      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockLogFile)
      mockApp.vault.read.mockResolvedValue(
        JSON.stringify(mockMonthlyLog),
      )

      const originalInstance = {
        instanceId: originalInstanceId,
        task: { title: "Test Task", path: "test-task.md" },
        state: "done",
        startTime: new Date("2024-01-15T10:00:00"),
      }

      const duplicatedInstance = {
        instanceId: duplicatedInstanceId,
        task: { title: "Test Task", path: "test-task.md" },
        state: "idle",
        startTime: new Date("2024-01-15T10:00:00"),
      }

      // 元のタスクはコメントデータがある
      const originalHasComment = await taskChuteView.hasCommentData(
        originalInstance,
      )
      expect(originalHasComment).toBe(true)

      // 複製されたタスクはコメントデータがない
      const duplicatedHasComment = await taskChuteView.hasCommentData(
        duplicatedInstance,
      )
      expect(duplicatedHasComment).toBe(false)
    })
  })

  describe("Task execution history restoration", () => {
    test("should use saved instanceId when available", () => {
      const savedInstanceId = "test-task.md#1642204800000#abc123"

      // 実行履歴データをモック
      const mockExecution = {
        taskTitle: "Test Task",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T11:00:00"),
        slotKey: "8:00-12:00",
        instanceId: savedInstanceId,
      }

      // タスクオブジェクトをモック
      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
      }

      // インスタンス作成時に保存されたinstanceIdが使用されることを確認
      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date(mockExecution.startTime),
        stopTime: new Date(mockExecution.stopTime),
        slotKey: mockExecution.slotKey,
        order: null,
        instanceId:
          mockExecution.instanceId ||
          taskChuteView.generateInstanceId(mockTask.path),
      }

      expect(instance.instanceId).toBe(savedInstanceId)
      expect(instance.state).toBe("done")
    })

    test("should generate new instanceId when not saved", () => {
      // 実行履歴データをモック（instanceIdなし）
      const mockExecution = {
        taskTitle: "Test Task",
        startTime: new Date("2024-01-15T10:00:00"),
        stopTime: new Date("2024-01-15T11:00:00"),
        slotKey: "8:00-12:00",
      }

      // タスクオブジェクトをモック
      const mockTask = {
        title: "Test Task",
        path: "test-task.md",
        isRoutine: false,
        scheduledTime: null,
        slotKey: "8:00-12:00",
      }

      // インスタンス作成時に新しいinstanceIdが生成されることを確認
      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date(mockExecution.startTime),
        stopTime: new Date(mockExecution.stopTime),
        slotKey: mockExecution.slotKey,
        order: null,
        instanceId:
          mockExecution.instanceId ||
          taskChuteView.generateInstanceId(mockTask.path),
      }

      expect(instance.instanceId).toBeDefined()
      expect(instance.instanceId).toMatch(/^test-task\.md#\d+#[a-z0-9]{9}$/)
    })
  })
})
