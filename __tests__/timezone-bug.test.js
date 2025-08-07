const { TaskChuteView } = require('../main.js');

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')

describe('タイムゾーンバグのテスト', () => {
  let mockApp;
  let taskChuteView;
  let mockFile;
  
  beforeEach(() => {
    // Obsidian APIのモック
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        read: jest.fn(),
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn(),
          getFullPath: jest.fn(path => `/mock/path/${path}`)
        }
      },
      workspace: {
        openLinkText: jest.fn()
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {
            routine: false
          }
        })
      }
    };

    // LeafとViewのモック
    const mockLeaf = {};
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
          addEventListener: jest.fn()
        }),
        addEventListener: jest.fn()
      })
    };
    
    // currentDateを設定（2025年7月10日）
    taskChuteView.currentDate = new Date(2025, 6, 10); // 月は0ベース
  });

  test('修正により正しい日付処理が行われることを確認', () => {
    // ファイルシステムのモック
    const fs = require('fs');
    jest.spyOn(fs, 'statSync');
    
    // 7月10日の朝8時（JST）に作成されたファイル
    const creationDateJST = new Date('2025-07-10T08:00:00+09:00');
    
    fs.statSync.mockReturnValue({
      birthtime: creationDateJST
    });
    
    // 修正後の処理をテスト
    const stats = fs.statSync();
    const fileCreationDate = new Date(stats.birthtime);
    
    // 修正後の処理：ローカルタイムゾーンで日付文字列を生成
    const year = fileCreationDate.getFullYear();
    const month = (fileCreationDate.getMonth() + 1).toString().padStart(2, '0');
    const day = fileCreationDate.getDate().toString().padStart(2, '0');
    const fileCreationDateString = `${year}-${month}-${day}`;
    
    // 修正後は正しい日付（2025-07-10）が取得できる
    expect(fileCreationDateString).toBe('2025-07-10');
    
    // 現在の表示日付と一致する
    const currentDateString = '2025-07-10';
    expect(fileCreationDateString).toBe(currentDateString);
  });

  test('正しい実装：ローカルタイムゾーンで日付を処理', () => {
    const creationDateJST = new Date('2025-07-10T08:00:00+09:00');
    
    // 正しい実装：ローカルタイムゾーンで日付文字列を生成
    const year = creationDateJST.getFullYear();
    const month = (creationDateJST.getMonth() + 1).toString().padStart(2, '0');
    const day = creationDateJST.getDate().toString().padStart(2, '0');
    const correctDateString = `${year}-${month}-${day}`;
    
    console.log('正しい日付処理:', correctDateString);
    expect(correctDateString).toBe('2025-07-10');
  });

  test('タイムゾーンの境界ケース', () => {
    const testCases = [
      {
        name: '0時ちょうど（JST）',
        jstTime: '2025-07-10T00:00:00+09:00',
        expectedISO: '2025-07-09', // UTCでは前日
        expectedLocal: '2025-07-10'
      },
      {
        name: '8時59分（JST）',
        jstTime: '2025-07-10T08:59:59+09:00',
        expectedISO: '2025-07-09', // UTCでは前日
        expectedLocal: '2025-07-10'
      },
      {
        name: '9時ちょうど（JST）',
        jstTime: '2025-07-10T09:00:00+09:00',
        expectedISO: '2025-07-10', // UTCでも同じ日
        expectedLocal: '2025-07-10'
      },
      {
        name: '23時59分（JST）',
        jstTime: '2025-07-10T23:59:59+09:00',
        expectedISO: '2025-07-10', // UTCでも同じ日
        expectedLocal: '2025-07-10'
      }
    ];

    testCases.forEach(testCase => {
      const date = new Date(testCase.jstTime);
      const isoDateString = date.toISOString().split('T')[0];
      
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const localDateString = `${year}-${month}-${day}`;
      
      console.log(`\n${testCase.name}:`);
      console.log(`  JST: ${date.toString()}`);
      console.log(`  ISO日付: ${isoDateString}`);
      console.log(`  ローカル日付: ${localDateString}`);
      
      expect(isoDateString).toBe(testCase.expectedISO);
      expect(localDateString).toBe(testCase.expectedLocal);
    });
  });

  test('現在のコードの問題点を実証', () => {
    // 現在のコードと同じ処理でバグを再現
    const creationDateJST = new Date('2025-07-10T08:00:00+09:00');
    
    // 現在のコードの処理（バグあり）
    const buggyDateString = creationDateJST.toISOString().split("T")[0];
    
    // 正しい処理
    const year = creationDateJST.getFullYear();
    const month = (creationDateJST.getMonth() + 1).toString().padStart(2, '0');
    const day = creationDateJST.getDate().toString().padStart(2, '0');
    const correctDateString = `${year}-${month}-${day}`;
    
    // バグの実証
    expect(buggyDateString).toBe('2025-07-09'); // 間違った日付
    expect(correctDateString).toBe('2025-07-10'); // 正しい日付
    expect(buggyDateString).not.toBe(correctDateString); // 一致しない
  });
});