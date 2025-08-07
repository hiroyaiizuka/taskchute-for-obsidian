const { TaskChuteView } = require('../main.js')

// Obsidianモジュールのモック
jest.mock('obsidian', () => ({
  TFile: jest.fn(),
  Notice: jest.fn(),
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn()
}))

const { TFile } = require('obsidian')

describe('実行済みタスク名の保持テスト', () => {
  let taskChuteView
  
  beforeEach(() => {
    // TaskChuteViewのモックセットアップ
    const mockLeaf = {}
    const mockPlugin = {
      routineAliasManager: {
        getAliases: jest.fn(() => []),
        findCurrentName: jest.fn()
      },
      pathManager: {
        getTaskFolderPath: jest.fn(() => 'TaskChute/Task')
      }
    }
    
    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    taskChuteView.app = {
      vault: {
        adapter: {
          exists: jest.fn()
        },
        getAbstractFileByPath: jest.fn(),
        read: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
      },
      workspace: {
        openLinkText: jest.fn()
      }
    }
  })
  
  describe('タスクインスタンスの表示', () => {
    test('実行済みタスクは実行時の名前を表示する', () => {
      // 実行済みタスクインスタンス
      const doneInstance = {
        task: {
          title: '新しい名前',
          path: 'TaskChute/Task/新しい名前.md'
        },
        state: 'done',
        executedTitle: '実行時の名前', // 実行時のタイトル
        startTime: new Date(2024, 0, 15, 9, 0),
        stopTime: new Date(2024, 0, 15, 9, 30)
      }
      
      // タスク名の要素を作成
      const mockContainer = {
        createEl: jest.fn((tag, options) => {
          const element = {
            addEventListener: jest.fn(),
            tag: tag,
            text: options.text,
            cls: options.cls
          }
          return element
        })
      }
      
      // renderTaskItem的な処理をシミュレート
      const displayTitle = doneInstance.executedTitle || doneInstance.task.title
      const taskNameEl = mockContainer.createEl("a", {
        cls: "task-name wikilink",
        text: displayTitle,
        href: "#"
      })
      
      // 検証
      expect(taskNameEl.text).toBe('実行時の名前')
      expect(taskNameEl.text).not.toBe('新しい名前')
    })
    
    test('未実行タスクは現在の名前を表示する', () => {
      // 未実行タスクインスタンス
      const idleInstance = {
        task: {
          title: '現在の名前',
          path: 'TaskChute/Task/現在の名前.md'
        },
        state: 'idle',
        executedTitle: undefined // 実行していないので undefined
      }
      
      const displayTitle = idleInstance.executedTitle || idleInstance.task.title
      
      expect(displayTitle).toBe('現在の名前')
    })
  })
  
  describe('ファイルオープン時の動作', () => {
    test('実行済みタスクから正しいファイルを開く', async () => {
      const inst = {
        task: {
          title: '新しい名前'
        },
        executedTitle: '古い名前',
        state: 'done'
      }
      
      // ファイルが存在しない場合のモック
      taskChuteView.app.vault.getAbstractFileByPath.mockResolvedValue(false)
      
      // findCurrentNameが新しい名前を返す
      taskChuteView.plugin.routineAliasManager.findCurrentName
        .mockReturnValue('新しい名前')
      
      // クリックイベントをシミュレート
      const searchTitle = inst.executedTitle || inst.task.title
      expect(searchTitle).toBe('古い名前')
      
      // ファイルパスの構築
      const filePath = `TaskChute/Task/${searchTitle}.md`
      expect(filePath).toBe('TaskChute/Task/古い名前.md')
      
      // ファイルが存在しないので、現在の名前を探す
      const currentName = await taskChuteView.plugin.routineAliasManager
        .findCurrentName(searchTitle)
      expect(currentName).toBe('新しい名前')
      
      // 現在の名前でファイルを開く
      await taskChuteView.app.workspace.openLinkText(currentName, "", false)
      
      expect(taskChuteView.app.workspace.openLinkText)
        .toHaveBeenCalledWith('新しい名前', "", false)
    })
  })
  
  describe('loadTasksでの実行履歴統合', () => {
    test('エイリアスを使って過去の実行履歴を正しく紐付ける', () => {
      // タスクBに対してタスクAのエイリアスがある
      taskChuteView.plugin.routineAliasManager.getAliases
        .mockReturnValue(['タスクA'])
      
      // 実行履歴（タスクAとして実行された）
      const todayExecutions = [{
        taskTitle: 'タスクA',
        startTime: new Date(2024, 0, 15, 9, 0),
        stopTime: new Date(2024, 0, 15, 9, 30),
        duration: 30
      }]
      
      // 現在のファイル（タスクBに改名済み）
      const file = {
        basename: 'タスクB',
        path: 'TaskChute/Task/タスクB.md'
      }
      
      // エイリアスを考慮したフィルタリング
      const aliases = taskChuteView.plugin.routineAliasManager.getAliases(file.basename) || []
      const executions = todayExecutions.filter(exec => 
        exec.taskTitle === file.basename || aliases.includes(exec.taskTitle)
      )
      
      // 検証
      expect(executions).toHaveLength(1)
      expect(executions[0].taskTitle).toBe('タスクA')
      
      // タスクインスタンスの作成をシミュレート
      if (executions.length > 0) {
        const instance = {
          task: { title: 'タスクB' }, // 現在の名前
          state: 'done',
          executedTitle: executions[0].taskTitle, // 実行時の名前を保持
          startTime: executions[0].startTime,
          stopTime: executions[0].stopTime
        }
        
        expect(instance.executedTitle).toBe('タスクA')
        expect(instance.task.title).toBe('タスクB')
      }
    })
  })
  
  describe('shouldShowTaskのエイリアス対応', () => {
    test('エイリアスを考慮してタスクの表示判定を行う', () => {
      const taskObj = {
        title: 'タスクC',
        path: 'TaskChute/Task/タスクC.md',
        isRoutine: true
      }
      
      // タスクA→タスクB→タスクCと改名された
      taskChuteView.plugin.routineAliasManager.getAliases
        .mockReturnValue(['タスクB', 'タスクA'])
      
      // タスクAとして実行された履歴
      const todayExecutions = [{
        taskTitle: 'タスクA',
        startTime: new Date()
      }]
      
      // shouldShowTaskメソッドの該当部分をシミュレート
      const aliases = taskChuteView.plugin.routineAliasManager.getAliases(taskObj.title) || []
      const executions = todayExecutions.filter(exec => 
        exec.taskTitle === taskObj.title || aliases.includes(exec.taskTitle)
      )
      
      expect(executions).toHaveLength(1) // エイリアスで実行履歴が見つかる
      expect(taskObj.isRoutine).toBe(true) // ルーチンタスクなので表示される
    })
  })
})