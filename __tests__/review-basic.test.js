const { TaskChutePlugin, TaskChuteView, PathManager } = require('../main');
require('../__mocks__/obsidian');

describe('Review Feature - Basic Tests', () => {
  let plugin;
  let pathManager;

  beforeEach(() => {
    // モックの設定
    const mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        createFolder: jest.fn().mockResolvedValue(),
        create: jest.fn().mockResolvedValue({ path: 'test.md' }),
        read: jest.fn().mockResolvedValue('content')
      }
    };
    
    // プラグインとPathManagerを直接作成
    plugin = {
      settings: {
        reviewDataPath: ""
      },
      app: mockApp
    };
    
    pathManager = new PathManager(plugin);
  });

  test('PathManagerのレビュー関連メソッドが存在する', () => {
    expect(typeof pathManager.getReviewDataPath).toBe('function');
  });

  test('デフォルトレビューデータパスが正しい', () => {
    const path = pathManager.getReviewDataPath();
    expect(path).toBe('TaskChute/Review');
  });


  test('TaskChuteViewのレビュー関連メソッドが存在する', () => {
    const mockLeaf = { view: {} };
    const view = new TaskChuteView(mockLeaf, plugin);
    
    expect(typeof view.showReviewSection).toBe('function');
    expect(typeof view.createOrGetReviewFile).toBe('function');
    expect(typeof view.openReviewInSplit).toBe('function');
  });

  test('getCurrentDateStringメソッドが正しい形式を返す', () => {
    const mockLeaf = { view: {} };
    const view = new TaskChuteView(mockLeaf, plugin);
    view.currentDate = new Date(2025, 7, 1); // 2025年8月1日
    
    const dateStr = view.getCurrentDateString();
    expect(dateStr).toBe('2025-08-01');
  });
});