const { PathManager } = require('../main');
require('../__mocks__/obsidian');

describe('PathManager - Review Paths', () => {
  let pathManager;
  let mockPlugin;

  beforeEach(() => {
    // プラグインのモックを作成
    mockPlugin = {
      settings: {
        reviewDataPath: ""
      },
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(),
          createFolder: jest.fn()
        }
      }
    };
    
    pathManager = new PathManager(mockPlugin);
  });

  describe('getReviewDataPath', () => {
    test('デフォルトパスを返す（設定なし）', () => {
      const path = pathManager.getReviewDataPath();
      expect(path).toBe('TaskChute/Review');
    });

    test('設定されたパスを返す', () => {
      mockPlugin.settings.reviewDataPath = 'Custom/ReviewData';
      const path = pathManager.getReviewDataPath();
      expect(path).toBe('Custom/ReviewData');
    });

    test('空文字列の場合はデフォルトパスを返す', () => {
      mockPlugin.settings.reviewDataPath = '';
      const path = pathManager.getReviewDataPath();
      expect(path).toBe('TaskChute/Review');
    });
  });


  describe('デフォルトパスの定義', () => {
    test('reviewDataがデフォルトパスに含まれている', () => {
      expect(PathManager.DEFAULT_PATHS.reviewData).toBe('TaskChute/Review');
    });
  });
});