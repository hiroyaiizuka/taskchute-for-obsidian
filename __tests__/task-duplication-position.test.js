const TaskChutePlusPlugin = require('../main')
const { TaskChuteView } = require('../main')
const { Notice } = require('../__mocks__/obsidian')

describe('タスク複製時の配置位置', () => {
  let plugin
  let mockApp
  let view

  beforeEach(() => {
    // モックのワークスペースとメタデータキャッシュを作成
    const mockWorkspace = {
      openLinkText: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      containerEl: {
        ownerDocument: document,
      },
      leaves: [],
      getActiveViewOfType: jest.fn(),
      getLeavesOfType: jest.fn().mockReturnValue([]),
      getRightLeaf: jest.fn(),
    }

    mockApp = {
      workspace: mockWorkspace,
      vault: {
        read: jest.fn(),
        modify: jest.fn(),
        process: jest.fn(),
        delete: jest.fn(),
        getAbstractFileByPath: jest.fn(),
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(),
          mkdir: jest.fn().mockResolvedValue(),
        },
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue(null),
        on: jest.fn(),
        off: jest.fn(),
      },
      fileManager: {
        processFrontMatter: jest.fn(),
      },
      commands: {
        executeCommandById: jest.fn(),
      },
    }

    plugin = new TaskChutePlusPlugin()
    plugin.app = mockApp
    plugin.manifest = { dir: '/' }

    // ビューをモック
    view = plugin.app.workspace.getActiveViewOfType()
    if (!view) {
      view = {
        leaf: {},
        containerEl: document.createElement('div'),
        taskInstances: [],
        tasks: [],
        currentDate: new Date(),
        useOrderBasedSort: true,
        navigationState: { isVisible: false },
        selectedTaskInstance: null,
      }
      
      // 必要なメソッドをビューに追加
      view.duplicateInstance = TaskChuteView.prototype.duplicateInstance.bind(view)
      view.calculateDuplicateTaskOrder = TaskChuteView.prototype.calculateDuplicateTaskOrder.bind(view)
      view.normalizeOrdersInSlot = TaskChuteView.prototype.normalizeOrdersInSlot.bind(view)
      view.saveTaskOrders = jest.fn()
      view.renderTaskList = jest.fn()
      view.sortTaskInstancesByTimeOrder = jest.fn()
      view.generateInstanceId = jest.fn(() => `instance-${Date.now()}-${Math.random()}`)
      view.getCurrentDateString = jest.fn(() => '2025-01-22')
      view.updateDailySummaryTaskCount = jest.fn()
    }

    // localStorage のモック
    const localStorageMock = {
      getItem: jest.fn().mockReturnValue('[]'),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    }
    global.localStorage = localStorageMock

    // Notice のモック
    global.Notice = Notice
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('複製タスクが元タスクの直下に配置される（基本ケース）', async () => {
    // テストデータの準備
    const task1 = { title: 'タスク1', path: 'task1.md' }
    const task2 = { title: 'タスク2', path: 'task2.md' }
    const task3 = { title: 'タスク3', path: 'task3.md' }

    const inst1 = { task: task1, slotKey: '8:00-12:00', order: 100, state: 'idle' }
    const inst2 = { task: task2, slotKey: '8:00-12:00', order: 200, state: 'idle' }
    const inst3 = { task: task3, slotKey: '8:00-12:00', order: 300, state: 'idle' }

    view.taskInstances = [inst1, inst2, inst3]

    // タスク2を複製
    await view.duplicateInstance(inst2)

    // 検証
    expect(view.taskInstances.length).toBe(4)
    
    // 新しいインスタンスを見つける
    const newInstance = view.taskInstances.find(inst => 
      inst.task === task2 && inst !== inst2
    )
    
    expect(newInstance).toBeDefined()
    expect(newInstance.order).toBe(250) // 200と300の間
    expect(newInstance.slotKey).toBe('8:00-12:00')
    expect(newInstance.state).toBe('idle')
  })

  test('時間帯の最後のタスクを複製した場合', async () => {
    const task1 = { title: 'タスク1', path: 'task1.md' }
    const task2 = { title: 'タスク2', path: 'task2.md' }

    const inst1 = { task: task1, slotKey: '8:00-12:00', order: 100, state: 'idle' }
    const inst2 = { task: task2, slotKey: '8:00-12:00', order: 200, state: 'idle' }

    view.taskInstances = [inst1, inst2]

    // 最後のタスクを複製
    await view.duplicateInstance(inst2)

    // 検証
    expect(view.taskInstances.length).toBe(3)
    
    const newInstance = view.taskInstances.find(inst => 
      inst.task === task2 && inst !== inst2
    )
    
    expect(newInstance).toBeDefined()
    expect(newInstance.order).toBe(300) // 最後のタスクの順序番号 + 100
  })

  test('順序番号の隙間がない場合の処理', async () => {
    const task1 = { title: 'タスク1', path: 'task1.md' }
    const task2 = { title: 'タスク2', path: 'task2.md' }
    const task3 = { title: 'タスク3', path: 'task3.md' }

    const inst1 = { task: task1, slotKey: '8:00-12:00', order: 100, state: 'idle' }
    const inst2 = { task: task2, slotKey: '8:00-12:00', order: 101, state: 'idle' } // 隙間が1しかない
    const inst3 = { task: task3, slotKey: '8:00-12:00', order: 102, state: 'idle' }

    view.taskInstances = [inst1, inst2, inst3]

    // タスク2を複製
    await view.duplicateInstance(inst2)

    // 正規化が実行されたことを確認
    expect(inst1.order).toBe(100)
    expect(inst2.order).toBe(200)
    expect(inst3.order).toBe(300)

    // 新しいインスタンスの順序番号を確認
    const newInstance = view.taskInstances.find(inst => 
      inst.task === task2 && inst !== inst2
    )
    
    expect(newInstance.order).toBe(250) // 正規化後の値
  })

  test('異なる時間帯のタスクは影響を受けない', async () => {
    const task1 = { title: 'タスク1', path: 'task1.md' }
    const task2 = { title: 'タスク2', path: 'task2.md' }
    const task3 = { title: 'タスク3', path: 'task3.md' }

    const inst1 = { task: task1, slotKey: '8:00-12:00', order: 100, state: 'idle' }
    const inst2 = { task: task2, slotKey: '8:00-12:00', order: 200, state: 'idle' }
    const inst3 = { task: task3, slotKey: '12:00-16:00', order: 100, state: 'idle' } // 異なる時間帯

    view.taskInstances = [inst1, inst2, inst3]

    // タスク1を複製
    await view.duplicateInstance(inst1)

    // 異なる時間帯のタスクの順序番号が変わっていないことを確認
    expect(inst3.order).toBe(100)
  })

  test('複製情報が正しく処理される', async () => {
    const task1 = { title: 'タスク1', path: 'task1.md' }
    const inst1 = { task: task1, slotKey: '8:00-12:00', order: 100, state: 'idle' }

    view.taskInstances = [inst1]
    
    // 新しいインスタンスの数を確認する前の状態
    const initialCount = view.taskInstances.length

    // タスクを複製
    await view.duplicateInstance(inst1)

    // 新しいインスタンスが追加されたことを確認
    expect(view.taskInstances.length).toBe(initialCount + 1)
    
    // 新しいインスタンスを探す
    const newInstance = view.taskInstances.find(inst => 
      inst.task === task1 && inst !== inst1
    )
    
    expect(newInstance).toBeDefined()
    expect(newInstance.instanceId).toBeDefined()
    expect(newInstance.task.path).toBe('task1.md')
  })

  test('完了通知が表示される', async () => {
    const task1 = { title: 'タスク1', path: 'task1.md' }
    const inst1 = { task: task1, slotKey: '8:00-12:00', order: 100, state: 'idle' }

    view.taskInstances = [inst1]

    // Notice のスパイをリセット
    global.Notice.mockClear()

    // タスクを複製
    await view.duplicateInstance(inst1)

    // renderTaskListが呼ばれたことを確認
    expect(view.renderTaskList).toHaveBeenCalled()

    // 通知が表示されたことを確認
    expect(global.Notice).toHaveBeenCalledWith('「タスク1」を複製しました。')
  })
})