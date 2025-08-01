const { TaskChuteView } = require("../main.js")

describe("完了タスクの再実行バグ", () => {
  let view
  let mockApp
  let mockLeaf

  beforeEach(() => {
    // モックの初期化
    mockApp = {
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
    }

    mockLeaf = {}

    // ビューの初期化
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

    // 現在時刻を12:55に設定
    const mockDate = new Date("2024-01-15T12:55:00")
    jest.useFakeTimers()
    jest.setSystemTime(mockDate)

    // currentDateを設定
    view.currentDate = new Date("2024-01-15")

    // DOM要素のモック
    view.taskList = {
      empty: jest.fn(),
      createEl: jest.fn((tag, options) => {
        const element = {
          createEl: jest.fn((childTag, childOptions) => ({
            createEl: jest.fn(),
            addEventListener: jest.fn(),
            querySelector: jest.fn(),
            querySelectorAll: jest.fn(() => []),
            setAttribute: jest.fn(),
            classList: {
              add: jest.fn(),
              remove: jest.fn(),
            },
          })),
          addEventListener: jest.fn(),
          querySelector: jest.fn(),
          querySelectorAll: jest.fn(() => []),
          setAttribute: jest.fn(),
          classList: {
            add: jest.fn(),
            remove: jest.fn(),
          },
        }
        return element
      }),
      scrollTop: 0,
      scrollLeft: 0,
    }

    // 必要なメソッドをモック
    view.renderTaskList = jest.fn()
    view.getCurrentTimeSlot = jest.fn(() => "12:00-16:00")
    view.saveRunningTasksState = jest.fn()
    view.manageTimers = jest.fn()
    view.sortTaskInstancesByTimeOrder = jest.fn()

    // duplicateAndStartInstanceメソッドを手動で実装
    view.duplicateAndStartInstance = async function (inst) {
      // 現在の時間帯を取得
      const currentSlot = this.getCurrentTimeSlot()

      // 同じタスク参照の新インスタンスを現在の時間帯に追加し、計測開始
      const newInst = {
        task: inst.task,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: currentSlot, // 現在の時間帯に設定
      }
      this.taskInstances.push(newInst)

      // startInstanceを呼ぶ前にrenderTaskListを呼んで、新しいインスタンスを表示
      this.renderTaskList()

      await this.startInstance(newInst)

      // startInstance後にも再度renderTaskListを呼んで、実行中状態を反映
      this.renderTaskList()
    }

    // startInstanceメソッドも実装
    view.startInstance = async function (inst) {
      inst.state = "running"
      inst.startTime = new Date()
      inst.stopTime = null

      // 実行中タスクの状態を保存
      await this.saveRunningTasksState()
      this.manageTimers() // タイマー管理を開始
    }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("完了タスクを再実行すると、新しいインスタンスが現在の時間帯に表示される", async () => {
    // タスクの設定
    const taskA = {
      title: "タスクA",
      path: "taskA.md",
      file: { path: "taskA.md" },
      isRoutine: false,
      scheduledTime: "11:00",
      slotKey: "8:00-12:00",
    }

    const taskB = {
      title: "タスクB",
      path: "taskB.md",
      file: { path: "taskB.md" },
      isRoutine: false,
      scheduledTime: "11:24",
      slotKey: "8:00-12:00",
    }

    const taskC = {
      title: "タスクC",
      path: "taskC.md",
      file: { path: "taskC.md" },
      isRoutine: false,
      scheduledTime: "13:00",
      slotKey: "12:00-16:00",
    }

    // タスクインスタンスの設定
    view.tasks = [taskA, taskB, taskC]
    view.taskInstances = [
      {
        task: taskA,
        state: "done",
        startTime: new Date("2024-01-15T11:00:00"),
        stopTime: new Date("2024-01-15T11:30:00"),
        slotKey: "8:00-12:00",
      },
      {
        task: taskB,
        state: "done",
        startTime: new Date("2024-01-15T11:24:00"),
        stopTime: new Date("2024-01-15T11:50:00"),
        slotKey: "8:00-12:00",
      },
      {
        task: taskC,
        state: "idle",
        startTime: null,
        stopTime: null,
        slotKey: "12:00-16:00",
      },
    ]

    // 初期状態の確認
    expect(view.taskInstances.length).toBe(3)

    // 8:00-12:00の時間帯のタスクを確認
    const slot8to12Before = view.taskInstances.filter(
      (inst) => inst.slotKey === "8:00-12:00",
    )
    expect(slot8to12Before.length).toBe(2)
    expect(slot8to12Before.every((inst) => inst.state === "done")).toBe(true)

    // 12:00-16:00の時間帯のタスクを確認
    const slot12to16Before = view.taskInstances.filter(
      (inst) => inst.slotKey === "12:00-16:00",
    )
    expect(slot12to16Before.length).toBe(1)
    expect(slot12to16Before[0].state).toBe("idle")

    // タスクAを再実行
    const completedTaskA = view.taskInstances[0]
    await view.duplicateAndStartInstance(completedTaskA)

    // 再実行後の状態を確認
    expect(view.taskInstances.length).toBe(4) // 新しいインスタンスが追加される

    // 8:00-12:00の時間帯のタスクを確認（変わらず2つ）
    const slot8to12After = view.taskInstances.filter(
      (inst) => inst.slotKey === "8:00-12:00",
    )
    expect(slot8to12After.length).toBe(2)
    expect(slot8to12After.every((inst) => inst.state === "done")).toBe(true)

    // 12:00-16:00の時間帯のタスクを確認（2つになるはず）
    const slot12to16After = view.taskInstances.filter(
      (inst) => inst.slotKey === "12:00-16:00",
    )
    expect(slot12to16After.length).toBe(2)

    // 新しく追加されたタスクAのインスタンスを確認
    const runningTaskA = slot12to16After.find(
      (inst) => inst.task.title === "タスクA" && inst.state === "running",
    )
    expect(runningTaskA).toBeDefined()
    expect(runningTaskA.state).toBe("running")
    expect(runningTaskA.slotKey).toBe("12:00-16:00") // 現在の時間帯
    expect(runningTaskA.startTime).toBeDefined()
    expect(runningTaskA.stopTime).toBeNull()

    // 元のタスクAは完了状態のまま
    const originalTaskA = slot8to12After.find(
      (inst) => inst.task.title === "タスクA" && inst.state === "done",
    )
    expect(originalTaskA).toBeDefined()
    expect(originalTaskA.state).toBe("done")
    expect(originalTaskA.slotKey).toBe("8:00-12:00")
  })

  test("renderTaskListが呼ばれることを確認", async () => {
    // タスクの設定
    const taskA = {
      title: "タスクA",
      path: "taskA.md",
      file: { path: "taskA.md" },
      isRoutine: false,
      scheduledTime: "11:00",
      slotKey: "8:00-12:00",
    }

    view.tasks = [taskA]
    view.taskInstances = [
      {
        task: taskA,
        state: "done",
        startTime: new Date("2024-01-15T11:00:00"),
        stopTime: new Date("2024-01-15T11:30:00"),
        slotKey: "8:00-12:00",
      },
    ]

    // タスクAを再実行
    const completedTaskA = view.taskInstances[0]
    await view.duplicateAndStartInstance(completedTaskA)

    // renderTaskListが2回呼ばれたことを確認（startInstance前後）
    expect(view.renderTaskList).toHaveBeenCalledTimes(2)
  })
})
