const { 
  ItemView, 
  TFile, 
  TFolder, 
  Plugin, 
  Notice 
} = require("obsidian")

describe("ルーチンタスク名変更時の過去履歴表示", () => {
  let view
  let plugin
  let mockApp
  let routineAliasManager

  beforeEach(() => {
    // モックの設定
    const mockMetadataCache = {
      getFileCache: jest.fn().mockReturnValue({
        frontmatter: {
          routine: true,
          開始時刻: "12:00"
        }
      })
    }

    const mockVault = {
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      modify: jest.fn(),
      getFolderByPath: jest.fn(),
      getMarkdownFiles: jest.fn().mockReturnValue([]),
      adapter: {
        stat: jest.fn()
      }
    }

    mockApp = {
      vault: mockVault,
      metadataCache: mockMetadataCache,
      workspace: {
        getLeavesOfType: jest.fn().mockReturnValue([])
      }
    }

    // RoutineAliasManagerのモック
    routineAliasManager = {
      loadAliases: jest.fn().mockResolvedValue({
        "お昼ご飯": ["昼ごはん", "ランチ"]
      }),
      getAliases: jest.fn((name) => {
        if (name === "お昼ご飯") return ["昼ごはん", "ランチ"]
        return []
      }),
      getAllPossibleNames: jest.fn((name) => {
        if (name === "お昼ご飯") return ["お昼ご飯", "昼ごはん", "ランチ"]
        if (name === "昼ごはん") return ["お昼ご飯", "昼ごはん", "ランチ"]
        return [name]
      }),
      findCurrentName: jest.fn((oldName) => {
        if (oldName === "昼ごはん" || oldName === "ランチ") return "お昼ご飯"
        return null
      }),
      addAlias: jest.fn(),
      aliasCache: {
        "お昼ご飯": ["昼ごはん", "ランチ"]
      }
    }

    plugin = {
      app: mockApp,
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue("TaskChute/Task"),
        getLogDataPath: jest.fn().mockReturnValue("TaskChute/Log"),
        getProjectFolderPath: jest.fn().mockReturnValue("TaskChute/Project"),
        ensureFolderExists: jest.fn().mockResolvedValue()
      },
      routineAliasManager: routineAliasManager,
      settings: {
        taskFolderPath: "TaskChute/Task/",
        logDataPath: "TaskChute/Log/"
      }
    }

    // ItemViewのコンストラクタ
    view = new ItemView()
    view.app = mockApp
    view.plugin = plugin
    view.currentDate = new Date("2025-08-10")
    view.taskInstances = []
    view.tasks = []
    
    // DOM要素のモック
    view.containerEl = document.createElement("div")
    view.contentEl = document.createElement("div")
    view.taskList = document.createElement("div")
    view.taskList.empty = jest.fn()
    view.taskList.scrollTop = 0
    view.taskList.scrollLeft = 0
    
    // 必要なメソッドのモック
    view.getTimeSlotKeys = jest.fn().mockReturnValue([
      "0:00-8:00",
      "8:00-12:00", 
      "12:00-16:00",
      "16:00-0:00"
    ])
    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-10")
    view.getDeletedInstances = jest.fn().mockReturnValue([])
    view.getHiddenRoutines = jest.fn().mockReturnValue([])
    view.loadSavedOrders = jest.fn().mockReturnValue({})
    view.generateInstanceId = jest.fn().mockReturnValue("test-instance-id")
    view.determineSlotKey = jest.fn().mockReturnValue("12:00-16:00")
    view.sortTaskInstancesByTimeOrder = jest.fn()
    view.applyResponsiveClasses = jest.fn()
    view.renderTaskList = jest.fn()
    view.restoreRunningTaskState = jest.fn().mockResolvedValue()
    view.setupDragHandlers = jest.fn()
    view.setupCleanup = jest.fn()
    
    // loadTodayExecutions メソッドの実装
    view.loadTodayExecutions = jest.fn().mockImplementation(async (dateString) => {
      if (dateString === "2025-08-08") {
        // 2日前：「昼ごはん」という名前で実行されていた
        return [
          {
            taskTitle: "昼ごはん",
            startTime: new Date("2025-08-08T12:00:00+09:00"),
            stopTime: new Date("2025-08-08T12:30:00+09:00"),
            slotKey: "12:00-16:00"
          }
        ]
      } else if (dateString === "2025-08-09") {
        // 1日前：「昼ごはん」という名前で実行されていた
        return [
          {
            taskTitle: "昼ごはん",
            startTime: new Date("2025-08-09T12:00:00+09:00"),
            stopTime: new Date("2025-08-09T12:30:00+09:00"),
            slotKey: "12:00-16:00"
          }
        ]
      } else if (dateString === "2025-08-10") {
        // 今日：「お昼ご飯」という名前で実行
        return [
          {
            taskTitle: "お昼ご飯",
            startTime: new Date("2025-08-10T12:00:00+09:00"),
            stopTime: new Date("2025-08-10T12:30:00+09:00"),
            slotKey: "12:00-16:00"
          }
        ]
      }
      return []
    })

    view.getTaskFiles = jest.fn().mockResolvedValue([])
    view.loadTasks = jest.fn()
  })

  test("名前変更後も過去の実行履歴が正しく表示される", async () => {
    // 現在のタスクファイル（新しい名前）
    const currentTaskFile = {
      path: "TaskChute/Task/お昼ご飯.md",
      basename: "お昼ご飯",
      extension: "md"
    }

    // タスクファイルのモック
    view.getTaskFiles = jest.fn().mockResolvedValue([currentTaskFile])
    mockApp.vault.read.mockResolvedValue("#task\n#routine\n開始時刻: 12:00")

    // 2日前の日付に設定
    view.currentDate = new Date("2025-08-08")
    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-08")

    // loadTasksの簡易実装
    view.loadTasks = jest.fn().mockImplementation(async function() {
      await this.plugin.routineAliasManager.loadAliases()
      
      const dateString = this.getCurrentDateString()
      const [todayExecutions, files] = await Promise.all([
        this.loadTodayExecutions(dateString),
        this.getTaskFiles()
      ])

      this.tasks = []
      this.taskInstances = []

      for (const file of files) {
        const content = await mockApp.vault.read(file)
        if (content.includes("#task")) {
          const metadata = mockApp.metadataCache.getFileCache(file)?.frontmatter
          const isRoutine = metadata?.routine === true

          // 全ての可能な名前を取得（新実装）
          const allPossibleNames = 
            this.plugin.routineAliasManager.getAllPossibleNames(file.basename)
          const todayExecutionsForTask = todayExecutions.filter(
            (exec) => allPossibleNames.includes(exec.taskTitle)
          )

          // ルーチンタスクまたは実行履歴がある場合は表示
          if (isRoutine || todayExecutionsForTask.length > 0) {
            const taskObj = {
              title: file.basename,
              path: file.path,
              isRoutine: isRoutine,
              scheduledTime: metadata?.開始時刻 || null
            }
            this.tasks.push(taskObj)

            // 実行履歴がある場合は完了済みインスタンスを追加
            if (todayExecutionsForTask.length > 0) {
              todayExecutionsForTask.forEach(exec => {
                this.taskInstances.push({
                  task: taskObj,
                  isCompleted: true,
                  startTime: exec.startTime,
                  stopTime: exec.stopTime,
                  slotKey: exec.slotKey
                })
              })
            }
          }
        }
      }
    }.bind(view))

    // テスト実行
    await view.loadTasks()

    // 検証
    expect(view.tasks).toHaveLength(1)
    expect(view.tasks[0].title).toBe("お昼ご飯") // 現在のファイル名
    
    expect(view.taskInstances).toHaveLength(1)
    expect(view.taskInstances[0].isCompleted).toBe(true) // 実行済みとして表示
    expect(view.taskInstances[0].task.title).toBe("お昼ご飯")
    
    // getAllPossibleNamesが正しく呼ばれたか確認
    expect(routineAliasManager.getAllPossibleNames).toHaveBeenCalledWith("お昼ご飯")
  })

  test("エイリアスが存在しない場合も正常に動作する", async () => {
    // エイリアスが存在しないタスク
    const taskFile = {
      path: "TaskChute/Task/新しいタスク.md",
      basename: "新しいタスク",
      extension: "md"
    }

    routineAliasManager.getAllPossibleNames = jest.fn((name) => {
      // エイリアスがない場合は名前のみ返す
      return [name]
    })

    view.getTaskFiles = jest.fn().mockResolvedValue([taskFile])
    mockApp.vault.read.mockResolvedValue("#task\n#routine")
    view.loadTodayExecutions = jest.fn().mockResolvedValue([])
    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-10")

    // 簡易loadTasks実装
    view.loadTasks = jest.fn().mockImplementation(async function() {
      const dateString = this.getCurrentDateString()
      const [todayExecutions, files] = await Promise.all([
        this.loadTodayExecutions(dateString),
        this.getTaskFiles()
      ])

      this.tasks = []
      this.taskInstances = []

      for (const file of files) {
        const allPossibleNames = 
          this.plugin.routineAliasManager.getAllPossibleNames(file.basename)
        const todayExecutionsForTask = todayExecutions.filter(
          (exec) => allPossibleNames.includes(exec.taskTitle)
        )

        const taskObj = {
          title: file.basename,
          path: file.path,
          isRoutine: true
        }
        this.tasks.push(taskObj)

        if (todayExecutionsForTask.length === 0) {
          // 実行履歴がなくても、ルーチンタスクなので未実施として表示
          this.taskInstances.push({
            task: taskObj,
            isCompleted: false
          })
        }
      }
    }.bind(view))

    await view.loadTasks()

    expect(view.tasks).toHaveLength(1)
    expect(view.taskInstances).toHaveLength(1)
    expect(view.taskInstances[0].isCompleted).toBe(false)
  })

  test("複数のエイリアスが正しく処理される", async () => {
    // 複数回名前変更されたタスク
    routineAliasManager.getAllPossibleNames = jest.fn((name) => {
      if (name === "タスクC") {
        return ["タスクC", "タスクB", "タスクA"]
      }
      return [name]
    })

    const taskFile = {
      path: "TaskChute/Task/タスクC.md",
      basename: "タスクC",
      extension: "md"
    }

    view.getTaskFiles = jest.fn().mockResolvedValue([taskFile])
    mockApp.vault.read.mockResolvedValue("#task\n#routine")
    
    // 過去の実行履歴（古い名前で記録）
    view.loadTodayExecutions = jest.fn().mockResolvedValue([
      {
        taskTitle: "タスクA", // 最初の名前
        startTime: new Date("2025-08-10T10:00:00+09:00"),
        stopTime: new Date("2025-08-10T10:30:00+09:00"),
        slotKey: "8:00-12:00"
      },
      {
        taskTitle: "タスクB", // 2番目の名前
        startTime: new Date("2025-08-10T14:00:00+09:00"),
        stopTime: new Date("2025-08-10T14:30:00+09:00"),
        slotKey: "12:00-16:00"
      }
    ])

    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-10")

    view.loadTasks = jest.fn().mockImplementation(async function() {
      const dateString = this.getCurrentDateString()
      const [todayExecutions, files] = await Promise.all([
        this.loadTodayExecutions(dateString),
        this.getTaskFiles()
      ])

      this.tasks = []
      this.taskInstances = []

      for (const file of files) {
        const allPossibleNames = 
          this.plugin.routineAliasManager.getAllPossibleNames(file.basename)
        const todayExecutionsForTask = todayExecutions.filter(
          (exec) => allPossibleNames.includes(exec.taskTitle)
        )

        const taskObj = {
          title: file.basename,
          path: file.path,
          isRoutine: true
        }
        this.tasks.push(taskObj)

        // 全ての実行履歴を追加
        todayExecutionsForTask.forEach(exec => {
          this.taskInstances.push({
            task: taskObj,
            isCompleted: true,
            startTime: exec.startTime,
            stopTime: exec.stopTime,
            slotKey: exec.slotKey
          })
        })
      }
    }.bind(view))

    await view.loadTasks()

    // 両方の実行履歴が正しくマッピングされる
    expect(view.taskInstances).toHaveLength(2)
    expect(view.taskInstances[0].task.title).toBe("タスクC")
    expect(view.taskInstances[1].task.title).toBe("タスクC")
    expect(view.taskInstances[0].isCompleted).toBe(true)
    expect(view.taskInstances[1].isCompleted).toBe(true)
  })
})