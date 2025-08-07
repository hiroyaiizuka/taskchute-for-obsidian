// Obsidianのモック
jest.mock("obsidian", () => ({
  Plugin: class Plugin {},
  ItemView: class ItemView {
    constructor() {}
  },
  Notice: jest.fn(),
}))

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

// モックの設定
const mockApp = {
  vault: {
    getMarkdownFiles: jest.fn(() => []),
    read: jest.fn(),
    adapter: {
      exists: jest.fn(() => false),
      read: jest.fn(),
      write: jest.fn(),
    },
  },
  metadataCache: {
    getFileCache: jest.fn(() => null),
  },
  workspace: {
    openLinkText: jest.fn(),
  },
  fileManager: {
    processFrontMatter: jest.fn(),
  },
}

const mockLeaf = {}

describe("時間指定なしタスクの実行時移動", () => {
  let view
  let mockDate

  beforeEach(() => {
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
    view.taskList = {
      empty: jest.fn(),
      createEl: jest.fn(() => ({
        createEl: jest.fn(() => ({
          addEventListener: jest.fn(),
          createEl: jest.fn(),
          querySelector: jest.fn(),
          querySelectorAll: jest.fn(() => []),
        })),
        addEventListener: jest.fn(),
      })),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn(() => []),
    }
    // 下部タイマー表示は削除されたため、モック不要

    // renderTaskListとmanageTimersのモック
    view.renderTaskList = jest.fn()
    view.manageTimers = jest.fn()
    view.saveRunningTasksState = jest.fn()
    view.saveTaskCompletion = jest.fn()
    view.checkAllTasksCompleted = jest.fn()

    // 11:00の時刻を設定（8:00-12:00の時間帯）
    mockDate = new Date(2024, 0, 15, 11, 0, 0)
    jest.useFakeTimers()
    jest.setSystemTime(mockDate)

    // localStorageのモック
    const localStorageMock = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    }
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    })

    // getCurrentTimeSlotが正しく動作するように設定
    view.currentDate = mockDate
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  test("時間指定なしタスクを実行すると現在の時間帯（8:00-12:00）に移動する", async () => {
    // タスクインスタンスを設定
    const taskE = {
      title: "タスクE",
      path: "task-e.md",
      isRoutine: false,
    }

    const instanceE = {
      task: taskE,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "none", // 時間指定なし
      manuallyPositioned: false,
    }

    view.taskInstances = [
      // 8:00-12:00の既存タスク
      {
        task: { title: "タスクA", path: "task-a.md" },
        state: "done",
        slotKey: "8:00-12:00",
        startTime: new Date(2024, 0, 15, 8, 0, 0),
        stopTime: new Date(2024, 0, 15, 8, 30, 0),
      },
      {
        task: { title: "タスクB", path: "task-b.md" },
        state: "done",
        slotKey: "8:00-12:00",
        startTime: new Date(2024, 0, 15, 8, 30, 0),
        stopTime: new Date(2024, 0, 15, 9, 0, 0),
      },
      {
        task: { title: "タスクC", path: "task-c.md" },
        state: "done",
        slotKey: "8:00-12:00",
        startTime: new Date(2024, 0, 15, 9, 0, 0),
        stopTime: new Date(2024, 0, 15, 9, 30, 0),
      },
      {
        task: { title: "タスクD", path: "task-d.md" },
        state: "idle",
        slotKey: "8:00-12:00",
      },
      // 時間指定なしのタスクE
      instanceE,
    ]

    // タスクEを実行開始
    await view.startInstance(instanceE)

    // 検証
    expect(instanceE.state).toBe("running")
    expect(instanceE.slotKey).toBe("8:00-12:00") // 現在の時間帯に移動
    expect(instanceE.originalSlotKey).toBe("none") // 元のslotKeyは保存される
    expect(instanceE.startTime).toEqual(mockDate)

    // localStorageが更新されているか確認
    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      "taskchute-slotkey-task-e.md",
      "8:00-12:00",
    )
  })

  test("時間帯が設定されているタスクも現在の時間帯に移動する", async () => {
    const taskF = {
      title: "タスクF",
      path: "task-f.md",
      isRoutine: false,
    }

    const instanceF = {
      task: taskF,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "12:00-16:00", // 異なる時間帯が設定されている
      manuallyPositioned: false,
    }

    view.taskInstances = [instanceF]

    // タスクFを実行開始
    await view.startInstance(instanceF)

    // 検証
    expect(instanceF.state).toBe("running")
    expect(instanceF.slotKey).toBe("8:00-12:00") // 現在の時間帯に移動
    expect(instanceF.originalSlotKey).toBe("12:00-16:00") // 元の時間帯を記録

    // localStorageのsetItemが呼ばれることを確認
    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      "taskchute-slotkey-task-f.md",
      "8:00-12:00",
    )
  })

  test("時間指定なしから開始したタスクは停止時も現在の時間帯に留まる", async () => {
    const taskG = {
      title: "タスクG",
      path: "task-g.md",
      isRoutine: false,
    }

    const instanceG = {
      task: taskG,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "none",
      manuallyPositioned: false,
    }

    view.taskInstances = [instanceG]

    // タスクGを実行開始
    await view.startInstance(instanceG)

    // 実行中の状態を確認
    expect(instanceG.slotKey).toBe("8:00-12:00")
    expect(instanceG.originalSlotKey).toBe("none")

    // タスクGを停止
    await view.stopInstance(instanceG)

    // 検証
    expect(instanceG.state).toBe("done")
    expect(instanceG.slotKey).toBe("8:00-12:00") // 現在の時間帯に留まる
    expect(window.localStorage.setItem).toHaveBeenLastCalledWith(
      "taskchute-slotkey-task-g.md",
      "8:00-12:00", // 現在の時間帯を保存
    )
  })

  test("既に時間帯が設定されているタスクも現在の時間帯に移動し停止時も留まる", async () => {
    const taskH = {
      title: "タスクH",
      path: "task-h.md",
      isRoutine: false,
    }

    const instanceH = {
      task: taskH,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "12:00-16:00",
      manuallyPositioned: false,
    }

    view.taskInstances = [instanceH]

    // タスクHを実行開始
    await view.startInstance(instanceH)

    // 実行中の状態を確認（現在の時間帯に移動）
    expect(instanceH.slotKey).toBe("8:00-12:00") // 現在の時間帯に移動
    expect(instanceH.originalSlotKey).toBe("12:00-16:00") // 元の時間帯を記録

    // タスクHを停止
    await view.stopInstance(instanceH)

    // 検証
    expect(instanceH.state).toBe("done")
    expect(instanceH.slotKey).toBe("8:00-12:00") // 現在の時間帯に留まる
  })

  test("異なる時間帯での実行", async () => {
    // 14:00の時刻を設定（12:00-16:00の時間帯）
    const afternoonDate = new Date(2024, 0, 15, 14, 0, 0)
    jest.setSystemTime(afternoonDate)

    const taskI = {
      title: "タスクI",
      path: "task-i.md",
      isRoutine: false,
    }

    const instanceI = {
      task: taskI,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "none",
      manuallyPositioned: false,
    }

    view.taskInstances = [instanceI]

    // タスクIを実行開始
    await view.startInstance(instanceI)

    // 検証
    expect(instanceI.slotKey).toBe("12:00-16:00") // 午後の時間帯に移動
  })
})
