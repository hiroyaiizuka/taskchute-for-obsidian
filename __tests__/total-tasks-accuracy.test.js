const { TaskChuteView } = require('../main.js');

describe('totalTasks計算の正確性', () => {
  let view;
  let mockApp;
  let mockPlugin;

  beforeEach(() => {
    // モックの準備
    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        createFolder: jest.fn(),
        adapter: {
          stat: jest.fn()
        }
      },
      metadataCache: {
        getFileCache: jest.fn()
      },
      workspace: {
        getLeaf: jest.fn(),
        setActiveLeaf: jest.fn(),
        splitActiveLeaf: jest.fn(),
        createLeafBySplit: jest.fn()
      }
    };

    mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn(() => 'Task'),
        getProjectFolderPath: jest.fn(() => 'Project'),
        getLogDataPath: jest.fn(() => 'Log')
      },
      routineAliasManager: {
        loadAliases: jest.fn(),
        getAllPossibleNames: jest.fn((name) => [name])
      }
    };

    const mockLeaf = {
      view: {},
      rebuildView: jest.fn()
    };

    view = new TaskChuteView(mockLeaf);
    view.app = mockApp;
    view.plugin = mockPlugin;
    view.currentDate = new Date('2025-08-19');
    view.taskInstances = [];
    view.taskList = {
      empty: jest.fn(),
      createEl: jest.fn(),
      scrollTop: 0,
      scrollLeft: 0
    };
    // getTaskRecordDateメソッドを追加
    view.getTaskRecordDate = jest.fn(() => new Date('2025-08-19'));
    view.getTaskRecordDateString = jest.fn(() => '2025-08-19');
  });

  describe('saveTaskCompletionでのtotalTasks計算', () => {
    it('taskInstances.lengthを使用してtotalTasksをカウントする', async () => {
      // 表示タスクをセットアップ
      view.taskInstances = [
        { task: { title: 'タスク1' }, state: 'done' },
        { task: { title: 'タスク2' }, state: 'idle' },
        { task: { title: 'タスク3' }, state: 'done' },
        { task: { title: 'タスク4' }, state: 'idle' },
        { task: { title: 'タスク5' }, state: 'running' }
      ];

      // 既存のログファイルをモック
      const existingLog = {
        metadata: {
          month: '2025-08',
          lastUpdated: '2025-08-19T00:00:00.000Z',
          activeDays: 1,
          totalDays: 31
        },
        taskExecutions: {
          '2025-08-19': []
        },
        dailySummary: {}
      };

      mockApp.vault.getAbstractFileByPath.mockReturnValue({
        path: 'Log/2025-08-tasks.json'
      });
      mockApp.vault.read.mockResolvedValue(JSON.stringify(existingLog));

      let savedContent = null;
      mockApp.vault.modify.mockImplementation((file, content) => {
        savedContent = content;
        return Promise.resolve();
      });

      // タスクを保存
      const inst = {
        task: {
          path: 'Task/タスク1.md',
          title: 'タスク1'
        },
        startTime: new Date('2025-08-19T10:00:00'),
        stopTime: new Date('2025-08-19T10:30:00'),
        state: 'done'
      };

      try {
        await view.saveTaskCompletion(inst, null);
      } catch (error) {
        console.error('saveTaskCompletion error:', error);
      }

      // 保存されたデータを確認
      if (!savedContent) {
        console.log('savedContent is null');
        console.log('modify calls:', mockApp.vault.modify.mock.calls.length);
        console.log('create calls:', mockApp.vault.create.mock.calls.length);
        // createメソッドを確認
        if (mockApp.vault.create.mock.calls.length > 0) {
          savedContent = mockApp.vault.create.mock.calls[0][1];
        }
      }
      const saved = savedContent ? JSON.parse(savedContent) : null;
      
      // totalTasksがtaskInstances.length（5）と一致することを確認
      expect(saved.dailySummary['2025-08-19'].totalTasks).toBe(5);
    });

    it('複製タスクも正しくカウントされる', async () => {
      // 同じタスクの複数インスタンスを含む
      view.taskInstances = [
        { task: { title: 'ルーチンタスク', path: 'Task/ルーチン.md' }, state: 'done' },
        { task: { title: 'タスクA', path: 'Task/タスクA.md' }, state: 'done' },
        { task: { title: 'タスクA', path: 'Task/タスクA.md' }, state: 'idle', instanceId: 'dup1' }, // 複製
        { task: { title: 'タスクB', path: 'Task/タスクB.md' }, state: 'idle' }
      ];

      const existingLog = {
        metadata: { month: '2025-08' },
        taskExecutions: { '2025-08-19': [] },
        dailySummary: {}
      };

      mockApp.vault.getAbstractFileByPath.mockReturnValue({ path: 'Log/2025-08-tasks.json' });
      mockApp.vault.read.mockResolvedValue(JSON.stringify(existingLog));

      let savedContent = null;
      mockApp.vault.modify.mockImplementation((file, content) => {
        savedContent = content;
        return Promise.resolve();
      });
      mockApp.vault.create.mockImplementation((path, content) => {
        savedContent = content;
        return Promise.resolve();
      });

      const inst = view.taskInstances[0];
      await view.saveTaskCompletion(inst, null);

      if (!savedContent && mockApp.vault.create.mock.calls.length > 0) {
        savedContent = mockApp.vault.create.mock.calls[0][1];
      }
      const saved = savedContent ? JSON.parse(savedContent) : null;
      
      // 複製を含めて4個のタスクがカウントされる
      expect(saved.dailySummary['2025-08-19'].totalTasks).toBe(4);
    });

    it('未実行タスクも含めて正しくカウントされる', async () => {
      // 実行済みと未実行のミックス
      view.taskInstances = [
        { task: { title: 'タスク1' }, state: 'done' },
        { task: { title: 'タスク2' }, state: 'done' },
        { task: { title: 'タスク3' }, state: 'done' },
        { task: { title: 'タスク4' }, state: 'idle' }, // 未実行
        { task: { title: 'タスク5' }, state: 'idle' }, // 未実行
        { task: { title: 'タスク6' }, state: 'idle' }  // 未実行
      ];

      const existingLog = {
        metadata: { month: '2025-08' },
        taskExecutions: { '2025-08-19': [] },
        dailySummary: {}
      };

      mockApp.vault.getAbstractFileByPath.mockReturnValue({ path: 'Log/2025-08-tasks.json' });
      mockApp.vault.read.mockResolvedValue(JSON.stringify(existingLog));

      let savedContent = null;
      mockApp.vault.modify.mockImplementation((file, content) => {
        savedContent = content;
        return Promise.resolve();
      });
      mockApp.vault.create.mockImplementation((path, content) => {
        savedContent = content;
        return Promise.resolve();
      });

      const inst = view.taskInstances[0];
      await view.saveTaskCompletion(inst, null);

      if (!savedContent && mockApp.vault.create.mock.calls.length > 0) {
        savedContent = mockApp.vault.create.mock.calls[0][1];
      }
      const saved = savedContent ? JSON.parse(savedContent) : null;
      
      // 全6個のタスクがカウントされる（実行済み3個 + 未実行3個）
      expect(saved.dailySummary['2025-08-19'].totalTasks).toBe(6);
      // タスクは既にdone状態なので、completedTasksは更新されない（既存の0のまま）
      expect(saved.dailySummary['2025-08-19'].completedTasks).toBe(0);
    });
  });

  describe('recalculateYesterdayDailySummaryの無効化', () => {
    it('loadTasksでrecalculateYesterdayDailySummaryがスキップされる', async () => {
      // recalculateYesterdayDailySummaryをモック
      view.recalculateYesterdayDailySummary = jest.fn();

      // タスクファイルのモック
      const mockFolder = {
        children: [
          { path: 'Task/タスク1.md', name: 'タスク1.md' }
        ]
      };
      mockApp.vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'Task') return mockFolder;
        if (path === 'Task/タスク1.md') return { path: 'Task/タスク1.md', basename: 'タスク1' };
        return null;
      });

      mockApp.vault.read.mockImplementation((file) => {
        if (file.path === 'Task/タスク1.md') {
          return Promise.resolve('---\nroutine: false\n---\n#task');
        }
        return Promise.resolve('{}');
      });

      mockApp.metadataCache.getFileCache.mockReturnValue({
        frontmatter: { routine: false }
      });

      // getTimeSlotsKeysなどの必要なメソッドを追加
      view.getTimeSlotKeys = jest.fn(() => ['0:00-8:00', '8:00-12:00', '12:00-16:00', '16:00-0:00']);
      view.sortTaskInstancesByTimeOrder = jest.fn();
      view.applyResponsiveClasses = jest.fn();
      view.initializeTaskOrders = jest.fn();
      view.moveIdleTasksToCurrentSlot = jest.fn();
      view.renderTaskList = jest.fn();
      view.cleanupOldStorageKeys = jest.fn();
      view.getTaskFiles = jest.fn(() => Promise.resolve([]));
      view.loadTodayExecutions = jest.fn(() => Promise.resolve([]));
      view.getDeletedInstances = jest.fn(() => []);
      view.getHiddenRoutines = jest.fn(() => []);
      view.restoreRunningTaskState = jest.fn();
      view.saveRunningTasksState = jest.fn();
      view.useOrderBasedSort = false;

      await view.loadTasks();

      // recalculateYesterdayDailySummaryが呼ばれないことを確認
      expect(view.recalculateYesterdayDailySummary).not.toHaveBeenCalled();
    });
  });
});