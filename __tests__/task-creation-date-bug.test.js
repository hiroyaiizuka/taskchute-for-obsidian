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

describe("Task Creation Date Bug - Simple Test", () => {
  let view
  let mockApp
  let mockLeaf

  beforeEach(() => {
    // 最小限のモックのみを使用
    mockApp = {
      vault: {
        create: jest.fn().mockResolvedValue({
          basename: "テストタスク",
          path: "TaskChute/Task/テストタスク.md",
          extension: "md",
        }),
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn().mockResolvedValue("#task\n\nテスト内容"),
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(),
        },
        getAbstractFileByPath: jest.fn().mockReturnValue(null),
      },
      fileManager: {
        processFrontMatter: jest.fn().mockResolvedValue(),
      },
    }

    mockLeaf = { view: null }
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = mockApp

    // 必要な要素を直接設定
    view.tasks = []
    view.taskInstances = []

    // 今日の日付を設定（2025-01-19）
    view.currentDate = new Date(2025, 0, 19) // 月は0ベース

    // loadTasksをモック（メモリ問題を回避）
    view.loadTasks = jest.fn().mockResolvedValue()
    view.renderTaskList = jest.fn()

    // Noticeクラスをモック
    global.Notice = jest.fn()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test("createNewTaskでtarget_dateメタデータが正しく生成される", async () => {
    // 明日の日付に設定
    view.currentDate = new Date(2025, 0, 20) // 2025-01-20

    try {
      await view.createNewTask("テストタスク", "テスト説明")

      // ファイル作成が呼ばれたかを確認
      expect(view.app.vault.create).toHaveBeenCalled()

      // ファイル作成時にtarget_dateが正しく設定されることを確認
      expect(view.app.vault.create).toHaveBeenCalledWith(
        "TaskChute/Task/テストタスク.md",
        expect.stringContaining("target_date: 2025-01-20"),
      )

      // loadTasksが呼ばれることを確認
      expect(view.loadTasks).toHaveBeenCalled()
    } catch (error) {
      console.error("createNewTask エラー:", error)
      throw error
    }
  })

  test("createNewTaskで今日の日付のtarget_dateが設定される", async () => {
    // 今日の日付のまま
    view.currentDate = new Date(2025, 0, 19) // 2025-01-19

    await view.createNewTask("今日のタスク", "今日の説明")

    // ファイル作成時にtarget_dateが今日の日付で設定されることを確認
    expect(view.app.vault.create).toHaveBeenCalledWith(
      "TaskChute/Task/今日のタスク.md",
      expect.stringContaining("target_date: 2025-01-19"),
    )

    // loadTasksが呼ばれることを確認
    expect(view.loadTasks).toHaveBeenCalled()
  })

  test("target_dateメタデータの日付フォーマットが正しい", async () => {
    // 様々な日付でテスト
    const testDates = [
      { date: new Date(2025, 0, 1), expected: "2025-01-01" },
      { date: new Date(2025, 11, 31), expected: "2025-12-31" },
      { date: new Date(2025, 5, 15), expected: "2025-06-15" },
    ]

    for (const testCase of testDates) {
      view.currentDate = testCase.date

      await view.createNewTask("テストタスク", "説明")

      // 正しい日付フォーマットが使用されることを確認
      expect(view.app.vault.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining(`target_date: ${testCase.expected}`),
      )

      // モックをリセット
      view.app.vault.create.mockClear()
    }
  })

  test("修正前の問題：createNewTask後にloadTasksが呼ばれる", async () => {
    // 明日の日付で新規タスクを作成
    view.currentDate = new Date(2025, 0, 20)

    await view.createNewTask("修正確認タスク", "修正確認")

    // 修正により、createNewTask後にloadTasksが呼ばれるようになった
    expect(view.loadTasks).toHaveBeenCalled()

    console.log("修正確認：createNewTask後にloadTasksが呼ばれています")
  })
})
