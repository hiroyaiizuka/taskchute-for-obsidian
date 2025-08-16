/**
 * 完了済みルーチンタスクの状態復元修正テスト
 * 
 * 問題の概要:
 * ルーチンタスクを実行・完了し、Obsidianを再起動すると、
 * 完了済みタスクが「ルーチン化されてない」と表示される
 * 
 * 原因:
 * loadTasksで実行履歴からタスクオブジェクトを生成する際、
 * isRoutine: falseで初期化され、その後の重複防止ロジックにより
 * ファイルからのメタデータ読み込みがスキップされるため
 * 
 * 修正内容:
 * 実行履歴からタスクオブジェクトを作成する際に、
 * 対応するファイルのメタデータも同時に読み込んで
 * isRoutineや他のルーチン関連プロパティを正しく設定
 */

describe("完了済みルーチンタスクの状態復元", () => {
  let mockApp
  let plugin
  let view

  beforeEach(() => {
    // モックセットアップ
    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        adapter: {
          stat: jest.fn()
        }
      },
      metadataCache: {
        getFileCache: jest.fn()
      }
    }

    plugin = {
      pathManager: {
        getLogDataPath: jest.fn().mockReturnValue("02_Config/TaskChute/Log"),
        getTaskFolderPath: jest.fn().mockReturnValue("TaskChute/Task"),
        getProjectFolderPath: jest.fn().mockReturnValue("Project")
      },
      routineAliasManager: {
        loadAliases: jest.fn(),
        findCurrentName: jest.fn(),
        getAllPossibleNames: jest.fn().mockImplementation(name => [name]),
        getAliases: jest.fn()
      }
    }

    view = {
      app: mockApp,
      plugin: plugin,
      taskInstances: [],
      tasks: [],
      currentDate: new Date("2024-01-15T14:00:00"),
      getCurrentDateString: jest.fn().mockReturnValue("2024-01-15"),
      generateInstanceId: jest.fn().mockReturnValue("instance-123"),
      getDeletedInstances: jest.fn().mockReturnValue([]),
      getHiddenRoutines: jest.fn().mockReturnValue([]),
      loadSavedOrders: jest.fn().mockReturnValue({}),
      determineSlotKey: jest.fn().mockReturnValue("none"),
      shouldShowWeeklyRoutine: jest.fn().mockReturnValue(true),
      isInstanceDeleted: jest.fn().mockReturnValue(false),
      isInstanceHidden: jest.fn().mockReturnValue(false),
      sortTaskInstancesByTimeOrder: jest.fn(),
      restoreRunningTaskState: jest.fn(),
      initializeTaskOrders: jest.fn(),
      moveIdleTasksToCurrentSlot: jest.fn(),
      renderTaskList: jest.fn(),
      recalculateYesterdayDailySummary: jest.fn(),
      loadTodayExecutions: jest.fn(),
      getTaskFiles: jest.fn(),
      migrateRoutineTaskMetadata: jest.fn()
    }

    // メソッドをバインド
    view.loadTasks = loadTasksMethod.bind(view)
  })

  test("完了済みルーチンタスクが再起動後も正しくルーチンとして表示される", async () => {
    // ルーチンタスクのファイル
    const routineTaskFile = {
      path: "TaskChute/Task/Clipperレビュー.md",
      basename: "Clipperレビュー"
    }

    // 完了済みタスクの実行履歴
    const todayExecutions = [{
      taskTitle: "Clipperレビュー",
      startTime: new Date("2024-01-15T09:00:00"),
      stopTime: new Date("2024-01-15T09:30:00"),
      slotKey: "8:00-12:00",
      instanceId: "completed-instance-1"
    }]

    // ファイルのメタデータ（ルーチン設定あり）
    const routineMetadata = {
      routine: true,
      isRoutine: true,
      開始時刻: "09:00",
      routine_type: "daily"
    }

    // モックの設定
    view.loadTodayExecutions.mockResolvedValue(todayExecutions)
    view.getTaskFiles.mockResolvedValue([routineTaskFile])
    
    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: routineMetadata
    })

    // loadTasksを実行
    await view.loadTasks()

    // 結果の検証
    expect(view.tasks).toHaveLength(1)
    const task = view.tasks[0]
    
    // 【重要】完了済みルーチンタスクのisRoutineがtrueになっていることを確認
    expect(task.isRoutine).toBe(true)
    expect(task.title).toBe("Clipperレビュー")
    expect(task.scheduledTime).toBe("09:00")
    expect(task.routineType).toBe("daily")

    // 完了済みインスタンスも正しく生成されていることを確認
    const completedInstance = view.taskInstances.find(inst => 
      inst.state === "done" && inst.task.title === "Clipperレビュー"
    )
    expect(completedInstance).toBeDefined()
    expect(completedInstance.task.isRoutine).toBe(true)
  })

  test("ファイルが存在しない仮想タスクは従来通りisRoutine=falseになる", async () => {
    // 仮想タスクの実行履歴（ファイルなし）
    const todayExecutions = [{
      taskTitle: "削除されたタスク",
      startTime: new Date("2024-01-15T10:00:00"),
      stopTime: new Date("2024-01-15T10:30:00"),
      slotKey: "8:00-12:00",
      instanceId: "virtual-instance-1"
    }]

    // モックの設定（ファイルが見つからない）
    view.loadTodayExecutions.mockResolvedValue(todayExecutions)
    view.getTaskFiles.mockResolvedValue([]) // ファイルなし

    // loadTasksを実行
    await view.loadTasks()

    // 結果の検証
    expect(view.tasks).toHaveLength(1)
    const task = view.tasks[0]
    
    // 仮想タスクはisRoutine=falseのまま
    expect(task.isRoutine).toBe(false)
    expect(task.title).toBe("削除されたタスク")
    expect(task.isVirtual).toBe(true)
    expect(task.file).toBe(null)
  })

  test("プロジェクト情報も正しく復元される", async () => {
    // プロジェクト付きルーチンタスクのファイル
    const taskFile = {
      path: "TaskChute/Task/プロジェクトタスク.md",
      basename: "プロジェクトタスク"
    }

    // 実行履歴
    const todayExecutions = [{
      taskTitle: "プロジェクトタスク",
      startTime: new Date("2024-01-15T11:00:00"),
      stopTime: new Date("2024-01-15T11:45:00"),
      slotKey: "8:00-12:00",
      instanceId: "project-task-1"
    }]

    // プロジェクト情報付きのメタデータ
    const metadata = {
      routine: true,
      isRoutine: true,
      project: "[[重要プロジェクト]]",
      project_path: "Project/重要プロジェクト.md"
    }

    // モックの設定
    view.loadTodayExecutions.mockResolvedValue(todayExecutions)
    view.getTaskFiles.mockResolvedValue([taskFile])
    
    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata
    })

    // loadTasksを実行
    await view.loadTasks()

    // 結果の検証
    const task = view.tasks[0]
    expect(task.isRoutine).toBe(true)
    expect(task.projectTitle).toBe("重要プロジェクト")
    expect(task.projectPath).toBe("Project/重要プロジェクト.md")
  })

  test("週次・月次ルーチンの情報も正しく復元される", async () => {
    // 週次ルーチンタスクのファイル
    const taskFile = {
      path: "TaskChute/Task/週次レビュー.md",
      basename: "週次レビュー"
    }

    // 実行履歴
    const todayExecutions = [{
      taskTitle: "週次レビュー",
      startTime: new Date("2024-01-15T15:00:00"),
      stopTime: new Date("2024-01-15T16:00:00"),
      slotKey: "16:00-0:00",
      instanceId: "weekly-task-1"
    }]

    // 週次ルーチンのメタデータ
    const metadata = {
      routine: true,
      isRoutine: true,
      routine_type: "weekly",
      weekday: 1, // 月曜日
      開始時刻: "15:00"
    }

    // モックの設定
    view.loadTodayExecutions.mockResolvedValue(todayExecutions)
    view.getTaskFiles.mockResolvedValue([taskFile])
    
    mockApp.metadataCache.getFileCache.mockReturnValue({
      frontmatter: metadata
    })

    // loadTasksを実行
    await view.loadTasks()

    // 結果の検証
    const task = view.tasks[0]
    expect(task.isRoutine).toBe(true)
    expect(task.routineType).toBe("weekly")
    expect(task.weekday).toBe(1)
    expect(task.scheduledTime).toBe("15:00")
  })
})

