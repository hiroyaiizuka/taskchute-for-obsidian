/**
 * Control+D削除バグ修正のテスト
 * 
 * 問題: 新規作成した非ルーチンタスクをControl+Dで削除すると、再起動時に復活してしまう
 * 修正: deleteSelectedTask()をツールチップと同じ削除処理に統一
 */

describe('Control+D削除処理の修正', () => {
  let plugin
  let view
  let mockApp
  let mockWorkspace
  let mockVault
  let mockMetadataCache

  beforeEach(() => {
    // モックの初期化
    localStorage.clear()
    
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      read: jest.fn(),
      modify: jest.fn(),
      adapter: {
        exists: jest.fn().mockResolvedValue(false),
        read: jest.fn(),
        write: jest.fn(),
        list: jest.fn().mockResolvedValue({ files: [] })
      }
    }

    mockMetadataCache = {
      getFileCache: jest.fn()
    }

    mockWorkspace = {
      getLeavesOfType: jest.fn().mockReturnValue([]),
      getLeaf: jest.fn()
    }

    mockApp = {
      vault: mockVault,
      workspace: mockWorkspace,
      metadataCache: mockMetadataCache
    }

    // プラグインのモック
    plugin = {
      app: mockApp,
      settings: {},
      saveData: jest.fn(),
      getCurrentDateString: jest.fn().mockReturnValue('2024-01-25')
    }

    // ビューの初期化
    const { TaskChuteView } = require('../main.js')
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(null, mockPlugin)
    view.app = mockApp
    view.plugin = plugin
    view.taskInstances = []
    view.tasks = []
    view.currentDate = new Date(2024, 0, 25)
    
    // 必要なメソッドのモック
    view.renderTaskList = jest.fn()
    view.clearTaskSelection = jest.fn()
    view.saveRunningTasksState = jest.fn().mockResolvedValue(undefined)
    view.deleteTaskLogs = jest.fn().mockResolvedValue(undefined)
    view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(true)
    view.getDeletedInstances = jest.fn().mockReturnValue([])
    view.saveDeletedInstances = jest.fn()
    view.getDuplicatedInstances = jest.fn().mockReturnValue([])
    view.getHiddenRoutines = jest.fn().mockReturnValue([])
    view.saveHiddenRoutines = jest.fn()
    view.generateInstanceId = jest.fn().mockImplementation(path => `instance-${path}`)
    
    // deleteNonRoutineTaskとdeleteRoutineTaskのモック
    view.deleteNonRoutineTask = jest.fn().mockImplementation(async function(inst) {
      const samePathInstances = this.taskInstances.filter(
        i => i !== inst && i.task.path === inst.task.path
      )
      
      if (samePathInstances.length > 0) {
        // 複製インスタンスの削除
        this.taskInstances = this.taskInstances.filter((i) => i !== inst)
        this.saveDeletedInstances('2024-01-25', [{
          path: inst.task.path,
          instanceId: inst.instanceId,
          deletionType: 'temporary',
          deletedAt: new Date().toISOString()
        }])
        new Notice(`「${inst.task.title}」を削除しました。`)
      } else {
        // 最後のインスタンス：ファイルも削除
        this.taskInstances = this.taskInstances.filter((i) => i !== inst)
        this.tasks = this.tasks.filter((t) => t.path !== inst.task.path)
        await mockVault.delete(inst.task.file)
        this.saveDeletedInstances('2024-01-25', [{
          path: inst.task.path,
          instanceId: inst.instanceId,
          deletionType: 'permanent',
          deletedAt: new Date().toISOString()
        }])
        await this.deleteTaskLogs(inst.task.path)
        if (inst.state === "running") {
          await this.saveRunningTasksState()
        }
        this.renderTaskList()
        new Notice(`「${inst.task.title}」を完全に削除しました。`)
      }
    })
    
    view.deleteRoutineTask = jest.fn().mockImplementation(async function(inst) {
      this.taskInstances = this.taskInstances.filter((i) => i !== inst)
      this.saveHiddenRoutines('2024-01-25', [{
        path: inst.task.path,
        instanceId: null
      }])
      await this.deleteTaskLogs(inst.task.path)
      if (inst.state === "running") {
        await this.saveRunningTasksState()
      }
      this.renderTaskList()
      new Notice(`「${inst.task.title}」を本日のリストから削除しました`)
    })
    
    // Noticeのモック
    global.Notice = jest.fn()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('非ルーチンタスクの削除', () => {
    test('新規作成した非ルーチンタスクがControl+Dで完全削除される', async () => {
      // テストデータの準備
      const taskFile = {
        path: 'TaskChute/Task/新規タスク.md',
        basename: '新規タスク',
        extension: 'md'
      }

      const taskInstance = {
        task: {
          path: taskFile.path,
          file: taskFile,
          title: '新規タスク',
          isRoutine: false
        },
        state: 'idle',
        instanceId: 'test-instance-1'
      }

      view.selectedTaskInstance = taskInstance
      view.taskInstances = [taskInstance]
      view.tasks = [taskInstance.task]

      // 削除実行
      await view.deleteSelectedTask()

      // ファイルが削除されることを確認
      expect(mockVault.delete).toHaveBeenCalledWith(taskFile)
      
      // taskInstancesから削除されることを確認
      expect(view.taskInstances).toHaveLength(0)
      expect(view.tasks).toHaveLength(0)
      
      // saveDeletedInstancesが呼ばれることを確認
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-25',
        expect.arrayContaining([
          expect.objectContaining({
            path: taskFile.path,
            instanceId: 'test-instance-1',
            deletionType: 'permanent'
          })
        ])
      )
      
      // UIが更新されることを確認
      expect(view.renderTaskList).toHaveBeenCalled()
      expect(global.Notice).toHaveBeenCalledWith('「新規タスク」を完全に削除しました。')
    })

    test('複製された非ルーチンタスクはインスタンスのみ削除される', async () => {
      // 同じパスの2つのインスタンスを作成
      const taskFile = {
        path: 'TaskChute/Task/複製タスク.md',
        basename: '複製タスク',
        extension: 'md'
      }

      const taskInstance1 = {
        task: {
          path: taskFile.path,
          file: taskFile,
          title: '複製タスク',
          isRoutine: false
        },
        state: 'idle',
        instanceId: 'test-instance-1'
      }

      const taskInstance2 = {
        task: {
          path: taskFile.path,
          file: taskFile,
          title: '複製タスク',
          isRoutine: false
        },
        state: 'idle',
        instanceId: 'test-instance-2'
      }

      view.selectedTaskInstance = taskInstance2
      view.taskInstances = [taskInstance1, taskInstance2]
      view.tasks = [taskInstance1.task]

      // 削除実行
      await view.deleteSelectedTask()

      // ファイルは削除されないことを確認
      expect(mockVault.delete).not.toHaveBeenCalled()
      
      // インスタンスのみ削除されることを確認
      expect(view.taskInstances).toHaveLength(1)
      expect(view.taskInstances[0]).toBe(taskInstance1)
      
      // tasksは変更されないことを確認
      expect(view.tasks).toHaveLength(1)
      
      // saveDeletedInstancesが呼ばれることを確認
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-25',
        expect.arrayContaining([
          expect.objectContaining({
            path: taskFile.path,
            instanceId: 'test-instance-2',
            deletionType: 'temporary'
          })
        ])
      )
      
      // 通知メッセージを確認
      expect(global.Notice).toHaveBeenCalledWith('「複製タスク」を削除しました。')
    })
  })

  describe('ルーチンタスクの削除', () => {
    test('ルーチンタスクはその日だけ非表示になる', async () => {
      const taskFile = {
        path: 'TaskChute/Task/ルーチンタスク.md',
        basename: 'ルーチンタスク',
        extension: 'md'
      }

      const taskInstance = {
        task: {
          path: taskFile.path,
          file: taskFile,
          title: 'ルーチンタスク',
          isRoutine: true
        },
        state: 'idle',
        instanceId: 'test-instance-1'
      }

      view.selectedTaskInstance = taskInstance
      view.taskInstances = [taskInstance]
      view.tasks = [taskInstance.task]

      // 削除実行
      await view.deleteSelectedTask()

      // ファイルは削除されないことを確認
      expect(mockVault.delete).not.toHaveBeenCalled()
      
      // インスタンスから削除されることを確認
      expect(view.taskInstances).toHaveLength(0)
      
      // saveHiddenRoutinesが呼ばれることを確認
      expect(view.saveHiddenRoutines).toHaveBeenCalledWith(
        '2024-01-25',
        expect.arrayContaining([
          expect.objectContaining({
            path: taskFile.path,
            instanceId: null
          })
        ])
      )
      
      // 通知メッセージを確認
      expect(global.Notice).toHaveBeenCalledWith(
        '「ルーチンタスク」を本日のリストから削除しました'
      )
    })
  })

  describe('実行中タスクの削除', () => {
    test('実行中タスクを削除するとrunning-task.jsonが更新される', async () => {
      const taskFile = {
        path: 'TaskChute/Task/実行中タスク.md',
        basename: '実行中タスク',
        extension: 'md'
      }

      const taskInstance = {
        task: {
          path: taskFile.path,
          file: taskFile,
          title: '実行中タスク',
          isRoutine: false
        },
        state: 'running',
        instanceId: 'test-instance-1',
        startTime: new Date()
      }

      view.selectedTaskInstance = taskInstance
      view.taskInstances = [taskInstance]
      view.tasks = [taskInstance.task]

      // 削除実行
      await view.deleteSelectedTask()

      // running-task.jsonが更新されることを確認
      expect(view.saveRunningTasksState).toHaveBeenCalled()
      
      // ファイルが削除されることを確認
      expect(mockVault.delete).toHaveBeenCalledWith(taskFile)
    })
  })

  describe('削除確認ダイアログ', () => {
    test('削除がキャンセルされた場合は何も削除されない', async () => {
      view.showDeleteConfirmDialog = jest.fn().mockResolvedValue(false)
      
      const taskInstance = {
        task: {
          path: 'TaskChute/Task/テストタスク.md',
          title: 'テストタスク',
          isRoutine: false
        },
        state: 'idle',
        instanceId: 'test-instance-1'
      }

      view.selectedTaskInstance = taskInstance
      view.taskInstances = [taskInstance]

      // 削除実行
      await view.deleteSelectedTask()

      // 何も削除されないことを確認
      expect(mockVault.delete).not.toHaveBeenCalled()
      expect(view.taskInstances).toHaveLength(1)
      expect(view.renderTaskList).not.toHaveBeenCalled()
      expect(global.Notice).not.toHaveBeenCalled()
    })
  })

  describe('日付をまたいだ動作の確認', () => {
    test('削除した非ルーチンタスクは翌日も表示されない', async () => {
      // 1月25日に削除
      const taskFile = {
        path: 'TaskChute/Task/永続削除タスク.md',
        basename: '永続削除タスク',
        extension: 'md'
      }

      const taskInstance = {
        task: {
          path: taskFile.path,
          file: taskFile,
          title: '永続削除タスク',
          isRoutine: false
        },
        state: 'idle',
        instanceId: 'test-instance-1'
      }

      view.selectedTaskInstance = taskInstance
      view.taskInstances = [taskInstance]
      view.tasks = [taskInstance.task]

      await view.deleteSelectedTask()

      // ファイルが削除されることを確認
      expect(mockVault.delete).toHaveBeenCalledWith(taskFile)
      
      // saveDeletedInstancesが呼ばれることを確認
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-25',
        expect.arrayContaining([
          expect.objectContaining({
            deletionType: 'permanent'
          })
        ])
      )
      
      // 1月26日の動作をシミュレート
      view.currentDate = new Date(2024, 0, 26)
      plugin.getCurrentDateString.mockReturnValue('2024-01-26')
      
      // getDeletedInstancesを設定して永続削除を返す
      view.getDeletedInstances.mockReturnValue([{
        path: taskFile.path,
        instanceId: 'test-instance-1',
        deletionType: 'permanent',
        deletedAt: new Date().toISOString()
      }])
      
      // isInstanceDeleted メソッドで削除済みと判定されることを確認
      const isDeleted = view.isInstanceDeleted(
        'test-instance-1',
        taskFile.path,
        '2024-01-26'
      )
      expect(isDeleted).toBe(true)
    })
  })
})