const { TaskChuteView } = require("../main.js")

describe("コメント分離の修正確認", () => {
  let taskChuteView
  let mockApp

  beforeEach(() => {
    // Mock app
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
        },
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

    taskChuteView = new TaskChuteView(null, mockPlugin)
    taskChuteView.app = mockApp
    taskChuteView.currentDate = new Date(2025, 0, 15)
  })

  test("複製されたタスクは元のタスクのコメントを引き継がない", async () => {
    // テストデータを準備：元のタスクにコメントが存在
    const logData = {
      taskExecutions: {
        "2025-01-15": [
          {
            instanceId: "original-task-123",
            taskName: "テストタスク",
            executionComment: "元のタスクのコメント",
            focusLevel: 4,
            energyLevel: 5,
          },
        ],
      },
    }

    mockApp.vault.adapter.exists.mockResolvedValue(true)
    mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(logData))

    // 元のタスクインスタンス
    const originalInstance = {
      instanceId: "original-task-123",
      task: { title: "テストタスク" },
      state: "done",
    }

    // 複製されたタスクインスタンス（異なるinstanceId）
    const duplicatedInstance = {
      instanceId: "duplicated-task-456", // 異なるID
      task: { title: "テストタスク" }, // 同じタスク名
      state: "idle",
    }

    // 元のタスクではコメントが取得できる
    const originalComment = await taskChuteView.getExistingTaskComment(
      originalInstance,
    )
    expect(originalComment).toBeTruthy()
    expect(originalComment.executionComment).toBe("元のタスクのコメント")

    // 複製されたタスクではコメントが取得できない（修正により期待される動作）
    const duplicatedComment = await taskChuteView.getExistingTaskComment(
      duplicatedInstance,
    )
    expect(duplicatedComment).toBeNull()
  })

  test("instanceIdがないタスクはコメントが取得できない（修正により期待される動作）", async () => {
    // ログファイルにデータがあっても
    const logData = {
      taskExecutions: {
        "2025-01-15": [
          {
            taskName: "古いタスク",
            executionComment: "古いコメント",
          },
        ],
      },
    }

    mockApp.vault.adapter.exists.mockResolvedValue(true)
    mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(logData))

    // instanceIdがないタスクインスタンス
    const instanceWithoutId = {
      // instanceId: なし
      task: { title: "古いタスク" },
      state: "done",
    }

    // instanceIdがない場合はコメントが取得できない（修正後の期待動作）
    const result = await taskChuteView.getExistingTaskComment(instanceWithoutId)
    expect(result).toBeNull()
  })

  test("実行開始前のタスクでもinstanceIdベースでのみ検索する", async () => {
    // テストデータを準備
    const logData = {
      taskExecutions: {
        "2025-01-15": [
          {
            instanceId: "task-with-comment-123",
            taskName: "テストタスク",
            executionComment: "既存のコメント",
            focusLevel: 3,
          },
        ],
      },
    }

    mockApp.vault.adapter.exists.mockResolvedValue(true)
    mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(logData))

    // 同じタスク名だが異なるinstanceIdを持つ、未実行状態のタスク
    const idleInstanceWithDifferentId = {
      instanceId: "different-task-456", // 異なるID
      task: { title: "テストタスク" }, // 同じタスク名
      state: "idle", // 未実行状態
    }

    // 修正前はstate !== "idle"の条件でフォールバック検索が実行されていたが、
    // 修正後はinstanceIdでのみ検索するため、コメントは取得できない
    const result = await taskChuteView.getExistingTaskComment(
      idleInstanceWithDifferentId,
    )
    expect(result).toBeNull()
  })
})