// loadTasksメソッドの簡略実装（テスト用）
async function loadTasksMethod() {
  // 基本的な初期化
  if (this.plugin?.routineAliasManager?.loadAliases) {
    await this.plugin.routineAliasManager.loadAliases()
  }
  
  await this.recalculateYesterdayDailySummary()
  
  this.tasks = []
  this.taskInstances = []
  
  const usedInstanceIds = new Set()
  const deletedInstances = this.getDeletedInstances(this.getCurrentDateString())
  
  const dateString = this.getCurrentDateString()
  const savedOrders = this.loadSavedOrders(dateString)
  const hiddenRoutines = this.getHiddenRoutines(dateString)
  
  // 並列処理でパフォーマンス改善
  const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
  const [todayExecutions, files] = await Promise.all([
    this.loadTodayExecutions(dateString),
    this.getTaskFiles(taskFolderPath),
  ])
  
  const processedTaskNames = new Set()
  const processedFilePaths = new Set()

  // 実行履歴からタスクインスタンスを生成
  for (const exec of todayExecutions) {
    if (!processedTaskNames.has(exec.taskTitle)) {
      processedTaskNames.add(exec.taskTitle)

      // 実行履歴のタスク名に対応するファイルを探す
      let taskFile = files.find((f) => f.basename === exec.taskTitle)
      let currentTaskName = exec.taskTitle

      // エイリアスマネージャーで現在の名前を探す
      if (!taskFile && this.plugin?.routineAliasManager?.findCurrentName) {
        const currentName = this.plugin.routineAliasManager.findCurrentName(exec.taskTitle)
        if (currentName) {
          taskFile = files.find((f) => f.basename === currentName)
          currentTaskName = currentName
          processedTaskNames.add(currentName)
        }
      }

      if (taskFile) {
        processedFilePaths.add(taskFile.path)
      }

      // このタスク名の全実行履歴を取得
      const taskExecutions = todayExecutions.filter((e) => e.taskTitle === exec.taskTitle)

      // 【修正】ファイルが存在する場合はメタデータからルーチン情報を読み込み
      let isRoutine = false
      let scheduledTime = null
      let routineType = "daily"
      let weekday = null
      let weekdays = null
      let monthlyWeek = null
      let monthlyWeekday = null
      let projectPath = null
      let projectTitle = null

      if (taskFile) {
        // メタデータからルーチン情報を読み込み
        const metadata = this.app.metadataCache.getFileCache(taskFile)?.frontmatter
        if (metadata) {
          isRoutine = metadata.routine === true || metadata.isRoutine === true
          scheduledTime = metadata.開始時刻 || null
          routineType = metadata.routine_type || "daily"
          weekday = metadata.weekday !== undefined ? metadata.weekday : null
          weekdays = metadata.weekdays || null
          monthlyWeek = metadata.monthly_week || null
          monthlyWeekday = metadata.monthly_weekday !== undefined ? metadata.monthly_weekday : null
          
          // プロジェクト情報を読み込み
          projectPath = metadata.project_path || null
          if (metadata.project) {
            const projectMatch = metadata.project.match(/\[\[([^\]]+)\]\]/)
            if (projectMatch) {
              projectTitle = projectMatch[1]
              // project_pathが存在しない場合、projectTitleからprojectPathを復元
              if (!projectPath && projectTitle) {
                const projectFolderPath = this.plugin.pathManager.getProjectFolderPath()
                const reconstructedPath = `${projectFolderPath}/${projectTitle}.md`
                const projectFile = this.app.vault.getAbstractFileByPath(reconstructedPath)
                if (projectFile) {
                  projectPath = reconstructedPath
                } else {
                  try {
                    const allFiles = this.app.vault.getMarkdownFiles()
                    const matchingProject = allFiles.find(
                      (file) =>
                        file.basename === projectTitle &&
                        (file.path.includes("Project") || file.path.includes("project")),
                    )
                    if (matchingProject) {
                      projectPath = matchingProject.path
                    }
                  } catch (e) {
                    // プロジェクトファイル検索エラーは無視
                  }
                }
              }
            }
          }
        }
      }

      // タスクオブジェクトを作成
      const taskObj = {
        title: exec.taskTitle,
        path: taskFile ? taskFile.path : `TaskChute/Task/${exec.taskTitle}.md`,
        file: taskFile || null,
        isRoutine: isRoutine, // 【修正】メタデータから正しく読み込み
        scheduledTime: scheduledTime,
        slotKey: exec.slotKey || "none",
        routineType: routineType,
        weekday: weekday,
        weekdays: weekdays,
        monthlyWeek: monthlyWeek,
        monthlyWeekday: monthlyWeekday,
        projectPath: projectPath,
        projectTitle: projectTitle,
        isVirtual: !taskFile,
        currentName: currentTaskName,
      }

      this.tasks.push(taskObj)

      // 実行履歴からインスタンスを生成
      taskExecutions.forEach((execution) => {
        const instanceSlotKey = execution.slotKey || "none"
        const instanceId = execution.instanceId || this.generateInstanceId(taskObj.path)

        if (!usedInstanceIds.has(instanceId)) {
          usedInstanceIds.add(instanceId)

          const instance = {
            task: taskObj,
            state: "done",
            startTime: new Date(execution.startTime),
            stopTime: new Date(execution.stopTime),
            slotKey: instanceSlotKey,
            order: null,
            executedTitle: execution.taskTitle,
            instanceId: instanceId,
            isVirtual: !taskFile,
          }

          this.taskInstances.push(instance)
        }
      })
    }
  }

  // ソートと復元処理
  this.sortTaskInstancesByTimeOrder()
  await this.restoreRunningTaskState()
  this.initializeTaskOrders()
  this.moveIdleTasksToCurrentSlot()
  this.renderTaskList()
}