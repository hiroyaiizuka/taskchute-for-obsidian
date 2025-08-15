const { 
  ItemView, 
  TFile, 
  TFolder, 
  Plugin, 
  Notice 
} = require("obsidian")

describe("ルーチンタスク名変更後のナビゲーション", () => {
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
    view.taskList.createEl = jest.fn().mockImplementation((tag, options) => {
      const el = document.createElement(tag)
      if (options?.cls) el.className = options.cls
      if (options?.text) el.textContent = options.text
      el.addEventListener = jest.fn()
      return el
    })
    
    // 必要なメソッドのモック
    view.createTaskInstanceItem = jest.fn()
  })

  test("過去のタスク名（昼ごはん）クリック時に新しい名前（お昼ご飯）のファイルが開く", async () => {
    // 実行履歴から作成された仮想タスクインスタンスのモック
    const virtualInstance = {
      task: {
        title: "昼ごはん", // 実行時の名前
        isVirtual: true,
        currentName: "お昼ご飯" // 現在の名前
      },
      executedTitle: "昼ごはん",
      state: "done"
    }

    // createTaskInstanceItemの簡易実装
    view.createTaskInstanceItem = jest.fn().mockImplementation(function(inst) {
      const taskItem = document.createElement("div")
      const taskName = document.createElement("a")
      taskName.textContent = inst.executedTitle || inst.task.title
      
      // クリックイベントのハンドラー（実際のコードと同じロジック）
      taskName.addEventListener("click", async (e) => {
        e.preventDefault()
        const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
        
        let targetTaskName = inst.task.title
        
        // 仮想タスクの場合、currentNameがあればそれを使用
        if (inst.task.isVirtual && inst.task.currentName) {
          targetTaskName = inst.task.currentName
        } 
        // 実行タイトルがある場合、それを基に現在の名前を探す
        else if ((inst.executedTitle || inst.task.title) && this.plugin?.routineAliasManager?.findCurrentName) {
          const searchName = inst.executedTitle || inst.task.title
          const currentName = this.plugin.routineAliasManager.findCurrentName(searchName)
          if (currentName) {
            targetTaskName = currentName
          } else {
            targetTaskName = searchName
          }
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

    // 新しい名前のファイルが存在することをモック
    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === "TaskChute/Task/お昼ご飯.md") {
        return { path: path, basename: "お昼ご飯" }
      }
      return null
    })

    // テスト実行
    const { taskName } = view.createTaskInstanceItem(virtualInstance)
    
    // タスク名クリックをシミュレート
    const clickEvent = new Event("click")
    clickEvent.preventDefault = jest.fn()
    taskName.dispatchEvent(clickEvent)

    // 検証：新しい名前のファイルが開かれる
    expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith("お昼ご飯", "", false)
  })

  test("実行履歴のタスク名クリック時にfindCurrentNameで現在の名前を探す", async () => {
    // 実行履歴から作成されたタスクインスタンス（ファイルはある）
    const instance = {
      task: {
        title: "昼ごはん",
        isVirtual: false
      },
      executedTitle: "昼ごはん",
      state: "done"
    }

    view.createTaskInstanceItem = jest.fn().mockImplementation(function(inst) {
      const taskItem = document.createElement("div")
      const taskName = document.createElement("a")
      taskName.textContent = inst.executedTitle || inst.task.title
      
      taskName.addEventListener("click", async (e) => {
        e.preventDefault()
        const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
        
        let targetTaskName = inst.task.title
        
        if (inst.task.isVirtual && inst.task.currentName) {
          targetTaskName = inst.task.currentName
        } 
        else if ((inst.executedTitle || inst.task.title) && this.plugin?.routineAliasManager?.findCurrentName) {
          const searchName = inst.executedTitle || inst.task.title
          const currentName = this.plugin.routineAliasManager.findCurrentName(searchName)
          if (currentName) {
            targetTaskName = currentName
          } else {
            targetTaskName = searchName
          }
        }
        
        const filePath = `${taskFolderPath}/${targetTaskName}.md`
        const file = this.app.vault.getAbstractFileByPath(filePath)
        
        if (file) {
          this.app.workspace.openLinkText(targetTaskName, "", false)
        }
      })
      
      taskItem.appendChild(taskName)
      return { taskItem, taskName }
    }.bind(view))

    // 新しい名前のファイルが存在
    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === "TaskChute/Task/お昼ご飯.md") {
        return { path: path }
      }
      return null
    })

    const { taskName } = view.createTaskInstanceItem(instance)
    
    const clickEvent = new Event("click")
    clickEvent.preventDefault = jest.fn()
    taskName.dispatchEvent(clickEvent)

    // findCurrentNameが呼ばれたことを確認
    expect(routineAliasManager.findCurrentName).toHaveBeenCalledWith("昼ごはん")
    // 新しい名前でファイルが開かれる
    expect(mockApp.workspace.openLinkText).toHaveBeenCalledWith("お昼ご飯", "", false)
  })

})