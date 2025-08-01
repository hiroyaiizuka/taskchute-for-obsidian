const { TaskChuteView } = require("../main.js")

describe("ルーチンタスクのコメント引き継ぎバグ", () => {
  let view
  let mockApp

  beforeEach(() => {
    // LocalStorageのモック
    global.localStorage = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    }

    // Obsidianアプリのモック
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        getAbstractFileByPath: jest.fn(),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
      fileManager: {
        processFrontMatter: jest.fn(),
      },
      metadataCache: {
        getFileCache: jest.fn(),
      },
    }

    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    // TaskChuteViewインスタンスを作成
    view = new TaskChuteView(null, mockPlugin)
    view.app = mockApp

    // 必要なプロパティを初期化
    view.taskInstances = []
    view.tasks = []

    // currentDateを設定可能にする
    view.currentDate = new Date(2025, 0, 15) // 2025-01-15
  })

  test("ルーチンタスクのコメントが次の日に引き継がれるバグを再現", async () => {
    // 1. 2025年1月のログファイルをモック（1/15にコメント付きタスクがある状態）
    const monthlyLog = {
      metadata: {
        version: "2.0",
        month: "2025-01",
        lastUpdated: "2025-01-15T10:00:00.000Z",
      },
      taskExecutions: {
        "2025-01-15": [
          {
            taskId: "task1.md",
            taskName: "朝の運動",
            taskType: "routine",
            slot: "8:00-12:00",
            isCompleted: true,
            startTime: "08:30:00",
            stopTime: "09:00:00",
            executionComment: "今日は調子が良かった！",
            focusLevel: 4,
            energyLevel: 5,
            instanceId: "task1.md#1642204800000#abc123", // インスタンスIDを追加
          },
        ],
        "2025-01-16": [], // 1/16にはまだコメントなし
      },
    }

    mockApp.vault.adapter.exists.mockImplementation((path) => {
      if (path === 'TaskChute/Log/2025-01-tasks.json') {
        return Promise.resolve(true)
      }
      return Promise.resolve(false)
    })
    mockApp.vault.adapter.read.mockImplementation((path) => {
      if (path === 'TaskChute/Log/2025-01-tasks.json') {
        return Promise.resolve(JSON.stringify(monthlyLog))
      }
      return Promise.resolve('{}')
    })

    // 2. ルーチンタスクのインスタンスを作成
    const routineTask = {
      title: "朝の運動",
      path: "task1.md",
      isRoutine: true,
    }

    const taskInstance = {
      task: routineTask,
      state: "done", // 完了状態のタスクでテスト（バグが発生していた状況）
      startTime: new Date(2025, 0, 15, 8, 30),
      stopTime: new Date(2025, 0, 15, 9, 0),
      slotKey: "8:00-12:00",
      instanceId: "task1.md#1642204800000#abc123", // 一意のインスタンスID
    }

    // 3. 2025-01-15（コメントがある日）での動作確認
    view.currentDate = new Date(2025, 0, 15) // 2025-01-15

    const comment15th = await view.getExistingTaskComment(taskInstance)
    expect(comment15th).not.toBeNull()
    expect(comment15th.executionComment).toBe("今日は調子が良かった！")

    const hasComment15th = await view.hasCommentData(taskInstance)
    expect(hasComment15th).toBe(true)

    // 4. 2025-01-16（コメントがない日）に移動
    view.currentDate = new Date(2025, 0, 16) // 2025-01-16

    // 1/16の新しいタスクインスタンスを作成（複製タスクをシミュレート）
    const newTaskInstance = {
      task: routineTask,
      state: "done", // 完了状態
      startTime: new Date(2025, 0, 16, 8, 30),
      stopTime: new Date(2025, 0, 16, 9, 0),
      slotKey: "8:00-12:00",
      instanceId: "task1.md#1642291200000#def456", // 異なるインスタンスID
    }

    // バグ: 修正前のコードでは、instanceIdでの検索が失敗すると
    // フォールバック検索でタスク名のみで検索していたため、
    // 前日のコメントが引き継がれてしまう問題があった
    const comment16th = await view.getExistingTaskComment(newTaskInstance)

    console.log("2025-01-16のコメント取得結果:", comment16th)

    const hasComment16th = await view.hasCommentData(newTaskInstance)

    // 修正後の期待動作: 異なるインスタンスIDのタスクは別々にコメントが管理される
    // 1/16にはコメントがないので、nullが返されるべき
    expect(hasComment16th).toBe(false)
    expect(comment16th).toBeNull()
  })

  test("getExistingTaskCommentが間違った日付を参照している問題を確認", async () => {
    // 現在の実装では、getExistingTaskCommentが内部でnew Date()を使用しているため
    // this.currentDateではなく実際の今日の日付を参照してしまう

    const monthlyLog = {
      taskExecutions: {
        "2025-01-15": [
          {
            taskName: "朝の運動",
            executionComment: "コメント",
          },
        ],
      },
    }

    mockApp.vault.adapter.exists.mockImplementation((path) => {
      if (path === 'TaskChute/Log/2025-01-tasks.json') {
        return Promise.resolve(true)
      }
      return Promise.resolve(false)
    })
    mockApp.vault.adapter.read.mockImplementation((path) => {
      if (path === 'TaskChute/Log/2025-01-tasks.json') {
        return Promise.resolve(JSON.stringify(monthlyLog))
      }
      return Promise.resolve('{}')
    })

    const taskInstance = {
      task: { title: "朝の運動" },
    }

    // currentDateを2025-01-15に設定
    view.currentDate = new Date(2025, 0, 15)

    // getExistingTaskCommentの内部でnew Date()が呼ばれるため
    // 実際のテスト実行日のログを見に行ってしまう
    const result = await view.getExistingTaskComment(taskInstance)

    // この結果は実際のテスト実行日によって変わってしまう（不安定）
    console.log("getExistingTaskCommentの結果:", result)
  })

  test("修正後の動作確認用テストケース", async () => {
    // このテストは修正後に正しく動作することを確認するためのもの

    const instanceId15 = "routine-task-20250115-123"
    const instanceId16 = "routine-task-20250116-456"

    const monthlyLog = {
      taskExecutions: {
        "2025-01-15": [
          {
            taskName: "朝の運動",
            instanceId: instanceId15,
            executionComment: "1/15のコメント",
            focusLevel: 4,
          },
        ],
        "2025-01-16": [
          {
            taskName: "朝の運動",
            instanceId: instanceId16,
            executionComment: "1/16のコメント",
            focusLevel: 3,
          },
        ],
      },
    }

    mockApp.vault.adapter.exists.mockImplementation((path) => {
      if (path === 'TaskChute/Log/2025-01-tasks.json') {
        return Promise.resolve(true)
      }
      return Promise.resolve(false)
    })
    mockApp.vault.adapter.read.mockImplementation((path) => {
      if (path === 'TaskChute/Log/2025-01-tasks.json') {
        return Promise.resolve(JSON.stringify(monthlyLog))
      }
      return Promise.resolve('{}')
    })

    // 1/15のコメントを確認
    view.currentDate = new Date(2025, 0, 15)
    const taskInstance15 = {
      task: { title: "朝の運動" },
      instanceId: instanceId15,
    }
    const comment15 = await view.getExistingTaskComment(taskInstance15)
    expect(comment15?.executionComment).toBe("1/15のコメント")

    // 1/16のコメントを確認
    view.currentDate = new Date(2025, 0, 16)
    const taskInstance16 = {
      task: { title: "朝の運動" },
      instanceId: instanceId16,
    }
    const comment16 = await view.getExistingTaskComment(taskInstance16)
    expect(comment16?.executionComment).toBe("1/16のコメント")

    // 1/17（コメントなし）を確認
    view.currentDate = new Date(2025, 0, 17)
    const taskInstance17 = {
      task: { title: "朝の運動" },
      instanceId: "routine-task-20250117-789", // 存在しないinstanceId
    }
    const comment17 = await view.getExistingTaskComment(taskInstance17)
    expect(comment17).toBeNull()
  })
})
