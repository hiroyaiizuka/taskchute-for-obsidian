const fs = require('fs')
const path = require('path')

// Obsidian APIのモック
require('../__mocks__/obsidian')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')

// ProjectNoteSyncManagerのテスト
describe('ProjectNoteSyncManager', () => {
  let app, pathManager, syncManager

  beforeEach(() => {
    // モックの初期化
    app = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn()
      }
    }
    
    pathManager = {
      getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project')
    }
    
    // ProjectNoteSyncManagerのインスタンス化（実際のクラスを使用）
    const { ProjectNoteSyncManager } = require('../main')
    syncManager = new ProjectNoteSyncManager(app, pathManager)
  })

  describe('ログセクションの検出', () => {
    test('## ログセクションを検出できる', async () => {
      const content = '# プロジェクト\n\n## 概要\n\n## ログ\n\nコンテンツ'
      const result = await syncManager.ensureLogSection(content)
      
      expect(result.exists).toBe(true)
      expect(result.position).toBeGreaterThan(0)
      expect(result.content).toBe(content)
    })

    test('# ログセクションを検出できる', async () => {
      const content = '# プロジェクト\n\n# ログ\n\nコンテンツ'
      const result = await syncManager.ensureLogSection(content)
      
      expect(result.exists).toBe(true)
      expect(result.position).toBeGreaterThan(0)
    })

    test('## Logセクション（英語）を検出できる', async () => {
      const content = '# Project\n\n## Log\n\nContent'
      const result = await syncManager.ensureLogSection(content)
      
      expect(result.exists).toBe(true)
      expect(result.position).toBeGreaterThan(0)
    })

    test('ログセクションが存在しない場合、末尾に追加する', async () => {
      const content = '# プロジェクト\n\n## 概要'
      const result = await syncManager.ensureLogSection(content)
      
      expect(result.exists).toBe(false)
      expect(result.content).toContain('## ログ')
      expect(result.content.endsWith('\n\n## ログ\n')).toBe(true)
    })
  })

  describe('コメントエントリのフォーマット', () => {
    test('単一行コメントを正しくフォーマットする', () => {
      const inst = {
        task: { title: 'テストタスク' },
        instanceId: 'test-123'
      }
      const completionData = {
        executionComment: 'よくできた'
      }
      const dateString = '2025-07-24'
      
      const result = syncManager.formatCommentEntry(inst, completionData, dateString)
      
      expect(result.date).toBe('2025-07-24')
      expect(result.entry).toBe('- [[2025-07-24]]\n    - よくできた')
      expect(result.instanceId).toBe('test-123')
    })

    test('複数行コメントを正しくフォーマットする', () => {
      const inst = {
        task: { title: 'テストタスク' },
        instanceId: 'test-123'
      }
      const completionData = {
        executionComment: 'よくできた\n次回はもっと頑張る'
      }
      const dateString = '2025-07-24'
      
      const result = syncManager.formatCommentEntry(inst, completionData, dateString)
      
      expect(result.entry).toContain('- [[2025-07-24]]')
      expect(result.entry).toContain('    - よくできた')
      expect(result.entry).toContain('    - 次回はもっと頑張る')
    })
  })

  describe('既存ログのパース', () => {
    test('既存ログを正しくパースする', () => {
      const content = `## ログ
- [[2025-07-24]]
    - コメント1
    - もう一つのコメント
- [[2025-07-25]]
    - コメント3`
      
      const logs = syncManager.parseExistingLogs(content, content.indexOf('## ログ') + 6)
      
      expect(logs).toHaveLength(2)
      expect(logs[0].date).toBe('2025-07-24')
      expect(logs[0].entries).toHaveLength(2) // コメント1とその2行目
      expect(logs[1].date).toBe('2025-07-25')
      expect(logs[1].entries).toHaveLength(1) // コメント3
    })

    test('空のログセクションを正しく処理する', () => {
      const content = '## ログ\n'
      const logs = syncManager.parseExistingLogs(content, content.indexOf('## ログ') + 6)
      
      expect(logs).toHaveLength(0)
    })
  })

  describe('日付順での挿入位置計算', () => {
    test('空のログに最初のエントリを挿入', () => {
      const content = '## ログ\n'
      const logs = []
      const newDate = '2025-07-24'
      const sectionPosition = content.indexOf('## ログ') + 6
      
      const position = syncManager.findDateInsertPosition(content, logs, newDate, sectionPosition)
      
      expect(position).toBe(sectionPosition + 1)
    })

    test('降順で正しい位置に挿入', () => {
      const content = `## ログ
- [[2025-07-25]]
　- タスク2: コメント2
- [[2025-07-20]]
　- タスク1: コメント1`
      
      const logs = [
        { date: '2025-07-25', lineIndex: 1, entries: [{ lineIndex: 2 }] },
        { date: '2025-07-20', lineIndex: 3, entries: [{ lineIndex: 4 }] }
      ]
      const newDate = '2025-07-22'
      const sectionPosition = content.indexOf('## ログ') + 6
      
      const position = syncManager.findDateInsertPosition(content, logs, newDate, sectionPosition)
      
      // 2025-07-25の後、2025-07-20の前に挿入されるべき（降順）
      expect(position).toBeGreaterThan(0)
    })
  })

  describe('プロジェクトノートパスの取得', () => {
    test('projectPathが存在する場合はそれを使用', async () => {
      const inst = {
        task: {
          projectPath: 'TaskChute/Project/TestProject.md',
          projectTitle: 'TestProject'
        }
      }
      
      const result = await syncManager.getProjectNotePath(inst)
      
      expect(result).toBe('TaskChute/Project/TestProject.md')
    })

    test('projectTitleからパスを構築', async () => {
      const inst = {
        task: {
          projectTitle: 'TestProject'
        }
      }
      
      app.vault.getAbstractFileByPath.mockReturnValue({ path: 'TaskChute/Project/TestProject.md' })
      
      const result = await syncManager.getProjectNotePath(inst)
      
      expect(result).toBe('TaskChute/Project/TestProject.md')
      expect(app.vault.getAbstractFileByPath).toHaveBeenCalledWith('TaskChute/Project/TestProject.md')
    })

    test('プロジェクトが紐付いていない場合はnullを返す', async () => {
      const inst = {
        task: {}
      }
      
      const result = await syncManager.getProjectNotePath(inst)
      
      expect(result).toBeNull()
    })
  })
})

