const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

describe("時刻修正時の二重記録バグ", () => {
  let taskChuteView
  let mockApp
  let mockLeaf

  const MOCK_EXISTING_JSON = {
    metadata: {
      version: "2.0",
      month: "2025-07",
      lastUpdated: "2025-07-11T08:40:38.014Z",
      totalDays: 31,
      activeDays: 1,
    },
    dailySummary: {
      "2025-07-11": {
        totalTasks: 1,
        completedTasks: 1,
        totalFocusTime: 3600,
        productivityScore: 0.8,
        averageFocus: 4,
        averageSatisfaction: 4.5,
        tasksWithComments: 0,
        lastModified: "2025-07-11T08:40:38.014Z",
      },
    },
    taskExecutions: {
      "2025-07-11": [
        {
          taskId: "TaskChute/Task/タスクシュートレビュー.md",
          taskName: "タスクシュートレビュー",
          taskType: "routine",
          project: null,
          slot: "8:00-12:00",
          isCompleted: "2025-07-11T02:02:09.177Z",
          startTime: "09:53:05", // 元の開始時刻
          stopTime: "11:02:09",
          duration: 4144,
        },
      ],
    },
    patterns: {},
  }

  beforeEach(() => {
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          mkdir: jest.fn(),
        },
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        create: jest.fn(),
        modify: jest.fn(),
        getAbstractFileByPath: jest.fn(),
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
    }

    mockLeaf = {
      containerEl: {
        children: [{}, { empty: jest.fn(), createEl: jest.fn() }],
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

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = mockApp
    taskChuteView.containerEl = mockLeaf.containerEl
    taskChuteView.tasks = []
    taskChuteView.taskInstances = []
    taskChuteView.runningInstances = []
    taskChuteView.renderTaskList = jest.fn()

    // 現在の日時を固定（2025-07-11に設定）
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2025-07-11T12:00:00.000Z"))
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  test("バグ修正後: 時刻修正時にタスクが正しく更新される", async () => {
    // 既存JSONファイルをモック
    mockApp.vault.adapter.exists.mockResolvedValue(true)
    mockApp.vault.adapter.read.mockResolvedValue(
      JSON.stringify(MOCK_EXISTING_JSON),
    )

    // 完了済みタスクのインスタンスを作成（時刻修正後の状態）
    const mockTask = {
      title: "タスクシュートレビュー",
      path: "TaskChute/Task/タスクシュートレビュー.md",
      file: {},
      isRoutine: true,
      scheduledTime: null,
      slotKey: "8:00-12:00",
    }

    const completedInstance = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-07-11T00:55:00.000Z"), // 修正後の開始時刻 09:55:00
      stopTime: new Date("2025-07-11T02:02:09.177Z"), // 元の終了時刻
      slotKey: "8:00-12:00",
      // instanceIdを明示的に設定しない（undefinedの状態）
    }

    // saveTaskCompletionを実行
    await taskChuteView.saveTaskCompletion(completedInstance, null)

    // JSON書き込みが呼ばれたことを確認
    expect(mockApp.vault.adapter.write).toHaveBeenCalled()

    // 書き込まれた内容を取得
    const writeCall = mockApp.vault.adapter.write.mock.calls[0]
    const writtenContent = JSON.parse(writeCall[1])

    // 同じ日のタスク実行ログを確認
    const tasksForDay = writtenContent.taskExecutions["2025-07-11"]

    // 同じタスク名のエントリ数をカウント
    const duplicateTasks = tasksForDay.filter(
      (task) => task.taskName === "タスクシュートレビュー",
    )

    console.log("書き込まれたタスク数:", tasksForDay.length)
    console.log("同名タスク数:", duplicateTasks.length)
    console.log("タスク詳細:", duplicateTasks)

    // 修正後：1つのエントリのみ存在し、時刻が更新されている
    expect(duplicateTasks.length).toBe(1) // 正しく修正された状態

    // 既存のエントリが時刻更新されていることを確認
    expect(duplicateTasks[0].startTime).toBe("09:55:00") // 新しい開始時刻
    expect(duplicateTasks[0].stopTime).toBe("11:02:09") // 元の終了時刻は維持
    expect(duplicateTasks[0].taskId).toBe(
      "TaskChute/Task/タスクシュートレビュー.md",
    )
  })

  test("時刻修正時の期待される正しい動作（修正後）", async () => {
    // 修正後のテスト: 正しく既存エントリが更新されることを確認

    mockApp.vault.adapter.exists.mockResolvedValue(true)
    mockApp.vault.adapter.read.mockResolvedValue(
      JSON.stringify(MOCK_EXISTING_JSON),
    )

    const mockTask = {
      title: "タスクシュートレビュー",
      path: "TaskChute/Task/タスクシュートレビュー.md",
      file: {},
      isRoutine: true,
      scheduledTime: null,
      slotKey: "8:00-12:00",
    }

    const completedInstance = {
      task: mockTask,
      state: "done",
      startTime: new Date("2025-07-11T00:55:00.000Z"), // 修正後の開始時刻
      stopTime: new Date("2025-07-11T02:02:09.177Z"), // 元の終了時刻
      slotKey: "8:00-12:00",
      // instanceIdを明示的に設定しない（undefinedの状態）
    }

    await taskChuteView.saveTaskCompletion(completedInstance, null)

    const writeCall = mockApp.vault.adapter.write.mock.calls[0]
    const writtenContent = JSON.parse(writeCall[1])
    const tasksForDay = writtenContent.taskExecutions["2025-07-11"]

    const duplicateTasks = tasksForDay.filter(
      (task) => task.taskName === "タスクシュートレビュー",
    )

    // 修正後の期待される動作：1つのエントリのみ存在し、時刻が更新されている
    expect(duplicateTasks.length).toBe(1) // 修正後の期待値
    expect(duplicateTasks[0].startTime).toBe("09:55:00") // 修正後の開始時刻
    expect(duplicateTasks[0].taskId).toBe(
      "TaskChute/Task/タスクシュートレビュー.md",
    ) // 正しいtaskId
  })
})
