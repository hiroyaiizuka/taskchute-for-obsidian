// ルーチンタスクファイル保護テスト

// Obsidianモジュールのモック
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
  normalizePath: jest.fn((path) => path),
}))

const { TaskChuteView } = require("../main")
const { TFile } = require("obsidian")

describe("ルーチンタスクファイル保護テスト", () => {
  let view
  let mockApp
  let mockPlugin
  let mockVault
  let routineTask
  let originalInstance
  let duplicatedInstance

  beforeEach(() => {
    // LocalStorage をクリア
    localStorage.clear()

    // Notice をモック
    global.Notice = jest.fn()

    // モックVault
    mockVault = {
      delete: jest.fn().mockResolvedValue(),
      getAbstractFileByPath: jest.fn().mockReturnValue(true),
      adapter: {
        exists: jest.fn().mockResolvedValue(true),
        read: jest.fn().mockResolvedValue("{}"),
        write: jest.fn().mockResolvedValue(),
      },
    }

    // モックApp
    mockApp = {
      vault: mockVault,
      metadataCache: {
        getFileCache: jest.fn((file) => {
          // ルーチンタスクの場合、正しいメタデータを返す
          if (file && file.path && file.path.includes("ルーチンタスク")) {
            return {
              frontmatter: {
                routine: true,
                isRoutine: true,
              },
            }
          }
          // 非ルーチンタスクの場合
          return {
            frontmatter: {
              routine: false,
              isRoutine: false,
            },
          }
        }),
      },
    }

    // モックPlugin
    mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue("Tasks"),
        getLogDataPath: jest.fn().mockReturnValue("Data/Log"),
      },
      routineAliasManager: {
        getAliases: jest.fn().mockReturnValue([]),
      },
    }

    // TaskChuteViewインスタンスを作成
    const mockLeaf = {}
    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = mockApp
    view.plugin = mockPlugin
    view.currentDate = new Date("2024-01-15")

    // 必要なメソッドをモック
    view.getCurrentDateString = jest.fn().mockReturnValue("2024-01-15")
    view.renderTaskList = jest.fn()
    view.saveRunningTasksState = jest.fn().mockResolvedValue()
    view.getHiddenRoutines = jest.fn().mockReturnValue([])
    view.saveHiddenRoutines = jest.fn()
    view.deleteTaskLogsByInstanceId = jest.fn().mockResolvedValue(1)

    // DOMエレメント
    view.containerEl = document.createElement("div")
    view.taskList = document.createElement("div")

    // テスト用のルーチンタスクを作成
    routineTask = {
      title: "ルーチンタスクA",
      path: "Tasks/ルーチンタスクA.md",
      isRoutine: true,
      file: new TFile(),
    }

    originalInstance = {
      task: routineTask,
      state: "done",
      instanceId: "original-instance-123",
    }

    duplicatedInstance = {
      task: routineTask,
      state: "done",
      instanceId: "duplicated-instance-456",
    }

    // localStorage に複製情報を設定
    localStorage.setItem(
      "taskchute-duplicated-instances-2024-01-15",
      JSON.stringify([
        {
          path: routineTask.path,
          instanceId: duplicatedInstance.instanceId,
        },
      ]),
    )

    // isDuplicatedTask をモック
    view.isDuplicatedTask = jest.fn().mockImplementation((inst, dateStr) => {
      return inst.instanceId === duplicatedInstance.instanceId
    })
  })

  test("ユーザーが報告したシナリオ: 複製削除後のオリジナル削除でファイルが保護される", async () => {
    // 初期状態: オリジナルと複製が存在
    view.tasks = [routineTask]
    view.taskInstances = [originalInstance, duplicatedInstance]

    // ステップ1: 複製されたタスクを削除
    await view.deleteRoutineTask(duplicatedInstance)

    // この時点で taskInstances は [originalInstance] のみになる
    expect(view.taskInstances).toEqual([originalInstance])
    expect(view.tasks).toEqual([routineTask]) // タスクリストは保持
    expect(mockVault.delete).not.toHaveBeenCalled() // ファイル削除なし

    // ステップ2: オリジナルタスクを削除
    await view.deleteRoutineTask(originalInstance)

    // 検証: ルーチンタスクはファイル削除されない
    expect(view.taskInstances).toEqual([]) // インスタンスは削除
    expect(view.tasks).toEqual([routineTask]) // タスクリストは保持
    expect(mockVault.delete).not.toHaveBeenCalled() // ファイル削除されない！
    expect(view.saveHiddenRoutines).toHaveBeenCalled() // 非表示リストに追加
  })

  test("非ルーチンタスクは最後のインスタンス削除時にファイルも削除される", async () => {
    // 非ルーチンタスクを作成
    const nonRoutineTask = {
      title: "非ルーチンタスク",
      path: "Tasks/非ルーチンタスク.md",
      isRoutine: false,
      file: new TFile(),
    }

    const nonRoutineInstance = {
      task: nonRoutineTask,
      state: "done",
      instanceId: "non-routine-instance",
    }

    view.tasks = [nonRoutineTask]
    view.taskInstances = [nonRoutineInstance]

    // 非ルーチンタスクは複製されていない
    view.isDuplicatedTask.mockReturnValue(false)

    await view.deleteRoutineTask(nonRoutineInstance)

    // 検証: 非ルーチンタスクはファイルも削除される
    expect(view.taskInstances).toEqual([])
    expect(view.tasks).toEqual([]) // タスクリストからも削除
    expect(mockVault.delete).toHaveBeenCalledWith(nonRoutineTask.file)
  })

  test("複数インスタンスがある非ルーチンタスクはファイル削除されない", async () => {
    const nonRoutineTask = {
      title: "非ルーチンタスク",
      path: "Tasks/非ルーチンタスク.md",
      isRoutine: false,
      file: new TFile(),
    }

    const instance1 = {
      task: nonRoutineTask,
      state: "done",
      instanceId: "instance-1",
    }

    const instance2 = {
      task: nonRoutineTask,
      state: "idle",
      instanceId: "instance-2",
    }

    view.tasks = [nonRoutineTask]
    view.taskInstances = [instance1, instance2]
    view.isDuplicatedTask.mockReturnValue(false)

    // instance1 を削除（instance2 が残る）
    await view.deleteRoutineTask(instance1)

    // 検証: まだインスタンスが残っているのでファイル削除されない
    expect(view.taskInstances).toEqual([instance2])
    expect(view.tasks).toEqual([nonRoutineTask]) // タスクリスト保持
    expect(mockVault.delete).not.toHaveBeenCalled() // ファイル削除なし
  })

  test("ルーチンタスクは常にファイルが保護される", async () => {
    // 単一のルーチンタスクインスタンスでもファイル削除されない
    view.tasks = [routineTask]
    view.taskInstances = [originalInstance]
    view.isDuplicatedTask.mockReturnValue(false)

    await view.deleteRoutineTask(originalInstance)

    // 検証: ルーチンタスクは単一インスタンスでもファイル保護
    expect(view.taskInstances).toEqual([])
    expect(view.tasks).toEqual([routineTask]) // タスクリスト保持
    expect(mockVault.delete).not.toHaveBeenCalled() // ファイル削除されない
    expect(view.saveHiddenRoutines).toHaveBeenCalled() // 非表示化のみ
  })
})
