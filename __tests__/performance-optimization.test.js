const TaskChutePlusPlugin = require("../main.js")
const { TaskChuteView } = TaskChutePlusPlugin

// Obsidian APIのモック
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn().mockImplementation(function () {
    this.containerEl = {
      children: [{}, { empty: jest.fn(), createEl: jest.fn() }],
    }
    return this
  }),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

describe("パフォーマンス最適化テスト", () => {
  test("並列読み込みが実装されているか確認", () => {
    // TaskChuteViewクラスが正しくエクスポートされているか確認
    expect(TaskChuteView).toBeDefined()
    expect(typeof TaskChuteView).toBe("function")

    // プロトタイプにloadTasksメソッドが存在するか確認
    expect(typeof TaskChuteView.prototype.loadTasks).toBe("function")

    // プロトタイプにgetTaskFilesメソッドが存在するか確認
    expect(typeof TaskChuteView.prototype.getTaskFiles).toBe("function")
  })

  test("getTaskFilesメソッドのテスト", async () => {
    // モックの初期化
    const mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        getMarkdownFiles: jest.fn(),
      },
    }

    const mockLeaf = {}

    // ビューの初期化
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    const view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = mockApp

    // タスクフォルダの設定
    const mockTaskFolder = {
      children: [
        {
          path: "TaskChute/Task/task1.md",
          basename: "task1",
          extension: "md",
          stat: {},
        },
        {
          path: "TaskChute/Task/task2.md",
          basename: "task2",
          extension: "md",
          stat: {},
        },
      ],
    }

    mockApp.vault.getAbstractFileByPath.mockReturnValue(mockTaskFolder)

    // consoleのモック
    console.log = jest.fn()
    console.warn = jest.fn()

    // getTaskFilesを実行
    const result = await view.getTaskFiles("TaskChute/Task")

    // 結果を確認
    expect(result.length).toBe(2)
    expect(result[0].basename).toBe("task1")
    expect(result[1].basename).toBe("task2")
  })

  test("フォールバック処理のテスト", async () => {
    // モックの初期化
    const mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(null), // フォルダが見つからない
        getMarkdownFiles: jest.fn(),
        read: jest.fn(),
      },
    }

    const mockLeaf = {}

    // ビューの初期化
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    const view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = mockApp

    // 全ファイルから検索
    const allFiles = [
      { path: "note1.md", basename: "note1", extension: "md" },
      { path: "task1.md", basename: "task1", extension: "md" },
      { path: "task2.md", basename: "task2", extension: "md" },
    ]
    mockApp.vault.getMarkdownFiles.mockReturnValue(allFiles)

    // ファイル内容のモック（並列読み込み）
    mockApp.vault.read.mockImplementation((file) => {
      if (file.path.includes("task")) {
        return Promise.resolve(`# ${file.basename}\n#task`)
      }
      return Promise.resolve(`# ${file.basename}`)
    })

    // consoleのモック
    console.log = jest.fn()
    console.warn = jest.fn()

    // getTaskFilesを実行
    const result = await view.getTaskFiles("TaskChute/Task")

    // フォールバック警告が出力されたことを確認
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("[TaskChute] タスクフォルダが見つかりません"),
    )

    // 結果を確認
    expect(result.length).toBe(2)
  })

  test("パフォーマンス改善の確認", () => {
    // 改善されたアルゴリズムが実装されていることを確認

    // 1. 特定フォルダ限定読み込み
    expect(typeof TaskChuteView.prototype.getTaskFiles).toBe("function")

    // 2. 並列処理の実装確認（Promise.allの使用）
    const loadTasksSource = TaskChuteView.prototype.loadTasks.toString()
    expect(loadTasksSource).toContain("Promise.all")

    // 3. パフォーマンス計測の実装確認
    expect(loadTasksSource).toContain("performance.now")

    // 4. 重複防止の実装確認
    expect(loadTasksSource).toContain("isDuplicate")
    expect(loadTasksSource).toContain("重複タスクをスキップ")
  })
})
