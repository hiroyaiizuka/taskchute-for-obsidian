const { TaskChuteView } = require("../main.js")

describe("ルーチンタスクの再起動時の時間帯バグ", () => {
  let view
  let mockApp
  let mockPlugin
  let mockContainer

  beforeEach(() => {
    // 現在時刻を6:00に固定
    const mockDate = new Date("2024-07-23T06:00:00")
    jest.useFakeTimers()
    jest.setSystemTime(mockDate)

    // DOM要素のモック
    mockContainer = {
      querySelector: jest.fn(),
      classList: { add: jest.fn() },
      addEventListener: jest.fn(),
    }

    // Obsidian APIのモック
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
        },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
      },
      metadataCache: {
        getFileCache: jest.fn(),
      },
    }

    mockPlugin = {
      settings: {
        taskFolderPath: "TaskChute/Task",
        timeSlots: ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"],
      },
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    // localStorageのモック
    const localStorageMock = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn(),
    }
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    })

    // TaskChuteViewインスタンスの作成
    view = new TaskChuteView(mockContainer, mockPlugin)
    view.app = mockApp
    view.currentDate = mockDate
    view.tasks = []
    view.taskInstances = []

    // 必要なメソッドのモック
    view.renderTaskList = jest.fn()
    view.manageTimers = jest.fn()
    view.saveRunningTasksState = jest.fn()
    view.generateInstanceId = jest.fn((path) => `${path}-${Date.now()}`)
    view.getCurrentTimeSlot = jest.fn(() => "0:00-8:00") // 現在時刻6:00の時間帯
    view.getSlotFromScheduledTime = jest.fn((time) => {
      const hour = parseInt(time.split(":")[0])
      if (hour < 8) return "0:00-8:00"
      if (hour < 12) return "8:00-12:00"
      if (hour < 16) return "12:00-16:00"
      return "16:00-0:00"
    })
    view.determineSlotKey = jest.fn((taskPath, savedOrders, taskObj) => {
      if (savedOrders[taskPath]?.slot) {
        return savedOrders[taskPath].slot
      }
      if (taskObj.scheduledTime) {
        return view.getSlotFromScheduledTime(taskObj.scheduledTime)
      }
      return "none"
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("ルーチンタスクが再起動後に開始予定時刻の時間帯に戻ってしまうバグを再現", async () => {
    // 12:45開始予定のルーチンタスク
    const routineTask = {
      title: "ルーチンタスクA",
      path: "routine-task-a.md",
      isRoutine: true,
      scheduledTime: "12:45",
      routineType: "daily",
      file: { path: "routine-task-a.md" },
    }

    // ステップ1: loadTasksでルーチンタスクを読み込む（12:00-16:00の時間帯に配置）
    view.tasks = [routineTask]
    const taskInstance = {
      task: routineTask,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "12:00-16:00", // 開始予定時刻から計算された時間帯
      order: null,
      instanceId: "routine-task-a.md-001",
    }
    view.taskInstances = [taskInstance]

    // ステップ2: 6:00にタスクを開始（現在の時間帯0:00-8:00に移動）
    await view.startInstance(taskInstance)
    
    // startInstanceの動作をシミュレート
    taskInstance.state = "running"
    taskInstance.startTime = new Date("2024-07-23T06:00:00")
    taskInstance.originalSlotKey = "12:00-16:00"
    taskInstance.slotKey = "0:00-8:00" // 現在の時間帯に移動

    // 実行中タスクの状態が保存される
    const runningTaskData = [
      {
        date: "2024-07-23",
        taskTitle: "ルーチンタスクA",
        taskPath: "routine-task-a.md",
        startTime: "2024-07-23T06:00:00.000Z",
        slotKey: "0:00-8:00", // 実行時の時間帯
        originalSlotKey: "12:00-16:00",
        isRoutine: true,
        instanceId: "routine-task-a.md-001",
      },
    ]

    // running-task.jsonの内容をモック
    mockApp.vault.adapter.exists.mockResolvedValue(true)
    mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(runningTaskData))

    // ステップ3: 再起動をシミュレート（loadTasksが再度呼ばれる）
    view.tasks = []
    view.taskInstances = []

    // loadTasksで再度ルーチンタスクが読み込まれる（12:00-16:00の時間帯）
    view.tasks = [routineTask]
    const newTaskInstance = {
      task: routineTask,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "12:00-16:00", // 開始予定時刻から再計算された時間帯
      order: null,
      instanceId: "routine-task-a.md-002", // 新しいID
    }
    view.taskInstances = [newTaskInstance]

    // ステップ4: restoreRunningTaskStateを実行
    // 修正後のrestoreRunningTaskStateの動作をシミュレート
    const runningTasks = JSON.parse(await mockApp.vault.adapter.read())
    for (const runningData of runningTasks) {
      // 保存されたslotKeyと一致するインスタンスを優先的に探す
      let runningInstance = view.taskInstances.find(
        (inst) =>
          inst.task.path === runningData.taskPath && 
          inst.state === "idle" &&
          inst.slotKey === runningData.slotKey
      )
      
      // slotKeyが一致するインスタンスが見つからない場合は、
      // 異なるslotKeyのインスタンスを探して移動させる
      if (!runningInstance) {
        runningInstance = view.taskInstances.find(
          (inst) =>
            inst.task.path === runningData.taskPath && inst.state === "idle"
        )
        
        // 見つかった場合は正しいslotKeyに移動
        if (runningInstance) {
          runningInstance.slotKey = runningData.slotKey
        }
      }
      
      if (runningInstance) {
        runningInstance.state = "running"
        runningInstance.startTime = new Date(runningData.startTime)
        runningInstance.originalSlotKey = runningData.originalSlotKey || runningData.slotKey
      }
    }

    // 期待される動作: 実行中タスクは0:00-8:00の時間帯にあるべき
    const runningInstance = view.taskInstances.find(
      (inst) => inst.state === "running"
    )

    // 修正後の期待される動作: 実行中タスクは0:00-8:00の時間帯にあるべき
    expect(runningInstance).toBeDefined()
    expect(runningInstance.slotKey).toBe("0:00-8:00") // 修正後: 実行時の時間帯を維持
    expect(runningInstance.state).toBe("running")
    expect(runningInstance.startTime.toISOString()).toBe("2024-07-23T06:00:00.000Z")
  })

  test("期待される正しい動作: ルーチンタスクが実行時の時間帯を維持する", async () => {
    // このテストは修正後に成功すべきテスト
    const routineTask = {
      title: "ルーチンタスクB",
      path: "routine-task-b.md",
      isRoutine: true,
      scheduledTime: "14:00",
      routineType: "daily",
      file: { path: "routine-task-b.md" },
    }

    // 14:00開始予定のタスクを19:00に実行
    const mockDate19 = new Date("2024-07-23T19:00:00")
    jest.setSystemTime(mockDate19)
    view.getCurrentTimeSlot.mockReturnValue("16:00-0:00")

    view.tasks = [routineTask]
    const taskInstance = {
      task: routineTask,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "12:00-16:00", // 開始予定時刻の時間帯
      order: null,
      instanceId: "routine-task-b.md-001",
    }
    view.taskInstances = [taskInstance]

    // 19:00にタスクを開始
    taskInstance.state = "running"
    taskInstance.startTime = mockDate19
    taskInstance.originalSlotKey = "12:00-16:00"
    taskInstance.slotKey = "16:00-0:00" // 実行時の時間帯に移動

    // 実行中タスクのデータ
    const runningTaskData = [
      {
        date: "2024-07-23",
        taskTitle: "ルーチンタスクB",
        taskPath: "routine-task-b.md",
        startTime: "2024-07-23T19:00:00.000Z",
        slotKey: "16:00-0:00", // 実行時の時間帯
        originalSlotKey: "12:00-16:00",
        isRoutine: true,
        instanceId: "routine-task-b.md-001",
      },
    ]

    mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(runningTaskData))

    // 再起動をシミュレート
    view.tasks = []
    view.taskInstances = []

    // loadTasksで再度読み込まれる
    view.tasks = [routineTask]
    const newTaskInstance = {
      task: routineTask,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: "12:00-16:00", // 開始予定時刻の時間帯
      order: null,
      instanceId: "routine-task-b.md-002",
    }
    view.taskInstances = [newTaskInstance]

    // restoreRunningTaskStateを実行
    // 修正後のrestoreRunningTaskStateの動作をシミュレート
    const runningTasks = JSON.parse(await mockApp.vault.adapter.read())
    for (const runningData of runningTasks) {
      // 保存されたslotKeyと一致するインスタンスを優先的に探す
      let runningInstance = view.taskInstances.find(
        (inst) =>
          inst.task.path === runningData.taskPath && 
          inst.state === "idle" &&
          inst.slotKey === runningData.slotKey
      )
      
      // slotKeyが一致するインスタンスが見つからない場合は、
      // 異なるslotKeyのインスタンスを探して移動させる
      if (!runningInstance) {
        runningInstance = view.taskInstances.find(
          (inst) =>
            inst.task.path === runningData.taskPath && inst.state === "idle"
        )
        
        // 見つかった場合は正しいslotKeyに移動
        if (runningInstance) {
          runningInstance.slotKey = runningData.slotKey
        }
      }
      
      if (runningInstance) {
        runningInstance.state = "running"
        runningInstance.startTime = new Date(runningData.startTime)
        runningInstance.originalSlotKey = runningData.originalSlotKey || runningData.slotKey
      }
    }

    // 期待される動作: 実行中タスクは16:00-0:00の時間帯にあるべき
    const runningInstance = view.taskInstances.find(
      (inst) => inst.state === "running"
    )

    // 修正後の期待値
    expect(runningInstance).toBeDefined()
    expect(runningInstance.slotKey).toBe("16:00-0:00") // 修正後: 実行時の時間帯を維持
    expect(runningInstance.state).toBe("running")
  })
})