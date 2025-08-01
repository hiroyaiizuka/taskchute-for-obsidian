/**
 * @file deleted-task-name-reuse-bug.test.js
 * @description 削除したタスクと同じ名前で新しいタスクを作成した場合のバグを再現するテスト
 * 
 * 問題の概要:
 * 1. タスクA を作成して削除
 * 2. 同じ名前でタスクA を再作成
 * 3. 新しいタスクA がタスク一覧に表示されない
 * 
 * 原因:
 * - 削除したタスクのパスが localStorage の削除済みリストに残る
 * - 新しいタスクが同じパスで作成されるとスキップされる
 */

const { test, expect } = require('@jest/globals');
const { TaskChuteView } = require('../main.js');

// localStorageのモック
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = value.toString(); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; }
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock
});

// Obsidian APIのモック
const mockApp = {
  vault: {
    getAbstractFileByPath: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    read: jest.fn(),
    getMarkdownFiles: jest.fn(() => []),
    adapter: {
      exists: jest.fn(),
      read: jest.fn(),
      write: jest.fn(),
      list: jest.fn()
    }
  },
  workspace: {
    getLeaf: jest.fn(),
    getLeavesOfType: jest.fn(() => [])
  }
};

// Noticeクラスのモック
global.Notice = jest.fn();

describe('削除したタスクと同じ名前のタスク作成バグ', () => {
  let view;
  
  beforeEach(() => {
    // localStorageをクリア
    localStorageMock.clear();
    
    // モックをリセット
    jest.clearAllMocks();
    
    // TaskChuteViewのインスタンスを作成
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(null, mockPlugin);
    view.app = mockApp;
    view.taskList = {
      empty: jest.fn(),
      createEl: jest.fn(() => ({
        createEl: jest.fn(),
        setAttribute: jest.fn(),
        addEventListener: jest.fn()
      }))
    };
    view.tasks = [];
    view.taskInstances = [];
    view.currentDate = new Date(2025, 0, 23); // 2025年1月23日
    
    // getCurrentDateStringメソッドをモック
    view.getCurrentDateString = jest.fn(() => '2025-01-23');
    
    // getTaskFilesメソッドをモック
    view.getTaskFiles = jest.fn(async () => []);
  });

  test('削除したタスクと同じ名前で新しいタスクを作成した場合、タスク一覧に表示されるべき', async () => {
    const taskName = 'テストタスク';
    const taskPath = `TaskChute/Task/${taskName}.md`;
    
    // ステップ1: 削除済みリストに事前にパスを追加（タスクが削除されたことをシミュレート）
    const deletedTasks = [taskPath];
    localStorageMock.setItem('taskchute-deleted-tasks', JSON.stringify(deletedTasks));
    
    // ステップ2: 同じ名前で新しいタスクを作成
    mockApp.vault.getAbstractFileByPath.mockReturnValueOnce(null); // ファイルが存在しない
    mockApp.vault.create.mockResolvedValueOnce({ path: taskPath });
    
    // createNewTaskを実際に呼び出す前の削除済みリストを確認
    const beforeCreate = JSON.parse(localStorageMock.getItem('taskchute-deleted-tasks') || '[]');
    expect(beforeCreate).toContain(taskPath);
    
    await view.createNewTask(taskName, 'テスト説明');
    
    // タスクが作成されたことを確認
    expect(mockApp.vault.create).toHaveBeenCalledWith(
      taskPath,
      expect.stringContaining(taskName)
    );
    
    // 修正によって削除済みリストから削除されたことを確認
    const afterCreate = JSON.parse(localStorageMock.getItem('taskchute-deleted-tasks') || '[]');
    expect(afterCreate).not.toContain(taskPath); // 修正により削除済みリストから削除される
  });

  test('修正後: タスク作成時に削除済みリストから該当パスを削除する', async () => {
    const taskName = 'テストタスク';
    const taskPath = `TaskChute/Task/${taskName}.md`;
    
    // 削除済みリストに事前にパスを追加
    const deletedTasks = [taskPath, 'TaskChute/Task/別のタスク.md'];
    localStorageMock.setItem('taskchute-deleted-tasks', JSON.stringify(deletedTasks));
    
    // ファイル作成のモック
    mockApp.vault.getAbstractFileByPath.mockReturnValueOnce(null);
    mockApp.vault.create.mockResolvedValueOnce({ path: taskPath });
    
    // タスクを作成
    await view.createNewTask(taskName, 'テスト説明');
    
    // 削除済みリストから削除されたことを確認
    const updatedDeletedTasks = JSON.parse(localStorageMock.getItem('taskchute-deleted-tasks') || '[]');
    expect(updatedDeletedTasks).not.toContain(taskPath);
    expect(updatedDeletedTasks).toContain('TaskChute/Task/別のタスク.md'); // 他のパスは残る
  });
});