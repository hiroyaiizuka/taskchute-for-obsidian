const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

describe("時間編集時のslotKey更新バグ", () => {
  let taskChuteView
  let mockApp
  let mockLeaf

  beforeEach(() => {
    mockApp = {
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
    taskChuteView.saveTaskCompletion = jest.fn().mockResolvedValue()
    taskChuteView.saveRunningTasksState = jest.fn().mockResolvedValue()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test("修正後: 時刻変更時にslotKeyが正しく更新される", async () => {
    const mockTask = {
      title: "Task A",
      path: "task-a.md",
      file: {},
      isRoutine: false,
      scheduledTime: null,
      slotKey: "none",
    }

    // 元々8:00-12:00の時間帯にあるタスクA（開始8:10、終了9:10）
    const completedInstance = {
      task: mockTask,
      state: "done",
      startTime: new Date(2024, 0, 2, 8, 10, 0), // 8:10
      stopTime: new Date(2024, 0, 2, 9, 10, 0),  // 9:10
      slotKey: "8:00-12:00", // 元の時間帯
    }

    console.log("変更前のslotKey:", completedInstance.slotKey)
    console.log("変更前の開始時刻:", completedInstance.startTime.toTimeString())

    // 開始時刻を7:10に変更（0:00-8:00の時間帯に該当）
    await taskChuteView.updateInstanceTimes(completedInstance, "07:10", "09:10")

    console.log("変更後のslotKey:", completedInstance.slotKey)
    console.log("変更後の開始時刻:", completedInstance.startTime.toTimeString())

    // 修正後：slotKeyが正しく更新されている
    expect(completedInstance.slotKey).toBe("0:00-8:00") // 修正後の期待値
  })

  test("期待される動作: 時刻変更時にslotKeyが正しく更新される", async () => {
    const mockTask = {
      title: "Task B", 
      path: "task-b.md",
      file: {},
      isRoutine: false,
      scheduledTime: null,
      slotKey: "none",
    }

    // 別のテストケース：8:00-12:00 → 12:00-16:00への移動
    const completedInstance = {
      task: mockTask,
      state: "done",
      startTime: new Date(2024, 0, 2, 10, 30, 0), // 10:30
      stopTime: new Date(2024, 0, 2, 11, 30, 0),  // 11:30
      slotKey: "8:00-12:00", // 元の時間帯
    }

    // 開始時刻を13:30に変更（12:00-16:00の時間帯に該当）
    await taskChuteView.updateInstanceTimes(completedInstance, "13:30", "14:30")

    // 修正後：slotKeyが正しく更新されている
    expect(completedInstance.slotKey).toBe("12:00-16:00") // 修正後の期待値
  })

  test("実行中タスクの時刻変更でもslotKeyが正しく更新される", async () => {
    const mockTask = {
      title: "Running Task",
      path: "running-task.md", 
      file: {},
      isRoutine: false,
      scheduledTime: null,
      slotKey: "none",
    }

    // 実行中タスク（12:00-16:00の時間帯）
    const runningInstance = {
      task: mockTask,
      state: "running",
      startTime: new Date(2024, 0, 2, 14, 30, 0), // 14:30
      stopTime: null,
      slotKey: "12:00-16:00", // 元の時間帯
    }

    // 開始時刻を9:00に変更（8:00-12:00の時間帯に該当）
    await taskChuteView.updateRunningInstanceStartTime(runningInstance, "09:00")

    // 修正後：slotKeyが正しく更新されている
    expect(runningInstance.slotKey).toBe("8:00-12:00") // 修正後の期待値
  })

  describe("時間帯判定ヘルパー関数のテスト", () => {
    test("getSlotFromTime関数が正しく動作する", () => {
      // 修正後：ヘルパー関数のテスト
      expect(taskChuteView.getSlotFromTime("07:10")).toBe("0:00-8:00")
      expect(taskChuteView.getSlotFromTime("08:30")).toBe("8:00-12:00") 
      expect(taskChuteView.getSlotFromTime("13:45")).toBe("12:00-16:00")
      expect(taskChuteView.getSlotFromTime("18:00")).toBe("16:00-0:00")
      expect(taskChuteView.getSlotFromTime("23:59")).toBe("16:00-0:00")
      expect(taskChuteView.getSlotFromTime("00:30")).toBe("0:00-8:00")
    })
  })
})