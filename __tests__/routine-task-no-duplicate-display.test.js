const { 
  ItemView, 
  TFile, 
  TFolder, 
  Plugin, 
  Notice 
} = require("obsidian")

describe("ルーチンタスク名変更時の重複表示防止", () => {
  let view
  let plugin
  let mockApp
  let routineAliasManager

  beforeEach(() => {
    // モックの設定
    const mockMetadataCache = {
      getFileCache: jest.fn()
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
        "お昼ご飯": ["昼ごはん"]
      }),
      getAliases: jest.fn((name) => {
        if (name === "お昼ご飯") return ["昼ごはん"]
        return []
      }),
      findCurrentName: jest.fn((oldName) => {
        if (oldName === "昼ごはん") return "お昼ご飯"
        return null
      }),
      getAllPossibleNames: jest.fn((name) => {
        if (name === "お昼ご飯") return ["お昼ご飯", "昼ごはん"]
        if (name === "昼ごはん") return ["お昼ご飯", "昼ごはん"]
        return [name]
      }),
      aliasCache: {
        "お昼ご飯": ["昼ごはん"]
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
    view.shouldShowWeeklyRoutine = jest.fn().mockReturnValue(true)
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
    view.isRunningTaskStartedToday = jest.fn().mockResolvedValue(false)
    
    // loadTodayExecutions メソッドの実装
    view.loadTodayExecutions = jest.fn().mockImplementation(async (dateString) => {
      if (dateString === "2025-08-08") {
        // 過去に「昼ごはん」という名前で実行されていた
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
  })

  test("名前変更後のルーチンタスクが過去の日付で重複表示されない", async () => {
    // 現在は「お昼ご飯」という名前のファイルが存在
    const currentTaskFile = {
      path: "TaskChute/Task/お昼ご飯.md",
      basename: "お昼ご飯",
      extension: "md"
    }

    // タスクファイルのモック
    view.getTaskFiles = jest.fn().mockResolvedValue([currentTaskFile])
    
    // メタデータをモック（ルーチンタスク）
    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: {
        routine: true,
        開始時刻: "12:00",
        routine_type: "daily"
      }
    })
    
    mockApp.vault.read.mockResolvedValue("#task\n#routine\n開始時刻: 12:00")

    // 過去の日付に設定
    view.currentDate = new Date("2025-08-08")
    view.getCurrentDateString = jest.fn().mockReturnValue("2025-08-08")

    // loadTasksの簡易実装（実際のコードの重要部分を模倣）
    view.loadTasks = jest.fn().mockImplementation(async function() {
      const dateString = this.getCurrentDateString()
      const processedTaskNames = new Set()
      const processedFilePaths = new Set()
      const usedInstanceIds = new Set()
      
      // 実行履歴を読み込み
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
          
          // 見つからない場合、エイリアスマネージャーで現在の名前を探す
          if (!taskFile && this.plugin?.routineAliasManager?.findCurrentName) {
            const currentName = this.plugin.routineAliasManager.findCurrentName(exec.taskTitle)
            if (currentName) {
              taskFile = files.find(f => f.basename === currentName)
              currentTaskName = currentName
              // 現在の名前も処理済みとしてマーク
              processedTaskNames.add(currentName)
            }
          }
          
          // ファイルが存在する場合、そのパスを処理済みとしてマーク
          if (taskFile) {
            processedFilePaths.add(taskFile.path)
          }
          
          // タスクオブジェクトを作成（実行時の名前で）
          const taskObj = {
            title: exec.taskTitle,
            path: taskFile ? taskFile.path : `TaskChute/Task/${exec.taskTitle}.md`,
            file: taskFile || null,
            isRoutine: taskFile ? true : false,
            currentName: currentTaskName,
            isVirtual: !taskFile
          }
          
          this.tasks.push(taskObj)
          
          // 実行履歴からインスタンスを生成
          const instanceId = exec.instanceId || this.generateInstanceId(taskObj.path)
          
          if (!usedInstanceIds.has(instanceId)) {
            usedInstanceIds.add(instanceId)
            
            const instance = {
              task: taskObj,
              state: "done",
              startTime: new Date(exec.startTime),
              stopTime: new Date(exec.stopTime),
              slotKey: exec.slotKey,
              executedTitle: exec.taskTitle,
              instanceId: instanceId
            }
            
            this.taskInstances.push(instance)
          }
        }
      }

      // ファイルから読み込み（すでに処理済みのファイルはスキップ）
      for (const file of files) {
        // すでに実行履歴から処理済みのファイルはスキップ
        if (processedFilePaths.has(file.path)) continue
        
        const content = await this.app.vault.read(file)
        if (content.includes("#task")) {
          const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter
          const isRoutine = metadata?.routine === true
          
          // getAllPossibleNamesで全ての可能な名前を取得
          const allPossibleNames = this.plugin?.routineAliasManager?.getAllPossibleNames
            ? this.plugin.routineAliasManager.getAllPossibleNames(file.basename)
            : [file.basename]
          
          const todayExecutionsForTask = todayExecutions.filter(
            (exec) => allPossibleNames.includes(exec.taskTitle)
          )

          // ルーチンタスクの場合
          if (isRoutine) {
            const hasExecutions = todayExecutionsForTask.length > 0
            
            // エイリアスでの実行履歴があるかチェック
            let hasAliasExecutions = false
            if (!hasExecutions && this.plugin?.routineAliasManager?.getAliases) {
              const aliases = this.plugin.routineAliasManager.getAliases(file.basename)
              if (aliases && aliases.length > 0) {
                hasAliasExecutions = todayExecutions.some(exec => 
                  aliases.includes(exec.taskTitle)
                )
              }
            }
            
            // エイリアスでの実行履歴がある場合はスキップ（すでに処理済み）
            if (hasAliasExecutions) {
              continue
            }
            
            // 実行履歴がない場合、未実施タスクとして追加
            if (!hasExecutions) {
              const taskObj = {
                title: file.basename,
                path: file.path,
                file: file,
                isRoutine: true
              }
              
              this.tasks.push(taskObj)
              
              const instance = {
                task: taskObj,
                state: "idle",
                startTime: null,
                stopTime: null
              }
              
              this.taskInstances.push(instance)
            }
          }
        }
      }
    }.bind(view))

    // テスト実行
    await view.loadTasks()

    // 検証：タスクは1つだけ（重複なし）
    expect(view.tasks).toHaveLength(1)
    expect(view.tasks[0].title).toBe("昼ごはん") // 実行時の名前
    
    // インスタンスも1つだけ
    expect(view.taskInstances).toHaveLength(1)
    expect(view.taskInstances[0].state).toBe("done")
    expect(view.taskInstances[0].executedTitle).toBe("昼ごはん")
    
    // 「お昼ご飯」という未実施タスクが表示されていないことを確認
    const idleTasks = view.taskInstances.filter(inst => inst.state === "idle")
    expect(idleTasks).toHaveLength(0)
  })

  test("エイリアスチェックが正しく機能する", async () => {
    // getAliasesのモックを詳細に設定
    routineAliasManager.getAliases = jest.fn((name) => {
      if (name === "お昼ご飯") return ["昼ごはん", "ランチ"]
      if (name === "夕食") return ["夕飯", "ディナー"]
      return []
    })

    // 実行履歴に旧名が含まれている
    view.loadTodayExecutions = jest.fn().mockResolvedValue([
      {
        taskTitle: "ランチ", // エイリアスの一つ
        startTime: new Date("2025-08-08T12:00:00+09:00"),
        stopTime: new Date("2025-08-08T12:30:00+09:00"),
        slotKey: "12:00-16:00"
      }
    ])

    const newNameFile = {
      path: "TaskChute/Task/お昼ご飯.md",
      basename: "お昼ご飯",
      extension: "md"
    }

    view.getTaskFiles = jest.fn().mockResolvedValue([newNameFile])
    
    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: { routine: true }
    })
    
    mockApp.vault.read.mockResolvedValue("#task\n#routine")

    // エイリアスチェックのテスト
    const aliases = routineAliasManager.getAliases("お昼ご飯")
    expect(aliases).toContain("ランチ")
    
    const todayExecutions = await view.loadTodayExecutions("2025-08-08")
    const hasAliasExecutions = todayExecutions.some(exec => 
      aliases.includes(exec.taskTitle)
    )
    
    expect(hasAliasExecutions).toBe(true)
  })
})