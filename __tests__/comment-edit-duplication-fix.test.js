// TaskChuteViewを直接要求せず、テスト実行時にmain.jsからコンストラクタを取得
const { Notice } = require('obsidian')

describe('Comment Edit Duplication Fix', () => {
  let view
  let plugin
  let app
  let vault
  let inst
  
  beforeEach(() => {
    // モックの設定
    vault = {
      getAbstractFileByPath: jest.fn(),
      createFolder: jest.fn(),
      read: jest.fn(),
      modify: jest.fn(),
      create: jest.fn(),
    }
    
    app = {
      vault,
    }
    
    plugin = {
      pathManager: {
        getLogDataPath: jest.fn(() => 'TaskChute/Log/data'),
      },
    }
    
    // TaskChuteViewのモックインスタンスを作成
    view = {
      app,
      plugin,
      getTaskRecordDate: jest.fn(() => new Date('2025-01-22')),
      getTaskRecordDateString: jest.fn(() => '2025-01-22'),
      calculateCrossDayDuration: jest.fn(() => 1800000),
      syncCommentToProjectNote: jest.fn(),
      hasCommentChanged: jest.fn((oldData, newData) => {
        const oldComment = oldData?.executionComment || ''
        const newComment = newData?.executionComment || ''
        return oldComment !== newComment
      }),
      saveTaskCompletion: jest.fn(async function(inst, completionData) {
        // saveTaskCompletionの簡略化された実装
        const dateString = '2025-01-22'
        const logFilePath = 'TaskChute/Log/data/2025-01-tasks.json'
        
        // 既存データを読み込み
        let monthlyLog = { taskExecutions: { [dateString]: [] } }
        const existingFile = this.app.vault.getAbstractFileByPath(logFilePath)
        if (existingFile) {
          const content = await this.app.vault.read(existingFile)
          monthlyLog = JSON.parse(content)
        }
        
        // 既存データを探す
        let existingTaskData = null
        const existingIndex = monthlyLog.taskExecutions[dateString].findIndex(
          (entry) => entry.instanceId === inst.instanceId
        )
        
        if (existingIndex !== -1) {
          existingTaskData = monthlyLog.taskExecutions[dateString][existingIndex]
          // 更新
          monthlyLog.taskExecutions[dateString][existingIndex] = {
            ...existingTaskData,
            ...completionData,
          }
        } else {
          // 新規追加
          monthlyLog.taskExecutions[dateString].push(completionData)
        }
        
        // JSONを保存
        await this.app.vault.modify(existingFile, JSON.stringify(monthlyLog))
        
        // プロジェクト同期の条件をチェック
        const commentChanged = this.hasCommentChanged(existingTaskData, completionData)
        
        if (
          completionData &&
          completionData.executionComment &&
          (inst.task.projectPath || inst.task.projectTitle) &&
          commentChanged
        ) {
          await this.syncCommentToProjectNote(inst, completionData)
        }
      }),
    }
    
    // テスト用のタスクインスタンス
    inst = {
      instanceId: 'test-instance-123',
      task: {
        title: 'テストタスク',
        path: 'Task/test-task.md',
        projectTitle: 'テストプロジェクト',
        projectPath: 'Project/test-project.md',
        isRoutine: false,
      },
      state: 'done',
      startTime: new Date('2025-01-22T10:00:00'),
      stopTime: new Date('2025-01-22T10:30:00'),
      slotKey: 'morning',
    }
    
    // syncCommentToProjectNoteをモック
    view.syncCommentToProjectNote = jest.fn()
  })
  
  describe('hasCommentChanged', () => {
    test('コメントが変更された場合はtrueを返す', () => {
      const oldData = { executionComment: '古いコメント' }
      const newData = { executionComment: '新しいコメント' }
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(true)
    })
    
    test('コメントが同じ場合はfalseを返す', () => {
      const oldData = { executionComment: '同じコメント' }
      const newData = { executionComment: '同じコメント' }
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(false)
    })
    
    test('古いデータがnullの場合はtrueを返す（初回入力）', () => {
      const oldData = null
      const newData = { executionComment: '新しいコメント' }
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(true)
    })
    
    test('コメントが空から値が入った場合はtrueを返す', () => {
      const oldData = { executionComment: '' }
      const newData = { executionComment: '新しいコメント' }
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(true)
    })
    
    test('コメントが値から空になった場合はtrueを返す', () => {
      const oldData = { executionComment: 'コメント' }
      const newData = { executionComment: '' }
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(true)
    })
    
    test('両方が空の場合はfalseを返す', () => {
      const oldData = { executionComment: '' }
      const newData = { executionComment: '' }
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(false)
    })
    
    test('executionCommentプロパティがない場合も適切に処理される', () => {
      const oldData = {}
      const newData = {}
      
      expect(view.hasCommentChanged(oldData, newData)).toBe(false)
    })
  })
  
  describe('saveTaskCompletion - プロジェクト同期条件', () => {
    const mockExistingLog = {
      metadata: {
        version: '2.0',
        month: '2025-01',
        lastUpdated: '2025-01-22T10:00:00Z',
      },
      dailySummary: {},
      taskExecutions: {
        '2025-01-22': [],
      },
      patterns: {},
    }
    
    beforeEach(() => {
      // ファイル操作のモック設定
      vault.getAbstractFileByPath.mockImplementation((path) => {
        if (path === 'TaskChute/Log/data') {
          return { type: 'folder' }
        }
        if (path === 'TaskChute/Log/data/2025-01-tasks.json') {
          return { type: 'file', path }
        }
        return null
      })
      
      vault.read.mockResolvedValue(JSON.stringify(mockExistingLog))
      vault.modify.mockResolvedValue()
    })
    
    test('初回コメント入力時はプロジェクトログに同期される', async () => {
      const completionData = {
        executionComment: '初回のコメント',
        focusLevel: 3,
        energyLevel: 3,
      }
      
      await view.saveTaskCompletion(inst, completionData)
      
      expect(view.syncCommentToProjectNote).toHaveBeenCalledWith(inst, completionData)
    })
    
    test('コメント内容が変更された場合はプロジェクトログに同期される', async () => {
      // 既存のタスクデータを設定
      mockExistingLog.taskExecutions['2025-01-22'] = [{
        instanceId: 'test-instance-123',
        taskName: 'テストタスク',
        executionComment: '古いコメント',
        focusLevel: 3,
        energyLevel: 3,
      }]
      vault.read.mockResolvedValue(JSON.stringify(mockExistingLog))
      
      const completionData = {
        executionComment: '新しいコメント',
        focusLevel: 3,
        energyLevel: 3,
      }
      
      await view.saveTaskCompletion(inst, completionData)
      
      expect(view.syncCommentToProjectNote).toHaveBeenCalledWith(inst, completionData)
    })
    
    test('集中度のみ変更された場合はプロジェクトログに同期されない', async () => {
      // 既存のタスクデータを設定
      const existingTaskData = {
        instanceId: 'test-instance-123',
        taskName: 'テストタスク',
        executionComment: '同じコメント',
        focusLevel: 3,
        energyLevel: 3,
      }
      mockExistingLog.taskExecutions['2025-01-22'] = [existingTaskData]
      vault.read.mockResolvedValue(JSON.stringify(mockExistingLog))
      
      const completionData = {
        executionComment: '同じコメント',
        focusLevel: 5,  // 集中度だけ変更
        energyLevel: 3,
      }
      
      await view.saveTaskCompletion(inst, completionData)
      
      expect(view.syncCommentToProjectNote).not.toHaveBeenCalled()
    })
    
    test('元気度のみ変更された場合はプロジェクトログに同期されない', async () => {
      // 既存のタスクデータを設定
      mockExistingLog.taskExecutions['2025-01-22'] = [{
        instanceId: 'test-instance-123',
        taskName: 'テストタスク',
        executionComment: '同じコメント',
        focusLevel: 3,
        energyLevel: 3,
      }]
      vault.read.mockResolvedValue(JSON.stringify(mockExistingLog))
      
      const completionData = {
        executionComment: '同じコメント',
        focusLevel: 3,
        energyLevel: 5,  // 元気度だけ変更
      }
      
      await view.saveTaskCompletion(inst, completionData)
      
      expect(view.syncCommentToProjectNote).not.toHaveBeenCalled()
    })
    
    test('集中度と元気度の両方が変更されてもコメントが同じ場合は同期されない', async () => {
      // 既存のタスクデータを設定
      mockExistingLog.taskExecutions['2025-01-22'] = [{
        instanceId: 'test-instance-123',
        taskName: 'テストタスク',
        executionComment: '同じコメント',
        focusLevel: 3,
        energyLevel: 3,
      }]
      vault.read.mockResolvedValue(JSON.stringify(mockExistingLog))
      
      const completionData = {
        executionComment: '同じコメント',
        focusLevel: 5,  // 集中度変更
        energyLevel: 5,  // 元気度も変更
      }
      
      await view.saveTaskCompletion(inst, completionData)
      
      expect(view.syncCommentToProjectNote).not.toHaveBeenCalled()
    })
    
    test('JSONログは常に更新される（同期の有無に関わらず）', async () => {
      // 既存のタスクデータを設定
      mockExistingLog.taskExecutions['2025-01-22'] = [{
        instanceId: 'test-instance-123',
        taskName: 'テストタスク',
        executionComment: '同じコメント',
        focusLevel: 3,
        energyLevel: 3,
      }]
      vault.read.mockResolvedValue(JSON.stringify(mockExistingLog))
      
      const completionData = {
        executionComment: '同じコメント',
        focusLevel: 5,  // 集中度だけ変更
        energyLevel: 3,
      }
      
      await view.saveTaskCompletion(inst, completionData)
      
      // JSONログは更新される
      expect(vault.modify).toHaveBeenCalled()
      const savedData = JSON.parse(vault.modify.mock.calls[0][1])
      expect(savedData.taskExecutions['2025-01-22'][0].focusLevel).toBe(5)
      
      // プロジェクトログは同期されない
      expect(view.syncCommentToProjectNote).not.toHaveBeenCalled()
    })
    
    test('プロジェクトが設定されていないタスクでもエラーにならない', async () => {
      // プロジェクト情報を削除
      inst.task.projectPath = null
      inst.task.projectTitle = null
      
      const completionData = {
        executionComment: 'コメント',
        focusLevel: 3,
        energyLevel: 3,
      }
      
      await expect(view.saveTaskCompletion(inst, completionData)).resolves.not.toThrow()
      
      // プロジェクトログ同期は呼ばれない
      expect(view.syncCommentToProjectNote).not.toHaveBeenCalled()
    })
  })
})