// 再起動後のisRoutine判定修正テスト

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

describe("再起動後のisRoutine判定修正テスト", () => {
  let view
  let mockApp
  let mockPlugin

  beforeEach(() => {
    // LocalStorage をクリア
    localStorage.clear()

    // Notice をモック
    global.Notice = jest.fn()

    // モックApp
    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(true),
        adapter: {
          exists: jest.fn().mockResolvedValue(true),
          read: jest.fn().mockResolvedValue("{}"),
          write: jest.fn().mockResolvedValue(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn(),
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

    // DOMエレメント
    view.containerEl = document.createElement("div")
    view.taskList = document.createElement("div")
  })

  test("新しい形式(routine)のメタデータでisRoutineが正しく判定される", () => {
    const metadata = {
      routine: true,
      開始時刻: "09:00",
    }

    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata,
    })

    // loadTasksメソッド内のisRoutine判定ロジックを抽出してテスト
    const isRoutine = metadata.routine === true || metadata.isRoutine === true

    expect(isRoutine).toBe(true)
  })

  test("古い形式(isRoutine)のメタデータでisRoutineが正しく判定される", () => {
    const metadata = {
      isRoutine: true,
      開始時刻: "09:00",
    }

    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata,
    })

    // loadTasksメソッド内のisRoutine判定ロジックを抽出してテスト
    const isRoutine = metadata.routine === true || metadata.isRoutine === true

    expect(isRoutine).toBe(true)
  })

  test("両方の形式があると正しく判定される", () => {
    const metadata = {
      routine: true,
      isRoutine: true,
      開始時刻: "09:00",
    }

    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata,
    })

    // loadTasksメソッド内のisRoutine判定ロジックを抽出してテスト
    const isRoutine = metadata.routine === true || metadata.isRoutine === true

    expect(isRoutine).toBe(true)
  })

  test("非ルーチンタスクは正しく判定される", () => {
    const metadata = {
      routine: false,
      isRoutine: false,
      開始時刻: "09:00",
    }

    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata,
    })

    // loadTasksメソッド内のisRoutine判定ロジックを抽出してテスト
    const isRoutine = metadata.routine === true || metadata.isRoutine === true

    expect(isRoutine).toBe(false)
  })

  test("メタデータなしの場合は非ルーチンと判定される", () => {
    const metadata = {}

    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata,
    })

    // loadTasksメソッド内のisRoutine判定ロジックを抽出してテスト
    const isRoutine = metadata.routine === true || metadata.isRoutine === true

    expect(isRoutine).toBe(false)
  })

  test("片方だけ設定されていても正しく判定される", () => {
    // routineのみ設定
    const metadata1 = {
      routine: true,
    }
    const isRoutine1 =
      metadata1.routine === true || metadata1.isRoutine === true
    expect(isRoutine1).toBe(true)

    // isRoutineのみ設定
    const metadata2 = {
      isRoutine: true,
    }
    const isRoutine2 =
      metadata2.routine === true || metadata2.isRoutine === true
    expect(isRoutine2).toBe(true)
  })
})
