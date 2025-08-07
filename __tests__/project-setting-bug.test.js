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

// Obsidianのモック
const mockObsidian = {
  ItemView: class ItemView {
    constructor(leaf) {
      this.leaf = leaf
      this.app = mockObsidian.app
    }
  },
  Plugin: class Plugin {},
  Notice: jest.fn((msg) => console.log(`Notice: ${msg}`)),
  TFile: class TFile {
    constructor(path, name) {
      this.path = path
      this.basename = name
    }
  },
  app: {
    vault: {
        adapter: {
        exists: jest.fn(),
        read: jest.fn(),
        write: jest.fn(),
        mkdir: jest.fn(),
      },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        createFolder: jest.fn(),
      getMarkdownFiles: jest.fn(() => []),
    },
    workspace: {
      onLayoutReady: jest.fn(),
    },
    fileManager: {
      processFrontMatter: jest.fn(),
    },
    metadataCache: {
      getFileCache: jest.fn(),
    },
  },
}

// グローバルにモックを設定
global.require = (name) => {
  if (name === "obsidian") return mockObsidian
  return {}
}

describe("プロジェクト設定バグの修正確認", () => {
  let taskChuteView
  let mockVaultAdapter

  beforeEach(() => {
    // モックのリセット
    jest.clearAllMocks()

    // 日付をモック（2024-01-15に固定）
    const mockDate = new Date(2024, 0, 15) // 2024-01-15
    jest.spyOn(global, 'Date').mockImplementation(() => mockDate)
    Date.now = jest.fn(() => mockDate.getTime())

    mockVaultAdapter = mockObsidian.app.vault.adapter

    // TaskChuteViewのインスタンス作成
    const mockLeaf = { view: null }
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = mockObsidian.app

    // 現在日付を設定
    taskChuteView.currentDate = mockDate

    // 必要なプロパティを初期化
    taskChuteView.taskInstances = []
    taskChuteView.tasks = []

    // renderTaskListをモック（DOM操作を避けるため）
    taskChuteView.renderTaskList = jest.fn()
  })

  afterEach(() => {
    // 日付モックをリストア
    jest.restoreAllMocks()
  })

  describe("修正後のプロジェクト情報保存", () => {
    test("プロジェクトが設定されたタスクで正しく project フィールドに保存される", async () => {
      // プロジェクトが設定されたタスクオブジェクトを作成
      const mockTask = {
        title: "開発プロジェクトタスク",
        path: "TaskChute/Task/開発プロジェクトタスク.md",
        isRoutine: false,
        projectPath: "TaskChute/Project/アプリ開発.md",
        projectTitle: "アプリ開発",
      }

      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date("2024-01-15T14:00:00"),
        stopTime: new Date("2024-01-15T15:30:00"),
        slotKey: "12:00-16:00",
        instanceId: "test-instance-fixed-123",
      }

      // モックの設定
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockObsidian.app.vault.getAbstractFileByPath.mockReturnValue(null) // 新規作成
      mockObsidian.app.vault.create.mockResolvedValue()
      mockObsidian.app.vault.modify.mockResolvedValue()
      mockObsidian.app.vault.createFolder.mockResolvedValue()

      console.log("修正確認テスト開始: saveTaskCompletion を実行")

      try {
        // saveTaskCompletion を実行
        await taskChuteView.saveTaskCompletion(instance, {
          executionComment: "プロジェクト修正確認テスト",
          focusLevel: 5,
          energyLevel: 4,
          timestamp: "2024-01-15T15:30:00.000Z",
        })

        console.log("saveTaskCompletion 実行完了")

        // create が呼ばれたことを確認（新規作成の場合）
        expect(mockObsidian.app.vault.create).toHaveBeenCalledTimes(1)

        // 保存されたデータを取得
        const writeCall = mockObsidian.app.vault.create.mock.calls[0]
        const savedData = JSON.parse(writeCall[1])

        // 修正確認：project が正しく projectTitle で保存されていることを確認
        const taskExecution = savedData.taskExecutions["2024-01-15"][0]

        console.log("保存されたタスク実行データ:", taskExecution)
        console.log("プロジェクト情報:")
        console.log("  - projectPath:", mockTask.projectPath)
        console.log("  - projectTitle:", mockTask.projectTitle)
        console.log("  - 保存されたproject:", taskExecution.project)

        // 修正確認：プロジェクト情報が正しく保存されている
        expect(taskExecution.project).toBe("アプリ開発")
        expect(taskExecution.project).not.toBeNull()
        expect(taskExecution.taskName).toBe("開発プロジェクトタスク")
        expect(taskExecution.taskType).toBe("project")

        // タスクオブジェクトの元のプロジェクト情報も確認
        expect(mockTask.projectPath).toBe("TaskChute/Project/アプリ開発.md")
        expect(mockTask.projectTitle).toBe("アプリ開発")
      } catch (error) {
        console.error("修正確認テスト実行中にエラー:", error)
        throw error
      }
    })

    test("プロジェクトが設定されていないタスクでは正常に null になる", async () => {
      // プロジェクト設定なしのタスクオブジェクトを作成
      const mockTask = {
        title: "単発タスク",
        path: "TaskChute/Task/単発タスク.md",
        isRoutine: false,
        projectPath: null,
        projectTitle: null,
      }

      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date("2024-01-15T16:00:00"),
        stopTime: new Date("2024-01-15T16:15:00"),
        slotKey: "16:00-0:00",
        instanceId: "test-instance-no-project-456",
      }

      // モックの設定
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockObsidian.app.vault.getAbstractFileByPath.mockReturnValue(null) // 新規作成
      mockObsidian.app.vault.create.mockResolvedValue()
      mockObsidian.app.vault.modify.mockResolvedValue()
      mockObsidian.app.vault.createFolder.mockResolvedValue()

      // saveTaskCompletion を実行
      await taskChuteView.saveTaskCompletion(instance, {
        executionComment: "単発作業完了",
        focusLevel: 3,
        energyLevel: 4,
        timestamp: "2024-01-15T16:15:00.000Z",
      })

      // 保存されたデータを取得
      const writeCall = mockObsidian.app.vault.create.mock.calls[0]
      const savedData = JSON.parse(writeCall[1])
      const taskExecution = savedData.taskExecutions["2024-01-15"][0]

      console.log("プロジェクト設定なしタスクの保存データ:", taskExecution)

      // プロジェクト設定なしの場合は正常に null になることを確認
      expect(taskExecution.project).toBeNull()
      expect(taskExecution.taskName).toBe("単発タスク")
      expect(taskExecution.taskType).toBe("project")
      expect(mockTask.projectPath).toBeNull()
      expect(mockTask.projectTitle).toBeNull()
    })

    test("ルーチンタスクでもプロジェクト設定が正しく保存される", async () => {
      // プロジェクトが設定されたルーチンタスクを作成
      const mockTask = {
        title: "朝のコードレビュー",
        path: "TaskChute/Task/朝のコードレビュー.md",
        isRoutine: true,
        projectPath: "TaskChute/Project/品質管理.md",
        projectTitle: "品質管理",
      }

      const instance = {
        task: mockTask,
        state: "done",
        startTime: new Date("2024-01-15T09:00:00"),
        stopTime: new Date("2024-01-15T09:30:00"),
        slotKey: "8:00-12:00",
        instanceId: "test-routine-with-project-789",
      }

      // モックの設定
      // TFileインスタンスのモック
      const mockLogFile = { path: 'TaskChute/Log/2024-01-tasks.json' }
      mockLogFile.constructor = TFile
      Object.setPrototypeOf(mockLogFile, TFile.prototype)
      
      mockObsidian.app.vault.getAbstractFileByPath.mockReturnValue(null) // 新規作成
      mockObsidian.app.vault.create.mockResolvedValue()
      mockObsidian.app.vault.modify.mockResolvedValue()
      mockObsidian.app.vault.createFolder.mockResolvedValue()

      // saveTaskCompletion を実行
      await taskChuteView.saveTaskCompletion(instance, {
        executionComment: "順調にレビュー完了",
        focusLevel: 4,
        energyLevel: 5,
        timestamp: "2024-01-15T09:30:00.000Z",
      })

      // 保存されたデータを取得
      const writeCall = mockObsidian.app.vault.create.mock.calls[0]
      const savedData = JSON.parse(writeCall[1])
      const taskExecution = savedData.taskExecutions["2024-01-15"][0]

      console.log("ルーチンタスクの保存データ:", taskExecution)

      // ルーチンタスクでもプロジェクト情報が正しく保存される
      expect(taskExecution.project).toBe("品質管理")
      expect(taskExecution.taskName).toBe("朝のコードレビュー")
      expect(taskExecution.taskType).toBe("routine") // ルーチンタスクはtaskTypeがroutine
      expect(mockTask.projectTitle).toBe("品質管理")
    })
  })

  describe("バグ修正前後の比較", () => {
    test("修正前と修正後のコード動作比較", () => {
      // プロジェクト設定があるタスクオブジェクト
      const mockTask = {
        title: "比較テストタスク",
        path: "TaskChute/Task/比較テストタスク.md",
        projectPath: "TaskChute/Project/比較プロジェクト.md",
        projectTitle: "比較プロジェクト",
        // 修正前: project プロパティは存在しない
      }

      const instance = {
        task: mockTask,
        state: "done",
        slotKey: "8:00-12:00",
      }

      // 修正前のコード（バグ）
      const buggyResult = instance.task.project || null // undefined || null = null

      // 修正後のコード（正しい）
      const fixedResult = instance.task.projectTitle || null // "比較プロジェクト" || null = "比較プロジェクト"

      console.log("修正前（バグ）の結果:", buggyResult)
      console.log("修正後（正しい）の結果:", fixedResult)

      // 修正前はnullになってしまう（バグ）
      expect(buggyResult).toBeNull()

      // 修正後は正しくプロジェクト名が取得できる
      expect(fixedResult).toBe("比較プロジェクト")

      // タスクオブジェクトの状態確認
      expect(instance.task.project).toBeUndefined() // 存在しない
      expect(instance.task.projectTitle).toBe("比較プロジェクト") // 正しく存在
    })
  })
})
