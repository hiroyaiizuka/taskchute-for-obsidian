const { TaskChuteView, DailyTaskAggregator } = require('../main')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  TFolder: jest.fn(),
  Notice: jest.fn(),
  PluginSettingTab: jest.fn(),
  Setting: jest.fn(),
  normalizePath: jest.fn(path => path)
}))

const { TFile } = require('obsidian')
const { mockApp, mockLeaf } = require('../__mocks__/obsidian')

// DailyTaskAggregatorをモック
jest.mock('../main', () => {
  const originalModule = jest.requireActual('../main')
  return {
    ...originalModule,
    DailyTaskAggregator: jest.fn().mockImplementation(() => ({
      updateDailyStats: jest.fn().mockResolvedValue()
    }))
  }
})

describe('ルーチンタスクのリネームと複製によるバグ', () => {
  let taskChuteView
  let mockPlugin
  
  beforeEach(() => {
    // モックリセット
    jest.clearAllMocks()
    
    // localStorage のモック（TaskChuteViewのコンストラクタより前に設定）
    global.localStorage = {
      data: {},
      getItem: jest.fn(key => global.localStorage.data[key] || null),
      setItem: jest.fn((key, value) => { global.localStorage.data[key] = value }),
      removeItem: jest.fn(key => { delete global.localStorage.data[key] }),
      clear: jest.fn(() => { global.localStorage.data = {} }),
      key: jest.fn(index => Object.keys(global.localStorage.data)[index] || null),
      get length() { return Object.keys(global.localStorage.data).length }
    }
    
    // モックプラグイン
    mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      },
      routineAliasManager: {
        loadAliases: jest.fn().mockResolvedValue({}),
        saveAliases: jest.fn().mockResolvedValue(),
        addAlias: jest.fn().mockResolvedValue(),
        getAliases: jest.fn().mockReturnValue([]),
        findCurrentName: jest.fn().mockReturnValue(null)
      },
      settings: {
        enableCelebration: false
      }
    }
    
    // モックAppオブジェクトを作成
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn(),
          list: jest.fn()
        }
      },
      metadataCache: {
        getFileCache: jest.fn()
      },
      fileManager: {
        processFrontMatter: jest.fn()
      }
    }
    
    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = app
    taskChuteView.plugin = mockPlugin
    taskChuteView.currentDate = new Date(2024, 0, 15) // 2024-01-15
    
    // generateInstanceIdメソッドをモック
    let instanceCounter = 0
    taskChuteView.generateInstanceId = jest.fn(() => {
      instanceCounter++
      return `test-instance-${instanceCounter}`
    })
    
    // getCurrentDateStringメソッドをモック
    taskChuteView.getCurrentDateString = jest.fn(() => '2024-01-15')
    
    // DOM要素のモック
    const mockContainer = document.createElement('div')
    const mockTaskList = document.createElement('div')
    mockContainer.appendChild(mockTaskList)
    taskChuteView.containerEl = mockContainer
    taskChuteView.taskList = mockTaskList
  })
  
  afterEach(() => {
    delete global.localStorage
  })
  
  test('実行ログのタスク名が変更されないことを確認', async () => {
    // 実行ログファイルを準備
    const monthlyLog = {
      metadata: { version: '2.0', month: '2024-01' },
      taskExecutions: {
        '2024-01-15': [
          {
            taskId: 'TaskChute/Task/古い名前.md',
            taskName: '古い名前',
            instanceId: 'test-instance-1',
            isCompleted: true
          }
        ]
      }
    }
    
    taskChuteView.app.vault.getAbstractFileByPath = jest.fn().mockResolvedValue(true)
    taskChuteView.app.vault.adapter.list = jest.fn().mockResolvedValue({
      files: ['TaskChute/Log/2024-01-tasks.json']
    })
    taskChuteView.app.vault.adapter.read = jest.fn().mockResolvedValue(JSON.stringify(monthlyLog))
    taskChuteView.app.vault.adapter.write = jest.fn().mockResolvedValue()
    
    // ファイルリネームイベントが発生しても、実行ログは変更されないことを確認
    // （updateTaskNameInLogsメソッドが削除されたため）
    
    // ファイルリネーム後も実行ログが変更されていないことを確認
    const logContent = await taskChuteView.app.vault.adapter.read('TaskChute/Log/2024-01-tasks.json')
    const log = JSON.parse(logContent)
    
    expect(log.taskExecutions['2024-01-15'][0].taskName).toBe('古い名前')
    expect(log.taskExecutions['2024-01-15'][0].taskId).toBe('TaskChute/Task/古い名前.md')
  })
  
  test('複製情報の削除が正しく動作する', async () => {
    // 複製情報を設定
    const duplicatedInstances = [
      { path: 'TaskChute/Task/タスク.md', instanceId: 'instance-1' },
      { path: 'TaskChute/Task/タスク.md', instanceId: 'instance-2' }
    ]
    localStorage.setItem('taskchute-duplicated-instances-2024-01-15', JSON.stringify(duplicatedInstances))
    
    // タスクインスタンスを作成
    const instance = {
      task: { title: 'タスク', path: 'TaskChute/Task/タスク.md' },
      state: 'running',
      instanceId: 'instance-1',
      slotKey: '8:00-12:00'
    }
    
    // Mock DailyTaskAggregator and saveTaskCompletion
    taskChuteView.saveTaskCompletion = jest.fn().mockResolvedValue()
    taskChuteView.getTaskRecordDateString = jest.fn().mockReturnValue('2024-01-15')
    
    // stopInstanceを実行
    await taskChuteView.stopInstance(instance)
    
    // 複製情報が削除されたことを確認
    const remaining = JSON.parse(localStorage.getItem('taskchute-duplicated-instances-2024-01-15') || '[]')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].instanceId).toBe('instance-2')
  })
})