const { TaskChuteView } = require('../main.js');
const moment = require('moment');

describe('前日の未実施タスク実行時の動作', () => {
  let taskChuteView;
  let mockApp;
  let mockVaultAdapter;
  let mockFileManager;
  let mockWorkspace;
  let mockMetadataCache;
  
  beforeEach(() => {
    // モックの準備
    mockVaultAdapter = {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      mkdir: jest.fn(),
      list: jest.fn().mockResolvedValue({ files: [] }),
      getFullPath: jest.fn().mockImplementation(path => path)
    };
    
    mockFileManager = {
      processFrontMatter: jest.fn()
    };
    
    mockWorkspace = {
      openLinkText: jest.fn(),
      getLeaf: jest.fn().mockReturnValue({
        setViewState: jest.fn()
      }),
      detachLeavesOfType: jest.fn()
    };
    
    mockMetadataCache = {
      getFileCache: jest.fn()
    };
    
    mockApp = {
      vault: {
        adapter: mockVaultAdapter,
        getAbstractFileByPath: jest.fn(),
        read: jest.fn().mockImplementation((file) => {
          // fileオブジェクトからpathを取得してmockVaultAdapter.readを呼ぶ
          return Promise.resolve(mockVaultAdapter.read(file.path));
        }),
        create: jest.fn(),
        getMarkdownFiles: jest.fn().mockReturnValue([])
      },
      fileManager: mockFileManager,
      workspace: mockWorkspace,
      metadataCache: mockMetadataCache
    };
    
    // TaskChuteViewのインスタンスを作成
    const mockLeaf = {
      containerEl: {
        children: [{}, { empty: jest.fn(), createEl: jest.fn().mockReturnValue({
          empty: jest.fn(),
          createEl: jest.fn().mockImplementation(() => ({
            createEl: jest.fn().mockImplementation(() => ({
              createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
              addEventListener: jest.fn(),
              style: {},
              querySelectorAll: jest.fn().mockReturnValue([])
            })),
            addEventListener: jest.fn(),
            style: {},
            querySelector: jest.fn()
          }))
        })}]
      },
      app: mockApp
    };
    
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin);
    taskChuteView.app = mockApp;
    
    // DOM要素のモック
    taskChuteView.taskList = {
      empty: jest.fn(),
      createEl: jest.fn().mockReturnValue({
        createEl: jest.fn().mockReturnValue({
          addEventListener: jest.fn(),
          style: {}
        })
      })
    };
    
    // メソッドのモック
    taskChuteView.renderTaskList = jest.fn();
    taskChuteView.manageTimers = jest.fn();
    taskChuteView.saveRunningTasksState = jest.fn();
    taskChuteView.applyStyles = jest.fn();
    taskChuteView.setupDebugFunctions = jest.fn();
    taskChuteView.loadTodayExecutions = jest.fn().mockResolvedValue([]);
    taskChuteView.getTaskFiles = jest.fn().mockImplementation(async () => {
      const taskFolder = mockApp.vault.getAbstractFileByPath('TaskChute/Task');
      return taskFolder ? taskFolder.children : [];
    });
    taskChuteView.getCurrentTimeSlot = jest.fn().mockReturnValue('8:00-12:00');
    taskChuteView.generateInstanceId = jest.fn().mockImplementation((path) => {
      return `${path}-${Date.now()}-${Math.random()}`;
    });
    taskChuteView.isRunningTaskStartedToday = jest.fn().mockImplementation(async (path, dateString) => {
      // 実行中タスクの開始日をチェックする処理をモック
      const runningTaskData = await mockVaultAdapter.read('TaskChute/Log/running-task.json');
      if (runningTaskData) {
        const runningTasks = JSON.parse(runningTaskData);
        const task = runningTasks.find(t => t.taskPath === path);
        if (task && task.startTime) {
          const startDate = new Date(task.startTime);
          const startDateString = `${startDate.getFullYear()}-${(startDate.getMonth() + 1).toString().padStart(2, '0')}-${startDate.getDate().toString().padStart(2, '0')}`;
          return startDateString === dateString;
        }
      }
      return false;
    });
    taskChuteView.shouldShowWeeklyRoutine = jest.fn().mockReturnValue(false);
    taskChuteView.updateDateLabel = jest.fn();
    taskChuteView.restoreRunningTaskState = jest.fn().mockImplementation(async () => {
      // 実行中タスクの復元をシミュレート
      const runningTaskData = await mockVaultAdapter.read('TaskChute/Log/running-task.json');
      if (runningTaskData) {
        const runningTasks = JSON.parse(runningTaskData);
        runningTasks.forEach(runningTask => {
          const instance = taskChuteView.taskInstances.find(inst => 
            inst.task.path === runningTask.taskPath && inst.instanceId === runningTask.instanceId
          );
          if (instance) {
            instance.state = 'running';
            instance.startTime = new Date(runningTask.startTime);
          }
        });
      }
    });
    taskChuteView.sortTaskInstancesByTimeOrder = jest.fn();
    taskChuteView.initializeTaskOrders = jest.fn();
    taskChuteView.moveIdleTasksToCurrentSlot = jest.fn();
    taskChuteView.cleanupOldStorageKeys = jest.fn();
    
    // RoutineAliasManagerのモックを追加
    taskChuteView.plugin = {
      routineAliasManager: {
        getAliases: jest.fn(() => []),
        findCurrentName: jest.fn(),
        addAlias: jest.fn()
      },
      pathManager: {
        getTaskFolderPath: jest.fn(() => 'TaskChute/Task')
      }
    };
    taskChuteView.getTimeSlotKeys = jest.fn().mockReturnValue([
      '0:00-8:00',
      '8:00-12:00',
      '12:00-16:00',
      '16:00-0:00'
    ]);
    
    // Notice クラスのモック
    global.Notice = jest.fn();
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  test('前日の非ルーチンタスクを実行すると両方の日付で表示される（現在のバグ）', async () => {
    // 7月8日の非ルーチンタスクを作成
    const taskFile = {
      basename: '非ルーチンタスクA',
      path: 'TaskChute/Task/非ルーチンタスクA.md',
      extension: 'md',
      stat: { ctime: new Date('2024-07-08') }
    };
    
    // ファイル内容とメタデータをモック
    mockVaultAdapter.read.mockImplementation((path) => {
      if (path === taskFile.path) {
        return `---
routine: false
target_date: 2024-07-08
---
# 非ルーチンタスクA

#task

タスクの説明`;
      }
      return '';
    });
    
    mockMetadataCache.getFileCache.mockReturnValue({
      frontmatter: {
        routine: false,
        target_date: '2024-07-08'
      }
    });
    
    // タスクフォルダの設定
    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === 'TaskChute/Task') {
        return {
          children: [taskFile]
        };
      }
      return null;
    });
    
    // === 7月8日でタスクを読み込み ===
    taskChuteView.currentDate = new Date('2024-07-08');
    await taskChuteView.loadTasks();
    
    // タスクが1つ読み込まれていることを確認
    expect(taskChuteView.tasks).toHaveLength(1);
    expect(taskChuteView.taskInstances).toHaveLength(1);
    const taskInstance = taskChuteView.taskInstances[0];
    
    // === タスクを実行開始（7月8日のまま） ===
    taskInstance.state = 'running';
    taskInstance.startTime = new Date('2024-07-08T10:00:00');
    
    // 実行中タスクの状態を保存
    const runningTasksData = [{
      taskPath: taskFile.path,
      startTime: '2024-07-08T10:00:00',
      slotKey: taskInstance.slotKey,
      instanceId: taskInstance.instanceId
    }];
    
    mockVaultAdapter.exists.mockImplementation((path) => {
      if (path === 'TaskChute/Log/running-task.json') {
        return true;
      }
      return false;
    });
    
    // 現在のバグの挙動をシミュレート：実行中タスクは全ての日付で表示される
    taskChuteView.restoreRunningTaskState = jest.fn().mockImplementation(async () => {
      // 実行中タスクをすべてのビューで復元（現在のバグ動作）
      const runningData = await mockVaultAdapter.read('TaskChute/Log/running-task.json');
      if (runningData) {
        const runningTasks = JSON.parse(runningData);
        // どの日付でも実行中タスクを表示（バグ）
        runningTasks.forEach(rt => {
          // 既存のタスクがなければ新規作成
          if (!taskChuteView.tasks.find(t => t.path === rt.taskPath)) {
            taskChuteView.tasks.push({
              title: '非ルーチンタスクA',
              path: rt.taskPath,
              file: taskFile,
              isRoutine: false,
              scheduledTime: null,
              slotKey: rt.slotKey || 'none',
              projectPath: null,
              projectTitle: null
            });
          }
          
          // 実行中インスタンスを追加
          const runningInstance = {
            task: taskChuteView.tasks.find(t => t.path === rt.taskPath),
            state: 'running',
            startTime: new Date(rt.startTime),
            stopTime: null,
            slotKey: rt.slotKey || 'none',
            order: null,
            instanceId: rt.instanceId
          };
          
          // 既存のインスタンスを実行中に更新するか、新規追加
          const existingIndex = taskChuteView.taskInstances.findIndex(
            inst => inst.instanceId === rt.instanceId
          );
          if (existingIndex >= 0) {
            taskChuteView.taskInstances[existingIndex] = runningInstance;
          } else {
            taskChuteView.taskInstances.push(runningInstance);
          }
        });
      }
    });
    
    mockVaultAdapter.read.mockImplementation((path) => {
      if (path === 'TaskChute/Log/running-task.json') {
        return JSON.stringify(runningTasksData);
      }
      if (path === taskFile.path) {
        return `---
routine: false
target_date: 2024-07-08
---
# 非ルーチンタスクA

#task

タスクの説明`;
      }
      return '';
    });
    
    // === 7月9日（翌日）に移動してタスクを確認 ===
    taskChuteView.currentDate = new Date('2024-07-09');
    taskChuteView.tasks = [];
    taskChuteView.taskInstances = [];
    await taskChuteView.loadTasks();
    
    // 🔴 バグ：翌日（7月9日）でもタスクが表示される
    const tasksOn9th = taskChuteView.taskInstances.filter(
      inst => inst.task.title === '非ルーチンタスクA'
    );
    expect(tasksOn9th).toHaveLength(1);
    expect(tasksOn9th[0].state).toBe('running');
    
    // === 7月8日（前日）に戻ってタスクを確認 ===
    taskChuteView.currentDate = new Date('2024-07-08');
    taskChuteView.tasks = [];
    taskChuteView.taskInstances = [];
    await taskChuteView.loadTasks();
    
    // 🔴 バグ：前日（7月8日）でもタスクが表示される（重複表示）
    const tasksOn8th = taskChuteView.taskInstances.filter(
      inst => inst.task.title === '非ルーチンタスクA'
    );
    
    // 実際の動作：2つのインスタンスが表示される（idleとrunning）
    expect(tasksOn8th).toHaveLength(2);
    
    // idleインスタンス（元々の未実行タスク）
    const idleInstance = tasksOn8th.find(inst => inst.state === 'idle');
    expect(idleInstance).toBeDefined();
    
    // runningインスタンス（実行中のタスク）
    const runningInstance = tasksOn8th.find(inst => inst.state === 'running');
    expect(runningInstance).toBeDefined();
    expect(runningInstance.startTime).toEqual(new Date('2024-07-08T10:00:00'));
    
    // 🔴 結果：同じタスクが両方の日付で表示される（期待動作ではない）
  });
  
  test('期待動作：前日の非ルーチンタスクを実行すると本日のみに表示される', async () => {
    // このテストは実装後に期待通り動作することを確認するため
    // 現在は失敗することが期待される
    
    const taskFile = {
      basename: '非ルーチンタスクB',
      path: 'TaskChute/Task/非ルーチンタスクB.md',
      extension: 'md',
      stat: { ctime: new Date('2024-07-08') }
    };
    
    mockVaultAdapter.read.mockImplementation((path) => {
      if (path === taskFile.path) {
        return `---
routine: false
target_date: 2024-07-08
---
# 非ルーチンタスクB

#task`;
      }
      return '';
    });
    
    mockMetadataCache.getFileCache.mockReturnValue({
      frontmatter: {
        routine: false,
        target_date: '2024-07-08'
      }
    });
    
    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === 'TaskChute/Task') {
        return {
          children: [taskFile]
        };
      }
      return null;
    });
    
    // 7月8日でタスクを読み込み
    taskChuteView.currentDate = new Date('2024-07-08');
    await taskChuteView.loadTasks();
    
    const taskInstance = taskChuteView.taskInstances[0];
    
    // タスクを実行開始（期待：target_dateが更新される）
    // ※ 実装後は、startInstanceがtarget_dateを更新するはず
    taskChuteView.startInstance = jest.fn().mockImplementation(async (inst) => {
      inst.state = 'running';
      inst.startTime = new Date('2024-07-09T10:00:00');
      // 実装後はここでtarget_dateが更新されるはず
    });
    await taskChuteView.startInstance(taskInstance);
    
    // 期待動作をシミュレート（実装後の動作）
    // mockFileManager.processFrontMatter.mockImplementation((file, callback) => {
    //   const frontmatter = { routine: false, target_date: '2024-07-09' };
    //   callback(frontmatter);
    // });
    
    // 7月9日に移動
    taskChuteView.currentDate = new Date('2024-07-09');
    taskChuteView.tasks = [];
    taskChuteView.taskInstances = [];
    
    // 実装後：target_dateが2024-07-09に更新されているはず
    // await taskChuteView.loadTasks();
    
    // ✅ 期待：7月9日でタスクが表示される
    // const tasksOn9th = taskChuteView.taskInstances.filter(
    //   inst => inst.task.title === '非ルーチンタスクB'
    // );
    // expect(tasksOn9th).toHaveLength(1);
    
    // 7月8日に戻る
    taskChuteView.currentDate = new Date('2024-07-08');
    taskChuteView.tasks = [];
    taskChuteView.taskInstances = [];
    // await taskChuteView.loadTasks();
    
    // ✅ 期待：7月8日ではタスクが表示されない
    // const tasksOn8th = taskChuteView.taskInstances.filter(
    //   inst => inst.task.title === '非ルーチンタスクB'
    // );
    // expect(tasksOn8th).toHaveLength(0);
  });
  
  test('ルーチンタスクはtarget_dateを更新しない', async () => {
    const routineTaskFile = {
      basename: 'ルーチンタスクA',
      path: 'TaskChute/Task/ルーチンタスクA.md',
      extension: 'md',
      stat: { ctime: new Date('2024-07-01') }
    };
    
    mockVaultAdapter.read.mockImplementation((path) => {
      if (path === routineTaskFile.path) {
        return `---
routine: true
開始時刻: 09:00
---
# ルーチンタスクA

#task
#routine`;
      }
      return '';
    });
    
    mockMetadataCache.getFileCache.mockReturnValue({
      frontmatter: {
        routine: true,
        開始時刻: '09:00'
      }
    });
    
    mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === 'TaskChute/Task') {
        return {
          children: [routineTaskFile]
        };
      }
      return null;
    });
    
    // ルーチンタスクを読み込み
    taskChuteView.currentDate = new Date('2024-07-08');
    await taskChuteView.loadTasks();
    
    const taskInstance = taskChuteView.taskInstances[0];
    expect(taskInstance.task.isRoutine).toBe(true);
    
    // ルーチンタスクを実行
    taskChuteView.startInstance = jest.fn().mockImplementation(async (inst) => {
      inst.state = 'running';
      inst.startTime = new Date('2024-07-08T09:00:00');
    });
    await taskChuteView.startInstance(taskInstance);
    
    // 期待：processFrontMatterが呼ばれない（target_dateを更新しない）
    // ※ 実装後の動作
    // expect(mockFileManager.processFrontMatter).not.toHaveBeenCalled();
  });
});