const { Plugin, ItemView, WorkspaceLeaf, TFile, Notice } = require("obsidian")

// モック設定
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

// TaskChuteView クラスをインポート
const TaskChutePlusPlugin = require("../main.js")
const TaskChuteView = TaskChutePlusPlugin.TaskChuteView

describe('Deleted Tasks List Cleanup', () => {
  let view;
  let mockApp;
  let mockPlugin;
  let mockLocalStorage;
  let mockVault;
  let localStorageSetItemSpy;

  beforeEach(() => {
    // localStorage のモックをリセット
    mockLocalStorage = {};
    
    // localStorageモックを作成
    localStorageSetItemSpy = jest.fn((key, value) => { 
      mockLocalStorage[key] = value;
    });
    global.localStorage = {
      getItem: jest.fn((key) => mockLocalStorage[key] || null),
      setItem: localStorageSetItemSpy,
      removeItem: jest.fn((key) => {
        delete mockLocalStorage[key];
      }),
      clear: jest.fn(() => {
        Object.keys(mockLocalStorage).forEach(key => delete mockLocalStorage[key]);
      })
    };
    
    // Date mock for consistent testing
    const mockDate = new Date('2024-01-15');
    jest.spyOn(global, 'Date').mockImplementation(() => mockDate);

    // Vault のモック
    mockVault = {
      getAbstractFileByPath: jest.fn(),
      getFileByPath: jest.fn(),
      getFolderByPath: jest.fn(),
      adapter: {
        exists: jest.fn().mockResolvedValue(true),
        read: jest.fn().mockResolvedValue('[]'),
        write: jest.fn().mockResolvedValue()
      },
      read: jest.fn().mockResolvedValue('#task\nタスク内容'),
      getFiles: jest.fn().mockReturnValue([])
    };

    // App のモック
    mockApp = {
      vault: mockVault,
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {}
        })
      }
    };

    // Plugin のモック
    mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('Tasks'),
        getLogDataPath: jest.fn().mockReturnValue('Data/Log')
      },
      routineAliasManager: {
        getAliases: jest.fn().mockReturnValue([])
      }
    };

    // View の初期化
    const mockLeaf = {};
    view = new TaskChuteView(mockLeaf, mockPlugin);
    view.app = mockApp;
    view.plugin = mockPlugin;
    view.taskList = {
      empty: jest.fn()
    };
    view.getCurrentDateString = jest.fn().mockReturnValue('2024-01-15');
    view.loadSavedOrders = jest.fn().mockReturnValue({});
    view.loadTodayExecutions = jest.fn().mockResolvedValue([]);
    view.getTaskFiles = jest.fn().mockResolvedValue([]);
    view.getDeletedInstances = jest.fn().mockReturnValue([]);
    view.saveDeletedInstances = jest.fn();
    
    // タスクとインスタンスの初期化
    view.tasks = [];
    view.taskInstances = [];
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('loadTasksSimple の削除済みリストクリーンアップ', () => {
    test('削除済みリストが空の場合、何も処理しない', async () => {
      view.getDeletedInstances.mockReturnValue([]);
      
      await view.loadTasksSimple();
      
      expect(view.saveDeletedInstances).not.toHaveBeenCalled();
    });

    test('削除済みリストに存在するファイルのみが含まれる場合、更新しない', async () => {
      view.getDeletedInstances.mockReturnValue([
        { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskB.md', instanceId: 'b', deletionType: 'permanent', deletedAt: new Date().toISOString() }
      ]);
      
      // すべてのファイルが存在する
      mockVault.getFileByPath
        .mockReturnValueOnce({ path: 'Tasks/TaskA.md' })
        .mockReturnValueOnce({ path: 'Tasks/TaskB.md' });
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      await view.loadTasksSimple();
      
      expect(view.saveDeletedInstances).not.toHaveBeenCalled();
    });

    test('削除済みリストに存在しないファイルが含まれる場合、クリーンアップして更新', async () => {
      const deletedInstances = [
        { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskB.md', instanceId: 'b', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskC.md', instanceId: 'c', deletionType: 'permanent', deletedAt: new Date().toISOString() }
      ];
      view.getDeletedInstances.mockReturnValue(deletedInstances);
      
      // TaskAとTaskCは存在、TaskBは存在しない
      mockVault.getFileByPath
        .mockReturnValueOnce({ path: 'Tasks/TaskA.md' })
        .mockReturnValueOnce(null) // TaskB は存在しない
        .mockReturnValueOnce({ path: 'Tasks/TaskC.md' });
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      await view.loadTasksSimple();
      
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-15',
        [
          { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: expect.any(String) },
          { path: 'Tasks/TaskC.md', instanceId: 'c', deletionType: 'permanent', deletedAt: expect.any(String) }
        ]
      );
    });

    test('削除済みリストのすべてのファイルが存在しない場合、空リストに更新', async () => {
      const deletedInstances = [
        { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskB.md', instanceId: 'b', deletionType: 'permanent', deletedAt: new Date().toISOString() }
      ];
      view.getDeletedInstances.mockReturnValue(deletedInstances);
      
      // すべてのファイルが存在しない
      mockVault.getFileByPath
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null);
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      await view.loadTasksSimple();
      
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-15',
        []
      );
    });

    test('ファイル存在チェックでエラーが発生した場合、そのパスは除去される', async () => {
      const deletedInstances = [
        { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskB.md', instanceId: 'b', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskC.md', instanceId: 'c', deletionType: 'permanent', deletedAt: new Date().toISOString() }
      ];
      view.getDeletedInstances.mockReturnValue(deletedInstances);
      
      // TaskAは存在、TaskBはエラー、TaskCは存在
      mockVault.getFileByPath
        .mockReturnValueOnce({ path: 'Tasks/TaskA.md' })
        .mockImplementationOnce(() => { throw new Error('File check error'); })
        .mockReturnValueOnce({ path: 'Tasks/TaskC.md' });
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      await view.loadTasksSimple();
      
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-15',
        [
          { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: expect.any(String) },
          { path: 'Tasks/TaskC.md', instanceId: 'c', deletionType: 'permanent', deletedAt: expect.any(String) }
        ]
      );
    });

    test('saveDeletedInstances の更新が失敗してもエラーにならない', async () => {
      const deletedInstances = [
        { path: 'Tasks/TaskA.md', instanceId: 'a', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/TaskB.md', instanceId: 'b', deletionType: 'permanent', deletedAt: new Date().toISOString() }
      ];
      view.getDeletedInstances.mockReturnValue(deletedInstances);
      
      // TaskBが存在しない
      mockVault.getFileByPath
        .mockReturnValueOnce({ path: 'Tasks/TaskA.md' })
        .mockReturnValueOnce(null);
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      // saveDeletedInstances がエラーを投げる
      view.saveDeletedInstances.mockImplementationOnce(() => {
        throw new Error('save error');
      });
      
      // エラーが発生してもloadTasksSimpleは正常に完了する
      await expect(view.loadTasksSimple()).resolves.not.toThrow();
    });

    test('クリーンアップ後もタスクのスキップ処理が正しく動作する', async () => {
      const deletedInstances = [
        { path: 'Tasks/DeletedTask.md', instanceId: 'd', deletionType: 'permanent', deletedAt: new Date().toISOString() },
        { path: 'Tasks/NonExistent.md', instanceId: 'n', deletionType: 'permanent', deletedAt: new Date().toISOString() }
      ];
      view.getDeletedInstances.mockReturnValue(deletedInstances);
      
      // DeletedTaskは存在、NonExistentは存在しない  
      mockVault.getFileByPath
        .mockReturnValueOnce({ path: 'Tasks/DeletedTask.md' })
        .mockReturnValueOnce(null);
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      // タスクファイルのモック
      const taskFiles = [
        { path: 'Tasks/ActiveTask.md', basename: 'ActiveTask' },
        { path: 'Tasks/DeletedTask.md', basename: 'DeletedTask' }
      ];
      view.getTaskFiles.mockResolvedValue(taskFiles);
      
      await view.loadTasksSimple();
      
      // クリーンアップ後のリスト
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-15',
        [
          { path: 'Tasks/DeletedTask.md', instanceId: 'd', deletionType: 'permanent', deletedAt: expect.any(String) }
        ]
      );
      
      // DeletedTaskは読み込まれない
      expect(mockVault.read).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: 'Tasks/DeletedTask.md' })
      );
    });
  });

  describe('新旧システムの統合', () => {
    test('新システムの削除済みインスタンスも考慮される', async () => {
      // 旧システムには何もない
      mockLocalStorage['taskchute-deleted-tasks'] = '[]';
      
      // 新システムに削除済みインスタンスがある
      view.getDeletedInstances.mockReturnValue([
        {
          path: 'Tasks/DeletedTask.md',
          instanceId: 'test-id',
          deletionType: 'permanent',
          deletedAt: new Date().toISOString()
        }
      ]);
      
      // ファイルは存在する（まだ削除されていない）
      mockVault.getFileByPath.mockReturnValue({ path: 'Tasks/DeletedTask.md' });
      mockVault.getFolderByPath.mockReturnValue(null);
      
      // タスクファイル
      const taskFiles = [
        { path: 'Tasks/ActiveTask.md', basename: 'ActiveTask' },
        { path: 'Tasks/DeletedTask.md', basename: 'DeletedTask' }
      ];
      view.getTaskFiles.mockResolvedValue(taskFiles);
      
      await view.loadTasksSimple();
      
      // DeletedTaskは読み込まれない（新システムでフィルタリング）
      expect(mockVault.read).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: 'Tasks/DeletedTask.md' })
      );
      
      // ActiveTaskは読み込まれる
      expect(mockVault.read).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'Tasks/ActiveTask.md' })
      );
    });

    test('新システムで複数の削除タイプが混在する場合', async () => {
      // permanent と temporary が混在
      view.getDeletedInstances.mockReturnValue([
        {
          path: 'Tasks/PermanentDeleted.md',
          instanceId: 'p-id',
          deletionType: 'permanent',
          deletedAt: new Date().toISOString()
        },
        {
          path: 'Tasks/TempDeleted.md',
          instanceId: 't-id',
          deletionType: 'temporary',
          deletedAt: new Date().toISOString()
        }
      ]);
      
      // ファイルの存在を確認
      mockVault.getFileByPath
        .mockReturnValueOnce({ path: 'Tasks/PermanentDeleted.md' });
      mockVault.getFolderByPath
        .mockReturnValue(null);
      
      await view.loadTasksSimple();
      
      // permanent のみがチェックされる
      expect(mockVault.getFileByPath).toHaveBeenCalledTimes(1);
      expect(mockVault.getFileByPath).toHaveBeenCalledWith('Tasks/PermanentDeleted.md');
    });
  });

  describe('統合テスト', () => {
    test('タスク作成→削除→再作成のフローで正しく表示される', async () => {
      // 初期状態：削除済みインスタンスにTaskAが含まれているが、ファイルは存在しない
      view.getDeletedInstances.mockReturnValue([
        { 
          path: 'Tasks/TaskA.md', 
          instanceId: 'deleted-a', 
          deletionType: 'permanent', 
          deletedAt: new Date().toISOString() 
        }
      ]);
      
      // TaskA.mdは存在しない（削除済み）
      mockVault.getFileByPath.mockReturnValueOnce(null);
      mockVault.getFolderByPath.mockReturnValue(null);
      
      // 新しくTaskA.mdが作成された想定
      const taskFiles = [
        { path: 'Tasks/TaskA.md', basename: 'TaskA' }
      ];
      view.getTaskFiles.mockResolvedValue(taskFiles);
      
      await view.loadTasksSimple();
      
      // 削除済みリストがクリーンアップされる
      expect(view.saveDeletedInstances).toHaveBeenCalledWith(
        '2024-01-15',
        []
      );
      
      // TaskAが読み込まれる（スキップされない）
      expect(mockVault.read).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'Tasks/TaskA.md' })
      );
    });
  });
});