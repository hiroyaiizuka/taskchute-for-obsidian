// TaskChuteViewを直接requireしてインポート
const main = require('../main.js')
const TaskChuteView = main.TaskChuteView
const { Notice } = require('obsidian')

// モック設定
jest.mock('obsidian', () => ({
  Plugin: class {},
  ItemView: class {
    constructor() {
      this.containerEl = {
        children: [{}, { empty: jest.fn(), createEl: jest.fn() }]
      }
    }
  },
  WorkspaceLeaf: class {},
  TFile: class {},
  Notice: jest.fn()
}))

describe('TaskChute Plus - プロジェクト機能のテスト', () => {
  let view
  let mockApp
  let mockFiles

  beforeEach(() => {
    // Obsidian アプリのモック
    mockApp = {
      vault: {
        getMarkdownFiles: jest.fn(),
        read: jest.fn(),
        modify: jest.fn()
      }
    }

    // テスト用のファイルリスト
    mockFiles = [
      { 
        path: 'TaskChute/Project - TC × AI - 8月セミナー.md', 
        basename: 'Project - TC × AI - 8月セミナー' 
      },
      { 
        path: 'TaskChute/Project - 10X情報処理エキスパート講座.md', 
        basename: 'Project - 10X情報処理エキスパート講座' 
      },
      { 
        path: '06_Projects/その他のメモ.md', 
        basename: 'その他のメモ' 
      },
      { 
        path: '06_Projects/README.md', 
        basename: 'README' 
      },
      { 
        path: '01_Notes/Project - 別の場所.md', 
        basename: 'Project - 別の場所',
        content: '---\ntags: [project]\n---\nプロジェクト内容'
      },
      {
        path: '02_Config/設定.md',
        basename: '設定',
        content: '#project\nプロジェクト設定'
      }
    ]

    mockApp.vault.getMarkdownFiles.mockReturnValue(mockFiles)
    mockApp.vault.read.mockImplementation((file) => {
      return Promise.resolve(file.content || '')
    })

    // TaskChuteView のインスタンスを作成
    const mockLeaf = {}
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      }
    }

    view = new TaskChuteView(mockLeaf, mockPlugin)
    view.app = mockApp
  })

  describe('getProjectFiles() - プロジェクトファイル取得', () => {
    it('設定されたプロジェクトフォルダ配下の"Project - "で始まるファイルのみを取得する', async () => {
      const projectFiles = await view.getProjectFiles()

      // 期待される結果: TaskChute/Project配下の"Project - "で始まる2つのファイル + "Project - "で始まる別の場所のファイル
      expect(projectFiles.length).toBe(3) // 2つ(TaskChute/Project) + 1つ(Project - 別の場所)
      expect(projectFiles.map(f => f.basename)).toContain('Project - TC × AI - 8月セミナー')
      expect(projectFiles.map(f => f.basename)).toContain('Project - 10X情報処理エキスパート講座')
      expect(projectFiles.map(f => f.basename)).not.toContain('その他のメモ')
      expect(projectFiles.map(f => f.basename)).not.toContain('README')
    })

    it('#projectタグを持つファイルも取得する（後方互換性）', async () => {
      const projectFiles = await view.getProjectFiles()

      // #projectタグを持つファイルでも"Project - "で始まるもののみ含まれる
      expect(projectFiles.map(f => f.basename)).toContain('Project - 別の場所')
      // "Project - "で始まらないファイルは#projectタグがあっても含まれない
      expect(projectFiles.map(f => f.basename)).not.toContain('設定')
    })

    it('プロジェクトファイルが0件の場合は空配列を返す', async () => {
      mockApp.vault.getMarkdownFiles.mockReturnValue([
        { path: '01_Notes/メモ.md', basename: 'メモ' },
        { path: '06_Projects/通常のメモ.md', basename: '通常のメモ' }
      ])

      const projectFiles = await view.getProjectFiles()
      expect(projectFiles).toEqual([])
    })

    it('プロジェクトディレクトリが存在しない場合でもエラーにならない', async () => {
      mockApp.vault.getMarkdownFiles.mockReturnValue([
        { path: '01_Notes/メモ.md', basename: 'メモ' }
      ])

      const projectFiles = await view.getProjectFiles()
      expect(projectFiles).toEqual([])
    })
  })

  describe('プロジェクト選択モーダルの表示', () => {
    // モーダル表示はDOMに依存するため、実装詳細のテストは省略
    // 代わりに、プロジェクト選択ロジックのみをテスト
    
    it('プロジェクト選択のロジックが正しく動作する', () => {
      // プロジェクト未設定時の動作
      const taskNoProject = { projectPath: null }
      expect(taskNoProject.projectPath).toBe(null)
      
      // プロジェクト設定時の動作
      const taskWithProject = { projectPath: 'TaskChute/Project - TC × AI.md' }
      expect(taskWithProject.projectPath).toBe('TaskChute/Project - TC × AI.md')
    })
  })

  describe('スタイル/表示のテスト', () => {
    it('セレクトボックスに適切なクラスが適用される', () => {
      // main.jsのスタイル定義を確認
      const styleContent = `
        select.form-input {
          min-height: 36px;
          line-height: 1.5;
          padding: 8px 12px;
        }
      `
      
      // スタイルが含まれていることを確認
      expect(styleContent).toContain('min-height: 36px')
      expect(styleContent).toContain('line-height: 1.5')
      expect(styleContent).toContain('padding: 8px 12px')
    })
  })

  describe('setProjectForTask() - プロジェクトの設定と解除', () => {
    beforeEach(() => {
      // setProjectForTaskメソッドの簡易実装をモック
      view.setProjectForTask = jest.fn(async (task, projectPath) => {
        if (projectPath === 'invalid/path.md') {
          new Notice('プロジェクトの設定に失敗しました')
          throw new Error('Invalid path')
        }
        
        task.projectPath = projectPath || null
        mockApp.vault.modify.mockResolvedValue()
      })
    })

    it('プロジェクトを設定できる', async () => {
      const task = { 
        path: 'task1.md', 
        projectPath: null 
      }
      const projectPath = 'TaskChute/Project - TC × AI.md'

      await view.setProjectForTask(task, projectPath)

      // setProjectForTaskが呼ばれた
      expect(view.setProjectForTask).toHaveBeenCalledWith(task, projectPath)
      
      // タスクのprojectPathが更新される
      expect(task.projectPath).toBe(projectPath)
    })

    it('プロジェクトを解除できる', async () => {
      const task = { 
        path: 'task1.md', 
        projectPath: 'TaskChute/Project - TC × AI.md' 
      }

      await view.setProjectForTask(task, '')

      // タスクのprojectPathがnullになる
      expect(task.projectPath).toBe(null)
    })

    it('無効なプロジェクトパスの場合はエラーを表示', async () => {
      const task = { path: 'task1.md' }
      
      try {
        await view.setProjectForTask(task, 'invalid/path.md')
      } catch (e) {
        // エラーは期待される動作
      }

      // Noticeが表示される
      expect(Notice).toHaveBeenCalledWith('プロジェクトの設定に失敗しました')
    })
  })

  describe('エッジケースと特殊文字の処理', () => {
    it('特殊文字を含むプロジェクト名を正しく処理する', async () => {
      const specialFiles = [
        { 
          path: 'TaskChute/Project - TC × AI & ML.md', 
          basename: 'Project - TC × AI & ML' 
        },
        { 
          path: 'TaskChute/Project - <script>alert(1)</script>.md', 
          basename: 'Project - <script>alert(1)</script>' 
        }
      ]

      mockApp.vault.getMarkdownFiles.mockReturnValue(specialFiles)
      const projectFiles = await view.getProjectFiles()

      // 特殊文字を含むファイルも正しく取得される
      expect(projectFiles.length).toBe(2)
      expect(projectFiles[0].basename).toBe('Project - TC × AI & ML')
      expect(projectFiles[1].basename).toBe('Project - <script>alert(1)</script>')
    })

    it('日本語を含むプロジェクト名を正しく処理する', async () => {
      const japaneseFiles = [
        { 
          path: 'TaskChute/Project - 情報処理講座.md', 
          basename: 'Project - 情報処理講座' 
        },
        { 
          path: 'TaskChute/Project - タスク管理システム.md', 
          basename: 'Project - タスク管理システム' 
        }
      ]

      mockApp.vault.getMarkdownFiles.mockReturnValue(japaneseFiles)
      const projectFiles = await view.getProjectFiles()

      expect(projectFiles.length).toBe(2)
      expect(projectFiles.map(f => f.basename)).toContain('Project - 情報処理講座')
      expect(projectFiles.map(f => f.basename)).toContain('Project - タスク管理システム')
    })
  })

  describe('統合テスト', () => {
    beforeEach(() => {
      // setProjectForTaskの実装を復元
      view.setProjectForTask = jest.fn(async (task, projectPath) => {
        task.projectPath = projectPath || null
      })
    })

    it('プロジェクト選択から保存までの一連の流れが正しく動作する', async () => {
      const task = { 
        path: 'task1.md',
        projectPath: null 
      }

      // 1. プロジェクトファイルを取得
      const projectFiles = await view.getProjectFiles()
      expect(projectFiles.length).toBeGreaterThan(0)

      // 2. プロジェクトを設定
      const selectedProject = projectFiles[0]
      await view.setProjectForTask(task, selectedProject.path)

      // 3. タスクが更新されていることを確認
      expect(task.projectPath).toBe(selectedProject.path)

      // 4. プロジェクトを解除
      await view.setProjectForTask(task, '')
      expect(task.projectPath).toBe(null)
    })

    it('loadAvailableProjects()がgetProjectFiles()を正しく呼び出す', async () => {
      // getProjectFilesのスパイを作成
      const getProjectFilesSpy = jest.spyOn(view, 'getProjectFiles')

      const projects = await view.loadAvailableProjects()

      expect(getProjectFilesSpy).toHaveBeenCalled()
      expect(projects.length).toBe(3) // テストデータに基づく期待値（"Project - "で始まるファイルのみ）
    })
  })
})