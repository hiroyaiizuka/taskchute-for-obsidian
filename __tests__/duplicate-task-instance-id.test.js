// Obsidianのモックを先に読み込む
const { mockApp, mockLeaf } = require("../__mocks__/obsidian.js")
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

describe("複製タスクのインスタンスID管理", () => {
  let taskChuteView
  let mockApp
  let mockLeaf

  beforeEach(() => {
    jest.clearAllMocks()
    
    // mockAppの定義
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          mkdir: jest.fn()
        },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn()
      },
      workspace: {
        openLinkText: jest.fn()
      },
      metadataCache: {
        getFileCache: jest.fn()
      },
      fileManager: {
        processFrontMatter: jest.fn()
      }
    }
    
    // mockLeafの定義
    mockLeaf = {}
    
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

    // TaskChuteViewのコンストラクタで初期化されるプロパティ
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    
    // DOM要素のモック
    taskChuteView.taskList = {
      scrollTop: 0,
      scrollLeft: 0,
      empty: jest.fn(),
      createEl: jest.fn().mockReturnValue({
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        style: {},
        classList: {
          add: jest.fn(),
          remove: jest.fn(),
          contains: jest.fn(),
        },
        setAttribute: jest.fn(),
        getAttribute: jest.fn(),
        textContent: "",
        innerHTML: "",
        setText: jest.fn(), // Add setText method
        createEl: jest.fn().mockReturnThis(),
        appendChild: jest.fn(),
        removeChild: jest.fn(),
        querySelector: jest.fn(),
        querySelectorAll: jest.fn().mockReturnValue([]),
      }),
      addEventListener: jest.fn(),
      style: {},
      textContent: "",
      innerHTML: "",
      children: [],
      querySelector: jest.fn(),
      querySelectorAll: jest.fn().mockReturnValue([]),
      setAttribute: jest.fn(),
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        contains: jest.fn(),
      },
    }
    taskChuteView.currentDate = new Date("2025-01-15")

    // 基本的なモック設定
    mockApp.vault.getAbstractFileByPath.mockReturnValue(null)
    mockApp.vault.modify.mockResolvedValue()
    mockApp.vault.adapter.mkdir.mockResolvedValue()

    // 現在の日付を固定
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2025-01-15T10:00:00+09:00"))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("generateInstanceIdメソッドが一意のIDを生成する", () => {
    const taskPath = "TaskChute/Task/タスクA.md"

    // 同じタスクパスでも異なるIDが生成される
    const id1 = taskChuteView.generateInstanceId(taskPath)
    const id2 = taskChuteView.generateInstanceId(taskPath)

    expect(id1).not.toBe(id2)
    expect(id1).toContain(taskPath)
    expect(id1).toMatch(/#\d+#[a-z0-9]+$/)
  })

  test("複製されたタスクインスタンスが異なるinstanceIdを持つ", async () => {
    const mockTask = {
      title: "タスクA",
      path: "TaskChute/Task/タスクA.md",
      file: { path: "TaskChute/Task/タスクA.md" },
      isRoutine: false,
    }

    // 元のインスタンス
    const originalInstance = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-01-15T10:00:00"),
      stopTime: new Date("2025-01-15T10:30:00"),
      slotKey: "8:00-12:00",
      instanceId: taskChuteView.generateInstanceId(mockTask.path),
    }

    taskChuteView.taskInstances = [originalInstance]

    // タスクを複製
    taskChuteView.duplicateInstance(originalInstance)

    // 複製されたインスタンスを確認
    expect(taskChuteView.taskInstances.length).toBe(2)

    const duplicatedInstance = taskChuteView.taskInstances[1]
    expect(duplicatedInstance.instanceId).toBeDefined()
    expect(duplicatedInstance.instanceId).not.toBe(originalInstance.instanceId)
    expect(duplicatedInstance.task.path).toBe(originalInstance.task.path)
  })

  test("複製されたタスクの実行ログが別々に保存される", async () => {
    // 最初はgetAbstractFileByPathがnullを返す（ファイルが存在しない）
    mockApp.vault.getAbstractFileByPath.mockReturnValue(null)
    // createFolderのモックを追加
    mockApp.vault.createFolder = jest.fn().mockResolvedValue()
    
    const mockTask = {
      title: "タスクA",
      path: "TaskChute/Task/タスクA.md",
      file: { path: "TaskChute/Task/タスクA.md" },
      isRoutine: false,
    }

    // 最初のタスクインスタンス
    const instance1 = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-01-15T10:00:00"),
      stopTime: new Date("2025-01-15T10:30:00"),
      slotKey: "8:00-12:00",
      instanceId: taskChuteView.generateInstanceId(mockTask.path),
    }

    // 複製されたタスクインスタンス
    const instance2 = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-01-15T11:00:00"),
      stopTime: new Date("2025-01-15T11:45:00"),
      slotKey: "8:00-12:00",
      instanceId: taskChuteView.generateInstanceId(mockTask.path),
    }

    // 最初のタスクを保存
    await taskChuteView.saveTaskCompletion(instance1, {
      executionComment: "最初の実行",
      focusLevel: 4,
      energyLevel: 5,
    })

    // 書き込まれたデータを取得（createまたはmodify）
    expect(mockApp.vault.create.mock.calls.length + mockApp.vault.modify.mock.calls.length).toBeGreaterThan(0)
    
    const firstWriteCall = mockApp.vault.create.mock.calls.length > 0 
      ? mockApp.vault.create.mock.calls[0]
      : mockApp.vault.modify.mock.calls[0]
    const firstWrittenData = firstWriteCall ? JSON.parse(firstWriteCall[1]) : {}

    // 既存のログファイルをモック
    // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
    mockApp.vault.read.mockResolvedValue(
      JSON.stringify(firstWrittenData),
    )

    // 複製されたタスクを保存
    await taskChuteView.saveTaskCompletion(instance2, {
      executionComment: "複製後の実行",
      focusLevel: 5,
      energyLevel: 4,
    })

    // 2回目の書き込みデータを取得
    const secondWriteCall = mockApp.vault.modify.mock.calls[0] // modifyは最初の呼び出し
    const secondWrittenData = JSON.parse(secondWriteCall[1])

    // 両方のログが保存されていることを確認
    const todayLogs = secondWrittenData.taskExecutions["2025-01-15"]
    expect(todayLogs.length).toBe(2)

    // 各ログが正しいデータを持っていることを確認
    const log1 = todayLogs.find(
      (log) => log.instanceId === instance1.instanceId,
    )
    const log2 = todayLogs.find(
      (log) => log.instanceId === instance2.instanceId,
    )

    expect(log1).toBeDefined()
    expect(log1.executionComment).toBe("最初の実行")
    expect(log1.startTime).toBe("10:00:00")
    expect(log1.stopTime).toBe("10:30:00")

    expect(log2).toBeDefined()
    expect(log2.executionComment).toBe("複製後の実行")
    expect(log2.startTime).toBe("11:00:00")
    expect(log2.stopTime).toBe("11:45:00")
  })

  test("既存ログの更新時はinstanceIdで正しく識別される", async () => {
    // getAbstractFileByPathとcreateFolderのモック
    mockApp.vault.getAbstractFileByPath.mockReturnValue(null)
    mockApp.vault.createFolder = jest.fn().mockResolvedValue()
    
    const mockTask = {
      title: "タスクA",
      path: "TaskChute/Task/タスクA.md",
      file: { path: "TaskChute/Task/タスクA.md" },
      isRoutine: false,
    }

    const instanceId = taskChuteView.generateInstanceId(mockTask.path)
    const instance = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-01-15T10:00:00"),
      stopTime: new Date("2025-01-15T10:30:00"),
      slotKey: "8:00-12:00",
      instanceId: instanceId,
    }

    // 初回保存
    await taskChuteView.saveTaskCompletion(instance, {
      executionComment: "初回コメント",
      focusLevel: 3,
      energyLevel: 3,
    })

    const firstWriteCall = mockApp.vault.create.mock.calls.length > 0 
      ? mockApp.vault.create.mock.calls[0]
      : mockApp.vault.modify.mock.calls[0]
    const firstWrittenData = firstWriteCall ? JSON.parse(firstWriteCall[1]) : {}

    // 既存ログをモック
    // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
    mockApp.vault.read.mockResolvedValue(
      JSON.stringify(firstWrittenData),
    )

    // コメントを更新
    await taskChuteView.saveTaskCompletion(instance, {
      executionComment: "更新されたコメント",
      focusLevel: 5,
      energyLevel: 5,
    })

    const updatedData = JSON.parse(mockApp.vault.modify.mock.calls[0][1])
    const todayLogs = updatedData.taskExecutions["2025-01-15"]

    // ログが1つのままであることを確認
    expect(todayLogs.length).toBe(1)
    expect(todayLogs[0].instanceId).toBe(instanceId)
    expect(todayLogs[0].executionComment).toBe("更新されたコメント")
    expect(todayLogs[0].focusLevel).toBe(5)
  })

  test("後方互換性: instanceIdがない既存ログも正しく処理される", async () => {
    // 既存のログ（instanceIdなし）
    const existingLogData = {
      metadata: {
        version: "2.0",
        month: "2025-01",
      },
      taskExecutions: {
        "2025-01-15": [
          {
            taskId: "TaskChute/Task/タスクA.md",
            taskName: "タスクA",
            taskType: "project",
            slot: "8:00-12:00",
            isCompleted: true,
            startTime: "10:00:00",
            stopTime: "10:30:00",
            duration: 1800,
            executionComment: "既存のコメント",
          },
        ],
      },
      dailySummary: {},
      patterns: {},
    }

    // TFileインスタンスのモック
      const mockFile = { path: 'mock-path' }
      mockFile.constructor = TFile
      Object.setPrototypeOf(mockFile, TFile.prototype)
      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
    mockApp.vault.read.mockResolvedValue(
      JSON.stringify(existingLogData),
    )

    const mockTask = {
      title: "タスクA",
      path: "TaskChute/Task/タスクA.md",
      file: { path: "TaskChute/Task/タスクA.md" },
      isRoutine: false,
    }

    // 新しいインスタンス（instanceIdあり）
    const newInstance = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-01-15T11:00:00"),
      stopTime: new Date("2025-01-15T11:45:00"),
      slotKey: "8:00-12:00",
      instanceId: taskChuteView.generateInstanceId(mockTask.path),
    }

    await taskChuteView.saveTaskCompletion(newInstance, {
      executionComment: "新しい実行",
      focusLevel: 4,
      energyLevel: 4,
    })

    const writtenData = JSON.parse(mockApp.vault.modify.mock.calls[0][1])
    const todayLogs = writtenData.taskExecutions["2025-01-15"]

    // 両方のログが保存されていることを確認
    expect(todayLogs.length).toBe(2)

    // 既存ログ（instanceIdなし）
    expect(todayLogs[0].taskId).toBe("TaskChute/Task/タスクA.md")
    expect(todayLogs[0].instanceId).toBeUndefined()
    expect(todayLogs[0].executionComment).toBe("既存のコメント")

    // 新規ログ（instanceIdあり）
    expect(todayLogs[1].instanceId).toBe(newInstance.instanceId)
    expect(todayLogs[1].executionComment).toBe("新しい実行")
  })
})
