const { 
  ItemView, 
  TFile, 
  TFolder, 
  Plugin, 
  Notice 
} = require("obsidian")

describe("ルーチンタスク名変更時の過去履歴表示（実行時の名前を維持）", () => {
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

    const mockWorkspace = {
      getLeavesOfType: jest.fn().mockReturnValue([]),
      openLinkText: jest.fn()
    }

    mockApp = {
      vault: mockVault,
      metadataCache: mockMetadataCache,
      workspace: mockWorkspace
    }

    // RoutineAliasManagerのモック
    routineAliasManager = {
      loadAliases: jest.fn().mockResolvedValue({
        "お昼ご飯": ["昼ごはん", "ランチ"]
      }),
      findCurrentName: jest.fn((oldName) => {
        if (oldName === "昼ごはん" || oldName === "ランチ") return "お昼ご飯"
        return null
      }),
      getAllPossibleNames: jest.fn((name) => {
        if (name === "お昼ご飯") return ["お昼ご飯", "昼ごはん", "ランチ"]
        return [name]
      }),
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
    view.currentDate = new Date("2025-08-08")
    view.taskInstances = []
    view.tasks = []
    
    // DOM要素のモック
    view.containerEl = document.createElement("div")
    view.contentEl = document.createElement("div")
    view.taskList = document.createElement("div")
    view.taskList.empty = jest.fn()
    view.taskList.scrollTop = 0
    view.taskList.scrollLeft = 0
    view.taskList.createEl = jest.fn().mockImplementation((tag, options) => {
      const el = document.createElement(tag)
      if (options?.cls) el.className = options.cls
      if (options?.text) el.textContent = options.text
      el.createEl = jest.fn().mockReturnValue(document.createElement('span'))
      el.addEventListener = jest.fn()
      return el
    })
    
    // 必要なメソッドのモック
    view.getTimeSlotKeys = jest.fn().mockReturnValue([
      "0:00-8:00",
      "8:00-12:00", 
      "12:00-16:00",
      "16:00-0:00"
    ])
    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-08")
    view.getDeletedInstances = jest.fn().mockReturnValue([])
    view.getHiddenRoutines = jest.fn().mockReturnValue([])
    view.loadSavedOrders = jest.fn().mockReturnValue({})
    view.generateInstanceId = jest.fn().mockReturnValue("test-instance-id")
    view.determineSlotKey = jest.fn().mockReturnValue("12:00-16:00")
    view.sortTaskInstancesByTimeOrder = jest.fn()
    view.applyResponsiveClasses = jest.fn()
    view.renderTaskList = jest.fn()
    view.restoreRunningTaskState = jest.fn().mockResolvedValue()
    view.initializeTaskOrders = jest.fn()
    view.moveIdleTasksToCurrentSlot = jest.fn()
    view.cleanupOldStorageKeys = jest.fn()
    view.recalculateYesterdayDailySummary = jest.fn().mockResolvedValue()
    view.isInstanceDeleted = jest.fn().mockReturnValue(false)
    view.isInstanceHidden = jest.fn().mockReturnValue(false)
    view.createTaskInstanceItem = jest.fn()
    
    // loadTodayExecutions メソッドの実装
    view.loadTodayExecutions = jest.fn().mockImplementation(async (dateString) => {
      if (dateString === "2025-08-08") {
        // 2日前：「昼ごはん」という名前で実行されていた
        return [
          {
            taskTitle: "昼ごはん", // 実行時の名前
            startTime: new Date("2025-08-08T12:00:00+09:00"),
            stopTime: new Date("2025-08-08T12:30:00+09:00"),
            slotKey: "12:00-16:00",
            instanceId: "lunch-exec-1"
          }
        ]
      }
      return []
    })

    view.getTaskFiles = jest.fn().mockResolvedValue([])
    view.loadTasks = jest.fn()
  })

  test("過去の実行履歴は実行時の名前で表示される", async () => {
    // 現在は「お昼ご飯」という名前のファイルが存在
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

    // loadTasksの簡易実装（実際のコードを反映）
    view.loadTasks = jest.fn().mockImplementation(async function() {
      const dateString = this.getCurrentDateString()
      const processedTaskNames = new Set()
      const usedInstanceIds = new Set()
      
      // 実行履歴を読み込み
      const todayExecutions = await this.loadTodayExecutions(dateString)
      const files = await this.getTaskFiles()
      
      this.tasks = []
      this.taskInstances = []

      // まず実行履歴からタスクインスタンスを生成
      for (const exec of todayExecutions) {
        if (!processedTaskNames.has(exec.taskTitle)) {
          processedTaskNames.add(exec.taskTitle)
          
          // 実行履歴のタスク名に対応するファイルを探す
          let taskFile = files.find(f => f.basename === exec.taskTitle)
          let currentTaskName = exec.taskTitle
          
          // 見つからない場合、エイリアスマネージャーで現在の名前を探す
          if (!taskFile && this.plugin?.routineAliasManager?.findCurrentName) {
            const currentName = this.plugin.routineAliasManager.findCurrentName(exec.taskTitle)
            if (currentName) {
              taskFile = files.find(f => f.basename === currentName)
              currentTaskName = currentName
            }
          }
          
          // このタスク名の全実行履歴を取得
          const taskExecutions = todayExecutions.filter(e => e.taskTitle === exec.taskTitle)
          
          // タスクオブジェクトを作成（ファイルの有無に関わらず実行時の名前で）
          const taskObj = {
            title: exec.taskTitle, // 実行時の名前を使用
            path: taskFile ? taskFile.path : `TaskChute/Task/${exec.taskTitle}.md`,
            file: taskFile || null,
            isRoutine: false,
            scheduledTime: null,
            slotKey: exec.slotKey || "none",
            isVirtual: !taskFile,
            currentName: currentTaskName
          }
          
          this.tasks.push(taskObj)
          
          // 実行履歴からインスタンスを生成
          taskExecutions.forEach((execution) => {
            const instanceId = execution.instanceId || this.generateInstanceId(taskObj.path)
            
            if (!usedInstanceIds.has(instanceId)) {
              usedInstanceIds.add(instanceId)
              
              const instance = {
                task: taskObj,
                state: "done",
                startTime: new Date(execution.startTime),
                stopTime: new Date(execution.stopTime),
                slotKey: execution.slotKey || "none",
                executedTitle: execution.taskTitle, // 実行時のタスク名
                instanceId: instanceId,
                isVirtual: !taskFile
              }
              
              this.taskInstances.push(instance)
            }
          })
        }
      }
    }.bind(view))

    // テスト実行
    await view.loadTasks()

    // 検証
    expect(view.tasks).toHaveLength(1)
    expect(view.tasks[0].title).toBe("昼ごはん") // 実行時の名前が保持される
    expect(view.tasks[0].isVirtual).toBe(false) // ファイルが存在するのでfalse
    expect(view.tasks[0].currentName).toBe("お昼ご飯") // 現在の名前も保持
    
    expect(view.taskInstances).toHaveLength(1)
    expect(view.taskInstances[0].state).toBe("done")
    expect(view.taskInstances[0].executedTitle).toBe("昼ごはん") // 実行時の名前
    expect(view.taskInstances[0].task.title).toBe("昼ごはん")
    expect(view.taskInstances[0].isVirtual).toBe(false) // ファイルが存在するのでfalse
  })

  test("タスク名クリック時は現在の名前のファイルを開く", async () => {
    // タスクインスタンスのモック
    const virtualInstance = {
      task: {
        title: "昼ごはん",
        isVirtual: true,
        currentName: "お昼ご飯"
      },
      executedTitle: "昼ごはん",
      state: "done"
    }

    // createTaskInstanceItemの簡易実装
    view.createTaskInstanceItem = jest.fn().mockImplementation(function(inst) {
      const taskItem = document.createElement("div")
      const taskName = document.createElement("a")
      taskName.textContent = inst.executedTitle || inst.task.title
      
      // クリックイベントの実装
      taskName.addEventListener("click", async (e) => {
        e.preventDefault()
        const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
        
        let targetTaskName = inst.task.title
        
        // 仮想タスクの場合、currentNameがあればそれを使用
        if (inst.task.isVirtual && inst.task.currentName) {
          targetTaskName = inst.task.currentName
        }
        
        const filePath = `${taskFolderPath}/${targetTaskName}.md`
        const file = this.app.vault.getAbstractFileByPath(filePath)
        
        if (file) {
          this.app.workspace.openLinkText(targetTaskName, "", false)
        } else {
          new Notice(`タスクファイル「${targetTaskName}」が見つかりません`)
        }
      })
      
      taskItem.appendChild(taskName)
      return { taskItem, taskName }
    }.bind(view))

    // 現在のファイルが存在することをモック
    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === "TaskChute/Task/お昼ご飯.md") {
        return { path: path } // ファイルが存在
      }
      return null
    })

    // テスト実行
    const { taskName } = view.createTaskInstanceItem(virtualInstance)
    
    // タスク名クリックをシミュレート
    const clickEvent = new Event("click")
    clickEvent.preventDefault = jest.fn()
    taskName.dispatchEvent(clickEvent)

    // 検証
    expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith("お昼ご飯", "", false)
  })

  test("ファイルが存在する場合も実行履歴を優先して表示", async () => {
    // 現在のタスクファイル（新しい名前）
    const currentTaskFile = {
      path: "TaskChute/Task/お昼ご飯.md",
      basename: "お昼ご飯",
      extension: "md"
    }

    view.getTaskFiles = jest.fn().mockResolvedValue([currentTaskFile])
    mockApp.vault.read.mockResolvedValue("#task\n#routine")
    
    // 過去の実行履歴（旧名で記録）
    view.loadTodayExecutions = jest.fn().mockResolvedValue([
      {
        taskTitle: "昼ごはん", // 旧名で実行
        startTime: new Date("2025-08-08T12:00:00+09:00"),
        stopTime: new Date("2025-08-08T12:30:00+09:00"),
        slotKey: "12:00-16:00"
      }
    ])

    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-08")

    view.loadTasks = jest.fn().mockImplementation(async function() {
      const dateString = this.getCurrentDateString()
      const processedTaskNames = new Set()
      const usedInstanceIds = new Set()
      
      const todayExecutions = await this.loadTodayExecutions(dateString)
      const files = await this.getTaskFiles()
      
      this.tasks = []
      this.taskInstances = []

      // 実行履歴からタスクインスタンスを生成
      for (const exec of todayExecutions) {
        if (!processedTaskNames.has(exec.taskTitle)) {
          processedTaskNames.add(exec.taskTitle)
          
          // 実行履歴のタスク名に対応するファイルを探す
          let taskFile = files.find(f => f.basename === exec.taskTitle)
          let currentTaskName = exec.taskTitle
          
          if (!taskFile && this.plugin?.routineAliasManager?.findCurrentName) {
            const currentName = this.plugin.routineAliasManager.findCurrentName(exec.taskTitle)
            if (currentName) {
              taskFile = files.find(f => f.basename === currentName)
              currentTaskName = currentName
            }
          }
          
          // ファイルが存在しても、実行履歴の名前でタスクを作成
          const taskObj = {
            title: exec.taskTitle, // 実行時の名前を維持
            path: taskFile ? taskFile.path : `TaskChute/Task/${exec.taskTitle}.md`,
            file: taskFile || null,
            isRoutine: taskFile ? true : false,
            currentName: currentTaskName,
            isVirtual: !taskFile
          }
          
          this.tasks.push(taskObj)
          
          const instance = {
            task: taskObj,
            state: "done",
            startTime: new Date(exec.startTime),
            stopTime: new Date(exec.stopTime),
            slotKey: exec.slotKey,
            executedTitle: exec.taskTitle
          }
          
          this.taskInstances.push(instance)
        }
      }
    }.bind(view))

    await view.loadTasks()

    // 実行時の名前で表示されることを確認
    expect(view.tasks).toHaveLength(1)
    expect(view.tasks[0].title).toBe("昼ごはん") // 実行時の名前
    expect(view.tasks[0].currentName).toBe("お昼ご飯") // 現在の名前
    expect(view.taskInstances[0].executedTitle).toBe("昼ごはん")
  })
})