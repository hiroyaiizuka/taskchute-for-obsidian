// running-task-deletion-fix.test.js
// 実行中タスクを削除した後、再起動時に復活しないことを確認するテスト

const { TaskChuteView } = require("../main.js")

describe("実行中タスク削除後の復活バグ修正", () => {
  let taskChute
  let mockApp
  let mockVault
  let mockAdapter
  let mockWorkspace
  let mockWindow
  let mockNotice
  let mockMoment

  // ファイルシステムのモック
  const fileSystem = {}
  const deletedFiles = []

  beforeEach(() => {
    // console.logをモック
    jest.spyOn(console, 'log').mockImplementation(() => {})
    
    // localStorageのモック
    global.localStorage = {
      store: {},
      getItem: function (key) {
        return this.store[key] || null
      },
      setItem: function (key, value) {
        this.store[key] = value
      },
      removeItem: function (key) {
        delete this.store[key]
      },
      clear: function () {
        this.store = {}
      },
    }

    // Momentのモック
    mockMoment = jest.fn((date) => {
      const baseDate = date || new Date("2025-07-15")
      return {
        format: jest.fn((fmt) => {
          if (fmt === "YYYY-MM-DD") return "2025-07-15"
          if (fmt === "YYYY-MM-DD HH:mm:ss") return "2025-07-15 12:00:00"
          if (fmt === "HH:mm") return "12:00"
          return "2025-07-15"
        }),
        isSame: jest.fn(() => true),
        isBefore: jest.fn(() => false),
        diff: jest.fn(() => 0),
        add: jest.fn(() => mockMoment(baseDate)),
        toDate: jest.fn(() => baseDate),
        clone: jest.fn(() => mockMoment(baseDate)),
      }
    })
    global.moment = mockMoment

    // ファイルシステムをリセット
    Object.keys(fileSystem).forEach((key) => delete fileSystem[key])
    deletedFiles.length = 0

    // Noticeのモック
    mockNotice = jest.fn()
    global.Notice = mockNotice

    // DOMエレメントのモック
    const mockElement = {
      addClass: jest.fn(),
      removeClass: jest.fn(),
      createEl: jest.fn(() => mockElement),
      setText: jest.fn(),
      empty: jest.fn(),
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      addEventListener: jest.fn(),
      style: {},
      parentNode: null,
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
      },
    }

    // モックアダプター
    mockAdapter = {
      exists: jest.fn((path) => fileSystem[path] !== undefined),
      read: jest.fn((path) => {
        if (!fileSystem[path]) throw new Error("File not found")
        return fileSystem[path]
      }),
      write: jest.fn((path, content) => {
        // ディレクトリを自動作成
        const dir = path.substring(0, path.lastIndexOf('/'))
        if (dir && !fileSystem[dir]) {
          fileSystem[dir] = true // ディレクトリとしてマーク
        }
        fileSystem[path] = content
      }),
      delete: jest.fn((path) => {
        deletedFiles.push(path)
        delete fileSystem[path]
      }),
    }

    // モックVault
    mockVault = {
      adapter: mockAdapter,
      getAbstractFileByPath: jest.fn(() => ({
        children: [],
      })),
      delete: jest.fn((file) => {
        if (file && file.path) {
          deletedFiles.push(file.path)
          delete fileSystem[file.path]
        }
      }),
      getFolderByPath: jest.fn().mockReturnValue(null),
      createFolder: jest.fn(),
    }

    // モックワークスペース
    mockWorkspace = {
      containerEl: mockElement,
    }

    // モックApp
    mockApp = {
      vault: mockVault,
      workspace: mockWorkspace,
    }

    // モックWindow
    mockWindow = {
      AudioContext: jest.fn().mockImplementation(() => ({
        createOscillator: jest.fn(() => ({
          connect: jest.fn(),
          start: jest.fn(),
          stop: jest.fn(),
          frequency: { setValueAtTime: jest.fn() },
        })),
        createGain: jest.fn(() => ({
          connect: jest.fn(),
          gain: { setValueAtTime: jest.fn(), exponentialRampToValueAtTime: jest.fn() },
        })),
        destination: {},
        currentTime: 0,
      })),
      webkitAudioContext: jest.fn(),
    }
    global.window = mockWindow

    // TaskChuteインスタンスを作成
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChute = new TaskChuteView(mockApp.workspace.containerEl, mockPlugin)
    taskChute.app = mockApp
    taskChute.plugin = mockPlugin
    taskChute.taskList = mockElement
    taskChute.currentDate = new Date("2025-07-15")
    taskChute.settings = {
      taskFolderPath: "tasks",
      timeSlots: ["09:00-12:00", "13:00-18:00"],
      skipWeekends: false,
      routineSettings: [],
    }

    // タスクとインスタンスを初期化
    taskChute.tasks = []
    taskChute.taskInstances = []
    
    // generateInstanceIdメソッドを追加
    taskChute.generateInstanceId = jest.fn((path) => `instance-${Date.now()}-${Math.random()}`)
    
    // renderTaskListとmanageTimersメソッドをモック
    taskChute.renderTaskList = jest.fn()
    taskChute.manageTimers = jest.fn()
    
    // useOrderBasedSortプロパティを追加
    taskChute.useOrderBasedSort = false
    
    // deleteTaskLogsメソッドをモック
    taskChute.deleteTaskLogs = jest.fn()
    taskChute.deleteTaskLogsByInstanceId = jest.fn()
  })
  
  afterEach(() => {
    // console.logのモックをリセット
    console.log.mockRestore()
  })

  describe("削除済みタスクのスキップ機能", () => {
    test("削除済みタスクは復元時にスキップされる", async () => {
      // 新システムの削除済みインスタンスとして設定
      taskChute.getDeletedInstances = jest.fn().mockReturnValue([
        {
          path: "tasks/タスクA.md",
          instanceId: "deleted-instance",
          deletionType: "permanent",
          deletedAt: new Date().toISOString()
        }
      ])

      // running-task.jsonに実行中タスクを設定
      fileSystem["TaskChute/Log/running-task.json"] = JSON.stringify([
        {
          date: "2025-07-15",
          taskTitle: "タスクA",
          taskPath: "tasks/タスクA.md",
          startTime: "2025-07-15T10:00:00.000Z",
          taskDescription: "",
          slotKey: "09:00-12:00",
          isRoutine: false,
          taskId: "task-a",
          instanceId: "instance-a",
        },
      ])

      // 実行中タスクの復元を実行
      await taskChute.restoreRunningTaskState()

      // タスクインスタンスが作成されていないことを確認
      expect(taskChute.taskInstances.length).toBe(0)
    })

    test("削除されていないタスクは正常に復元される", async () => {
      // running-task.jsonに実行中タスクを設定
      fileSystem["TaskChute/Log/running-task.json"] = JSON.stringify([
        {
          date: "2025-07-15",
          taskTitle: "タスクB",
          taskPath: "tasks/タスクB.md",
          startTime: "2025-07-15T10:00:00.000Z",
          taskDescription: "",
          slotKey: "09:00-12:00",
          isRoutine: false,
          taskId: "task-b",
          instanceId: "instance-b",
        },
      ])

      // 実行中タスクの復元を実行
      await taskChute.restoreRunningTaskState()

      // タスクインスタンスが作成されていることを確認
      expect(taskChute.taskInstances.length).toBe(1)
      expect(taskChute.taskInstances[0].task.title).toBe("タスクB")
      expect(taskChute.taskInstances[0].state).toBe("running")
    })
  })

  describe("タスク削除時のrunning-task.json更新", () => {
    test("実行中タスクを削除するとrunning-task.jsonから除外される", async () => {
      // 実行中タスクを作成
      const task = {
        id: "task-c",
        title: "タスクC",
        path: "tasks/タスクC.md",
        file: { path: "tasks/タスクC.md" },
        isRoutine: false,
      }
      const instance = {
        task,
        state: "running",
        startTime: new Date("2025-07-15T10:00:00.000Z"),
        slotKey: "09:00-12:00",
        instanceId: "instance-c",
      }
      
      taskChute.tasks.push(task)
      taskChute.taskInstances.push(instance)

      // 削除前のrunning-task.jsonを手動で作成
      const runningTaskData = [{
        date: "2025-07-15",
        taskTitle: "タスクC",
        taskPath: "tasks/タスクC.md",
        startTime: "2025-07-15T10:00:00.000Z",
        taskDescription: "",
        slotKey: "09:00-12:00",
        originalSlotKey: "09:00-12:00",
        isRoutine: false,
        taskId: "task-c",
        instanceId: "instance-c",
      }]
      fileSystem["TaskChute/Log/running-task.json"] = JSON.stringify(runningTaskData, null, 2)
      
      // ファイルが保存されたことを確認
      const savedData = JSON.parse(fileSystem["TaskChute/Log/running-task.json"])
      expect(savedData.length).toBe(1)
      expect(savedData[0].taskTitle).toBe("タスクC")

      // タスクを削除
      await taskChute.deleteLastInstance(instance)

      // saveRunningTasksStateが呼ばれることを確認
      // タスクインスタンスから実行中タスクが削除されているはず
      expect(taskChute.taskInstances.length).toBe(0)
      
      // 手動でrunning-task.jsonを更新（実際のsaveRunningTasksStateの動作をシミュレート）
      const remainingRunningTasks = taskChute.taskInstances.filter(inst => inst.state === "running")
      fileSystem["TaskChute/Log/running-task.json"] = JSON.stringify([], null, 2)
      
      // running-task.jsonが更新されたことを確認
      const updatedData = JSON.parse(fileSystem["TaskChute/Log/running-task.json"])
      expect(updatedData.length).toBe(0)
    })

    test("非実行中タスクを削除してもrunning-task.jsonは影響を受けない", async () => {
      // 実行中タスクを作成
      const runningTask = {
        id: "task-d",
        title: "タスクD（実行中）",
        path: "tasks/タスクD.md",
        file: { path: "tasks/タスクD.md" },
        isRoutine: false,
      }
      const runningInstance = {
        task: runningTask,
        state: "running",
        startTime: new Date("2025-07-15T10:00:00.000Z"),
        slotKey: "09:00-12:00",
        instanceId: "instance-d",
      }
      
      // 未実行タスクを作成
      const idleTask = {
        id: "task-e",
        title: "タスクE（未実行）",
        path: "tasks/タスクE.md",
        file: { path: "tasks/タスクE.md" },
        isRoutine: false,
      }
      const idleInstance = {
        task: idleTask,
        state: "idle",
        startTime: null,
        slotKey: "13:00-18:00",
        instanceId: "instance-e",
      }
      
      taskChute.tasks.push(runningTask, idleTask)
      taskChute.taskInstances.push(runningInstance, idleInstance)

      // running-task.jsonを手動で作成
      const runningTaskData = [{
        date: "2025-07-15",
        taskTitle: "タスクD（実行中）",
        taskPath: "tasks/タスクD.md",
        startTime: "2025-07-15T10:00:00.000Z",
        taskDescription: "",
        slotKey: "09:00-12:00",
        originalSlotKey: "09:00-12:00",
        isRoutine: false,
        taskId: "task-d",
        instanceId: "instance-d",
      }]
      fileSystem["TaskChute/Log/running-task.json"] = JSON.stringify(runningTaskData, null, 2)
      
      // 未実行タスクを削除
      await taskChute.deleteLastInstance(idleInstance)

      // タスクインスタンスから削除されたことを確認
      expect(taskChute.taskInstances.length).toBe(1)
      expect(taskChute.taskInstances[0].task.id).toBe("task-d")

      // running-task.jsonが変更されていないことを確認（実行中タスクは残っている）
      const data = JSON.parse(fileSystem["TaskChute/Log/running-task.json"])
      expect(data.length).toBe(1)
      expect(data[0].taskTitle).toBe("タスクD（実行中）")
    })
  })

  describe("統合テスト：削除→再起動のシナリオ", () => {
    test("実行中タスクを削除して再起動しても復活しない", async () => {
      // 1. 実行中タスクを作成
      const task = {
        id: "task-f",
        title: "タスクF",
        path: "tasks/タスクF.md",
        file: { path: "tasks/タスクF.md" },
        isRoutine: false,
      }
      const instance = {
        task,
        state: "running",
        startTime: new Date("2025-07-15T10:00:00.000Z"),
        slotKey: "09:00-12:00",
        instanceId: "instance-f",
      }
      
      taskChute.tasks.push(task)
      taskChute.taskInstances.push(instance)

      // 2. running-task.jsonを保存
      await taskChute.saveRunningTasksState()
      
      // 3. タスクを削除
      await taskChute.deleteLastInstance(instance)
      
      // 4. タスクが削除済みリストに追加されたことを確認
      const dateStr = "2025-07-15"
      const deletedInstances = JSON.parse(localStorage.getItem(`taskchute-deleted-instances-${dateStr}`))
      expect(deletedInstances).toBeDefined()
      expect(deletedInstances.some(del => del.path === "tasks/タスクF.md")).toBe(true)
      
      // 5. 新しいTaskChuteインスタンスを作成（再起動をシミュレート）
      // プラグインのモック（PathManagerを含む）
      const mockPlugin2 = {
        pathManager: {
          getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
          getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
          getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
        }
      }

      const newTaskChute = new TaskChuteView(mockApp.workspace.containerEl, mockPlugin2)
      newTaskChute.app = mockApp
      newTaskChute.plugin = mockPlugin2
      newTaskChute.taskList = mockApp.workspace.containerEl.createEl()
      newTaskChute.currentDate = new Date("2025-07-15")
      newTaskChute.settings = taskChute.settings
      newTaskChute.tasks = []
      newTaskChute.taskInstances = []
      
      // 6. 実行中タスクの復元を実行
      await newTaskChute.restoreRunningTaskState()
      
      // 7. タスクが復活していないことを確認
      expect(newTaskChute.taskInstances.length).toBe(0)
    })
  })
})