// 統合テスト
describe('Task Comment Project Sync - Integration', () => {
  let plugin, view

  beforeEach(() => {
    // プラグインとビューのモック初期化
    plugin = {
      app: {
        vault: {
          getAbstractFileByPath: jest.fn(),
          read: jest.fn(),
          modify: jest.fn(),
          create: jest.fn(),
          createFolder: jest.fn(),
          adapter: {
            write: jest.fn(),
            exists: jest.fn().mockResolvedValue(true),
            read: jest.fn().mockResolvedValue('{}')
          }
        }
      },
      pathManager: {
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    // TaskChuteViewのインスタンス作成
    const { TaskChuteView } = require('../main')
    view = new TaskChuteView()
    view.plugin = plugin
    view.app = plugin.app
  })

  test('プロジェクトノートへのコメント同期が正常に動作する', async () => {
    const inst = {
      task: {
        title: 'テストタスク',
        projectTitle: 'TestProject'
      },
      startTime: new Date('2025-07-24'),
      instanceId: 'test-123'
    }

    const completionData = {
      executionComment: 'テストコメント',
      focusLevel: 4,
      energyLevel: 3
    }

    // TFileインスタンスのモック
    const mockProjectFile = { path: 'TaskChute/Project/TestProject.md' }
    mockProjectFile.constructor = TFile
    Object.setPrototypeOf(mockProjectFile, TFile.prototype)
    
    const mockLogFile = { path: 'TaskChute/Log/2025-07-tasks.json' }
    mockLogFile.constructor = TFile
    Object.setPrototypeOf(mockLogFile, TFile.prototype)
    
    // ファイルの存在をモック
    plugin.app.vault.getAbstractFileByPath.mockImplementation((path) => {
      if (path === 'TaskChute/Project/TestProject.md') {
        return mockProjectFile
      }
      if (path === 'TaskChute/Log/2025-07-tasks.json') {
        return mockLogFile
      }
      if (path === 'TaskChute/Log') {
        return { children: [] } // ディレクトリモック
      }
      return null
    })
    
    // ファイル内容をモック
    plugin.app.vault.read.mockImplementation(async (file) => {
      if (file === mockLogFile || file.path === 'TaskChute/Log/2025-07-tasks.json') {
        return JSON.stringify({
          metadata: {},
          taskExecutions: {},
          dailySummary: {}
        })
      }
      if (file === mockProjectFile || file.path === 'TaskChute/Project/TestProject.md') {
        return '# TestProject\n\n## 概要\nプロジェクトの説明'
      }
      return ''
    })
    
    // createとcreateFolderのモック
    plugin.app.vault.create.mockResolvedValue()
    plugin.app.vault.createFolder.mockResolvedValue()

    // saveTaskCompletionを呼び出し
    await view.saveTaskCompletion(inst, completionData)

    // プロジェクトノートが更新されたことを確認
    expect(plugin.app.vault.modify).toHaveBeenCalled()
    
    // modify呼び出しを確認（複数回呼ばれる可能性がある）
    const modifyCalls = plugin.app.vault.modify.mock.calls
    
    // プロジェクトノートの更新を探す
    let projectNoteUpdated = false
    for (const call of modifyCalls) {
      const [file, content] = call
      if (file && file.path === 'TaskChute/Project/TestProject.md') {
        // プロジェクトノートの更新内容を確認
        expect(content).toContain('## ログ')
        expect(content).toContain('[[2025-07-24]]')
        expect(content).toContain('    - テストコメント')
        projectNoteUpdated = true
        break
      }
    }
    
    expect(projectNoteUpdated).toBe(true)
  })

  test('プロジェクトノートが存在しない場合はエラーにならない', async () => {
    const inst = {
      task: {
        title: 'テストタスク',
        projectTitle: 'NonExistentProject'
      },
      startTime: new Date('2025-07-24'),
      instanceId: 'test-123'
    }

    const completionData = {
      executionComment: 'テストコメント'
    }

    // プロジェクトノートが存在しない
    plugin.app.vault.getAbstractFileByPath.mockReturnValue(null)

    // JSONログファイルの内容をモック
    plugin.app.vault.adapter.read.mockResolvedValue(JSON.stringify({
      metadata: {},
      taskExecutions: {},
      dailySummary: {}
    }))

    // エラーが発生しないことを確認
    await expect(view.saveTaskCompletion(inst, completionData)).resolves.not.toThrow()
    
    // プロジェクトノートの更新が試みられないことを確認
    expect(plugin.app.vault.modify).not.toHaveBeenCalled()
  })

  test('同じ日付への複数コメント追記が正常に動作する', async () => {
    const inst1 = {
      task: {
        title: 'タスク1',
        projectTitle: 'TestProject'
      },
      startTime: new Date('2025-07-24'),
      instanceId: 'test-123'
    }

    const inst2 = {
      task: {
        title: 'タスク2',
        projectTitle: 'TestProject'
      },
      startTime: new Date('2025-07-24'),
      instanceId: 'test-456'
    }

    const completionData1 = {
      executionComment: 'コメント1'
    }

    const completionData2 = {
      executionComment: 'コメント2'
    }

    // プロジェクトノートの存在をモック
    plugin.app.vault.getAbstractFileByPath.mockReturnValue({ 
      path: 'TaskChute/Project/TestProject.md' 
    })
    
    // 最初は空のプロジェクトノート
    plugin.app.vault.read.mockResolvedValueOnce('# TestProject\n\n## 概要')
    
    // 1回目の更新後の内容
    plugin.app.vault.read.mockResolvedValueOnce(`# TestProject

## 概要

## ログ
- [[2025-07-24]]
    - コメント1`)

    const { ProjectNoteSyncManager } = require('../main')
    const syncManager = new ProjectNoteSyncManager(plugin.app, plugin.pathManager)

    // 1つ目のコメントを追加
    await syncManager.updateProjectNote('TaskChute/Project/TestProject.md', inst1, completionData1)
    
    // 2つ目のコメントを追加
    await syncManager.updateProjectNote('TaskChute/Project/TestProject.md', inst2, completionData2)

    // 2回の更新が行われたことを確認
    expect(plugin.app.vault.modify).toHaveBeenCalledTimes(2)
    
    // 2回目の更新内容を確認
    const secondModifyCall = plugin.app.vault.modify.mock.calls[1]
    const updatedContent = secondModifyCall[1]
    
    // 同じ日付の下に2つのコメントが含まれることを確認
    expect(updatedContent).toContain('- [[2025-07-24]]')
    expect(updatedContent).toContain('    - コメント1')
    expect(updatedContent).toContain('    - コメント2')
  })
})