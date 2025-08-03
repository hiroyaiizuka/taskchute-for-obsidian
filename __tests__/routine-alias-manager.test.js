const { RoutineAliasManager } = require('../main.js')

describe('RoutineAliasManager', () => {
  let manager
  let mockPlugin
  let mockApp
  
  beforeEach(() => {
    // モックの初期化
    mockApp = {
      vault: {
        adapter: {
          exists: jest.fn(),
          read: jest.fn(),
          write: jest.fn()
        }
      }
    }
    
    mockPlugin = {
      app: mockApp,
      pathManager: {
        getTaskFolderPath: jest.fn(() => 'TaskChute/Task'),
        ensureFolderExists: jest.fn()
      }
    }
    
    manager = new RoutineAliasManager(mockPlugin)
  })
  
  describe('基本機能', () => {
    test('初期化時のプロパティ設定', () => {
      expect(manager.plugin).toBe(mockPlugin)
      expect(manager.aliasCache).toBeNull()
    })
    
    test('エイリアスファイルパスの生成', () => {
      const path = manager.getAliasFilePath()
      expect(path).toBe('TaskChute/Task/routine-aliases.json')
      expect(mockPlugin.pathManager.getTaskFolderPath).toHaveBeenCalled()
    })
  })
  
  describe('エイリアスの読み込み', () => {
    test('ファイルが存在しない場合は空オブジェクトを返す', async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false)
      
      const aliases = await manager.loadAliases()
      
      expect(aliases).toEqual({})
      expect(manager.aliasCache).toEqual({})
    })
    
    test('既存のエイリアスファイルを読み込む', async () => {
      const mockData = {
        '朝のジョギング': ['朝の運動'],
        '朝のランニング': ['朝のジョギング', '朝の運動']
      }
      
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(mockData))
      
      const aliases = await manager.loadAliases()
      
      expect(aliases).toEqual(mockData)
      expect(manager.aliasCache).toEqual(mockData)
    })
    
    test('キャッシュがある場合はキャッシュを返す', async () => {
      const cachedData = { 'タスクA': ['旧タスクA'] }
      manager.aliasCache = cachedData
      
      const aliases = await manager.loadAliases()
      
      expect(aliases).toBe(cachedData)
      expect(mockApp.vault.adapter.exists).not.toHaveBeenCalled()
    })
  })
  
  describe('エイリアスの追加', () => {
    test('新しいタスクのエイリアスを追加', async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(false)
      
      await manager.addAlias('新タスク', '旧タスク')
      
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        'TaskChute/Task/routine-aliases.json',
        JSON.stringify({ '新タスク': ['旧タスク'] }, null, 2)
      )
    })
    
    test('既存のエイリアスを引き継ぐ（A→B→C）', async () => {
      const existingData = {
        'タスクB': ['タスクA']
      }
      
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(existingData))
      
      await manager.addAlias('タスクC', 'タスクB')
      
      const expectedData = {
        'タスクC': ['タスクA', 'タスクB']
      }
      
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        'TaskChute/Task/routine-aliases.json',
        JSON.stringify(expectedData, null, 2)
      )
    })
    
    test('同じエイリアスを追加しても重複しない', async () => {
      const existingData = {
        'タスクB': ['タスクA']
      }
      
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue(JSON.stringify(existingData))
      
      await manager.addAlias('タスクB', 'タスクA')
      
      const expectedData = {
        'タスクB': ['タスクA'] // 重複していない
      }
      
      expect(mockApp.vault.adapter.write).toHaveBeenCalledWith(
        'TaskChute/Task/routine-aliases.json',
        JSON.stringify(expectedData, null, 2)
      )
    })
  })
  
  describe('エイリアスの取得', () => {
    beforeEach(() => {
      manager.aliasCache = {
        '朝のジョギング': ['朝の運動'],
        '朝のランニング': ['朝のジョギング', '朝の運動']
      }
    })
    
    test('エイリアスが存在する場合', () => {
      const aliases = manager.getAliases('朝のジョギング')
      expect(aliases).toEqual(['朝の運動'])
    })
    
    test('エイリアスが存在しない場合', () => {
      const aliases = manager.getAliases('存在しないタスク')
      expect(aliases).toEqual([])
    })
    
    test('キャッシュがnullの場合', () => {
      manager.aliasCache = null
      const aliases = manager.getAliases('タスク')
      expect(aliases).toEqual([])
    })
  })
  
  describe('現在の名前の検索', () => {
    beforeEach(() => {
      manager.aliasCache = {
        '朝のジョギング': ['朝の運動'],
        '朝のランニング': ['朝のジョギング', '朝の運動']
      }
    })
    
    test('旧名から現在の名前を見つける', () => {
      const currentName = manager.findCurrentName('朝の運動')
      expect(currentName).toBe('朝のジョギング')
    })
    
    test('多段階の変更でも正しく見つける', () => {
      const currentName = manager.findCurrentName('朝の運動')
      // '朝の運動' は '朝のジョギング' のエイリアスにもあり、
      // '朝のランニング' のエイリアスにもある
      // 最初に見つかったものを返す
      expect(['朝のジョギング', '朝のランニング']).toContain(currentName)
    })
    
    test('現在の名前が見つからない場合', () => {
      const currentName = manager.findCurrentName('存在しないタスク')
      expect(currentName).toBeNull()
    })
    
    test('循環参照を防ぐ', () => {
      // 循環参照があるデータ
      manager.aliasCache = {
        'タスクA': ['タスクB'],
        'タスクB': ['タスクA']
      }
      
      const currentName = manager.findCurrentName('タスクA')
      expect(currentName).toBe('タスクB')
      
      // 無限ループにならないことを確認
    })
  })
  
  describe('エラーハンドリング', () => {
    test('エイリアス保存時のエラー', async () => {
      // console.errorのモック
      const consoleError = jest.spyOn(console, 'error').mockImplementation()
      
      // ファイル書き込みでエラーが発生
      mockApp.vault.adapter.write.mockRejectedValue(new Error('Write failed'))
      
      await manager.addAlias('新タスク', '旧タスク')
      
      // console.errorは削除されたので、代わりにNoticeが呼ばれることを確認
      const Notice = require('obsidian').Notice
      expect(Notice).toHaveBeenCalledWith(
        'ルーチンタスクの名前変更履歴の保存に失敗しました'
      )
      
      consoleError.mockRestore()
    })
    
    test('破損したJSONファイルの処理', async () => {
      mockApp.vault.adapter.exists.mockResolvedValue(true)
      mockApp.vault.adapter.read.mockResolvedValue('{ invalid json')
      
      const aliases = await manager.loadAliases()
      
      expect(aliases).toEqual({})
      expect(manager.aliasCache).toEqual({})
    })
  })
})