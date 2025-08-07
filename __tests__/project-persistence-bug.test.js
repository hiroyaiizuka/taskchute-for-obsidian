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

// Obsidianのモック
const mockObsidian = {
  ItemView: class ItemView {
    constructor(leaf) {
      this.leaf = leaf
      this.app = mockObsidian.app
    }
  },
  Plugin: class Plugin {},
  Notice: jest.fn((msg) => console.log(`Notice: ${msg}`)),
  TFile: class TFile {
    constructor(path, name) {
      this.path = path
      this.basename = name
    }
  },
  app: {
    vault: {
      adapter: {
        exists: jest.fn(),
        read: jest.fn(),
        write: jest.fn(),
        mkdir: jest.fn(),
        getFullPath: jest.fn((path) => `/mock/path/${path}`),
      },
      getAbstractFileByPath: jest.fn(),
      read: jest.fn(),
      modify: jest.fn(),
      create: jest.fn(),
      getMarkdownFiles: jest.fn(() => []),
    },
    workspace: {
      onLayoutReady: jest.fn(),
    },
    fileManager: {
      processFrontMatter: jest.fn(),
    },
    metadataCache: {
      getFileCache: jest.fn(),
    },
  },
}

// グローバルにモックを設定
global.require = (name) => {
  if (name === "obsidian") return mockObsidian
  if (name === "fs") return mockFileSystem
  return {}
}

// ファイルシステムのモック
const mockFileSystem = {
  statSync: jest.fn((path) => ({
    birthtime: new Date("2024-01-15T10:00:00"),
  })),
}

describe("プロジェクト設定の永続化バグ", () => {
  let taskChuteView
  let mockVaultAdapter
  let mockFileManager
  let mockMetadataCache

  beforeEach(() => {
    // モックのリセット
    jest.clearAllMocks()

    mockVaultAdapter = mockObsidian.app.vault.adapter
    mockFileManager = mockObsidian.app.fileManager
    mockMetadataCache = mockObsidian.app.metadataCache

    // TaskChuteViewのインスタンス作成
    const mockLeaf = { view: null }
    // プラグインのモック（PathManagerを含む）
    const mockPlugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue('TaskChute/Task'),
        getProjectFolderPath: jest.fn().mockReturnValue('TaskChute/Project'),
        getLogDataPath: jest.fn().mockReturnValue('TaskChute/Log')
      },
      routineAliasManager: {
        getAliases: jest.fn(() => []),
        findCurrentName: jest.fn(),
        addAlias: jest.fn()
      }
    }

    taskChuteView = new TaskChuteView(mockLeaf, mockPlugin)
    
    // appプロパティを設定
    taskChuteView.app = mockObsidian.app

    // 必要なプロパティを初期化
    taskChuteView.taskInstances = []
    taskChuteView.tasks = []
    
    // taskListのモック（emptyメソッドを含む）
    taskChuteView.taskList = {
      empty: jest.fn(),
      append: jest.fn(),
      find: jest.fn(() => ({ length: 0 })),
    }

    // DOM操作を避けるためのモック
    taskChuteView.renderTaskList = jest.fn()
    taskChuteView.ensureFrontMatter = jest.fn().mockResolvedValue()
    taskChuteView.restoreRunningTaskState = jest.fn()
    taskChuteView.initializeTaskOrders = jest.fn()
    taskChuteView.moveIdleTasksToCurrentSlot = jest.fn()
    taskChuteView.sortTaskInstancesByTimeOrder = jest.fn()
    taskChuteView.cleanupOldStorageKeys = jest.fn()
    taskChuteView.loadTodayExecutions = jest.fn().mockResolvedValue([])
    taskChuteView.getTaskFiles = jest.fn().mockResolvedValue([])
    taskChuteView.isRunningTaskStartedToday = jest.fn().mockResolvedValue(false)
  })

  describe("プロジェクト設定の保存と翌日の読み込み", () => {
    test("プロジェクト設定が翌日に正しく引き継がれることを確認（バグ修正済み）", async () => {
      // === 1. プロジェクトファイルの設定 ===
      const projectFile = {
        path: "TaskChute/Project/開発プロジェクト.md",
        basename: "開発プロジェクト",
      }

      const taskFile = {
        path: "TaskChute/Task/テストタスク.md",
        basename: "テストタスク",
      }

      // getAbstractFileByPathのモック
      mockObsidian.app.vault.getAbstractFileByPath.mockImplementation(
        (path) => {
          if (path === projectFile.path) return projectFile
          if (path === taskFile.path) return taskFile
          return null
        },
      )

      // === 2. 今日（1月15日）にプロジェクト設定を行う ===
      taskChuteView.currentDate = new Date(2024, 0, 15) // 2024-01-15

      const task = {
        title: "テストタスク",
        path: taskFile.path,
        file: taskFile,
        projectPath: null, // 最初は設定なし
        projectTitle: null,
      }

      // processFrontMatterのモック（プロジェクト設定時の動作）
      let savedFrontmatter = {}
      mockFileManager.processFrontMatter.mockImplementation(
        (file, callback) => {
          // 初期状態のfrontmatterを渡す
          const initialFrontmatter = {}
          savedFrontmatter = callback(initialFrontmatter)
          return Promise.resolve()
        },
      )

      console.log("=== 今日（1月15日）にプロジェクト設定 ===")

      // プロジェクト設定を実行
      await taskChuteView.setProjectForTask(task, projectFile.path)

      console.log("保存されたfrontmatter:", savedFrontmatter)

      // 保存内容を確認
      expect(savedFrontmatter.project).toBe("[[開発プロジェクト]]")
      expect(savedFrontmatter.project_path).toBeUndefined() // 削除されている

      // タスクオブジェクトが更新されていることを確認
      expect(task.projectPath).toBe(projectFile.path)
      expect(task.projectTitle).toBe("開発プロジェクト")

      // === 3. 翌日（1月16日）にタスクを読み込む ===
      console.log("=== 翌日（1月16日）にタスクを読み込み ===")

      taskChuteView.currentDate = new Date(2024, 0, 16) // 2024-01-16

      // getTaskFilesのモック
      taskChuteView.getTaskFiles.mockResolvedValue([taskFile])

      // getAbstractFileByPathのモック
      mockObsidian.app.vault.getAbstractFileByPath.mockImplementation(
        (path) => {
          if (path === projectFile.path) return projectFile
          if (path === taskFile.path) return taskFile
          return null
        },
      )

      // ファイル読み込みのモック
      mockObsidian.app.vault.read.mockResolvedValue(`---
routine: false
target_date: "2024-01-16"
project: "[[開発プロジェクト]]"
---

# テストタスク

#task
`)

      // メタデータキャッシュのモック（翌日の読み込み時）
      mockMetadataCache.getFileCache.mockReturnValue({
        frontmatter: {
          routine: false,
          target_date: "2024-01-16", // 翌日の日付に設定
          project: "[[開発プロジェクト]]",
          // project_path は存在しない（削除されている）
        },
      })

      // loadTodayExecutionsのモック
      // mockAppは定義されていないので、既に定義済みのモックを使用

      // タスクを読み込み
      await taskChuteView.loadTasks()

      console.log("読み込まれたタスク:", taskChuteView.tasks)

      // === 4. バグの確認：projectPathがnullになっている ===
      expect(taskChuteView.tasks).toHaveLength(1)
      const loadedTask = taskChuteView.tasks[0]

      console.log("読み込み後のプロジェクト情報:")
      console.log("  - projectPath:", loadedTask.projectPath) // 修正済み：正しく復元される
      console.log("  - projectTitle:", loadedTask.projectTitle) // これは正常

      // 修正確認：プロジェクト設定が正しく引き継がれている
      expect(loadedTask.projectPath).toBe(projectFile.path) // 修正により復元される
      expect(loadedTask.projectTitle).toBe("開発プロジェクト") // これも正常

      console.log("✅ バグは修正済み：プロジェクト設定が翌日に正しく引き継がれています")
    })

    test("修正後：プロジェクト設定が翌日に正しく引き継がれることを確認", async () => {
      // === 1. プロジェクトファイルの設定 ===
      const projectFile = {
        path: "TaskChute/Project/修正テストプロジェクト.md",
        basename: "修正テストプロジェクト",
      }

      const taskFile = {
        path: "TaskChute/Task/修正テストタスク.md",
        basename: "修正テストタスク",
      }

      // === 2. 翌日にタスクを読み込む（修正後の動作確認）===
      taskChuteView.currentDate = new Date(2024, 0, 16) // 2024-01-16

      // getTaskFilesのモック
      taskChuteView.getTaskFiles.mockResolvedValue([taskFile])

      // getAbstractFileByPathのモック（修正されたロジックをテスト）
      mockObsidian.app.vault.getAbstractFileByPath.mockImplementation(
        (path) => {
          if (path === projectFile.path) return projectFile // プロジェクトファイルは存在
          if (path === taskFile.path) return taskFile
          return null
        },
      )

      // ファイル読み込みのモック
      mockObsidian.app.vault.read.mockResolvedValue(`---
routine: false
target_date: "2024-01-16"
project: "[[修正テストプロジェクト]]"
---

# 修正テストタスク

#task
`)

      // メタデータキャッシュのモック（project_pathは存在しない）
      mockMetadataCache.getFileCache.mockReturnValue({
        frontmatter: {
          routine: false,
          target_date: "2024-01-16", // 翌日の日付に設定
          project: "[[修正テストプロジェクト]]",
          // project_path は存在しない（削除されている）
        },
      })

      // loadTodayExecutionsのモック
      // mockAppは定義されていないので、既に定義済みのモックを使用

      // タスクを読み込み
      await taskChuteView.loadTasks()

      console.log("修正後の読み込まれたタスク:", taskChuteView.tasks)

      // === 3. 修正確認：projectPathが正しく復元される ===
      expect(taskChuteView.tasks).toHaveLength(1)
      const loadedTask = taskChuteView.tasks[0]

      console.log("修正後のプロジェクト情報:")
      console.log("  - projectPath:", loadedTask.projectPath) // 正しく復元される
      console.log("  - projectTitle:", loadedTask.projectTitle) // 正しく読み込まれる

      // 修正確認：プロジェクト情報が正しく復元される
      expect(loadedTask.projectPath).toBe(projectFile.path) // 修正により復元される
      expect(loadedTask.projectTitle).toBe("修正テストプロジェクト") // これも正常
    })

    test("現在のloadTasks処理でのプロジェクト情報読み込み動作を確認", () => {
      // 実際のfrontmatterデータ
      const metadata = {
        routine: false,
        target_date: "2024-01-15",
        project: "[[開発プロジェクト]]",
        // project_path は存在しない（保存時に削除されている）
      }

      // 現在のloadTasks内の処理をシミュレート
      let projectPath = null
      let projectTitle = null

      if (metadata) {
        projectPath = metadata.project_path || null // ← これがnullになる
        // projectフィールドからプロジェクト名を抽出（[[Project名]]形式）
        if (metadata.project) {
          const projectMatch = metadata.project.match(/\[\[([^\]]+)\]\]/)
          if (projectMatch) {
            projectTitle = projectMatch[1] // ← これは正しく取得される
          }
        }
      }

      console.log("現在の処理結果:")
      console.log("  - projectPath:", projectPath) // null（バグ）
      console.log("  - projectTitle:", projectTitle) // "開発プロジェクト"（正常）

      // バグの確認
      expect(projectPath).toBeNull() // project_pathが存在しないため
      expect(projectTitle).toBe("開発プロジェクト") // projectから正しく抽出される
    })
  })

  describe("期待される正しい動作の仕様", () => {
    test("プロジェクト設定が翌日にも引き継がれるべき仕様", () => {
      // 修正すべき処理：projectフィールドからprojectPathを復元する
      const metadata = {
        routine: false,
        target_date: "2024-01-15",
        project: "[[開発プロジェクト]]",
        // project_path は存在しない
      }

      // 期待される修正後の処理
      let projectPath = null
      let projectTitle = null

      if (metadata) {
        // 1. 既存のproject_pathがあればそれを使用（後方互換性）
        projectPath = metadata.project_path || null

        // 2. projectフィールドからプロジェクト名とパスを取得
        if (metadata.project) {
          const projectMatch = metadata.project.match(/\[\[([^\]]+)\]\]/)
          if (projectMatch) {
            projectTitle = projectMatch[1]

            // 3. project_pathがない場合は、プロジェクト名からパスを推測
            if (!projectPath && projectTitle) {
              projectPath = `TaskChute/Project/${projectTitle}.md`
            }
          }
        }
      }

      console.log("期待される修正後の結果:")
      console.log("  - projectPath:", projectPath) // "TaskChute/Project/開発プロジェクト.md"
      console.log("  - projectTitle:", projectTitle) // "開発プロジェクト"

      // 修正後の期待値
      expect(projectPath).toBe("TaskChute/Project/開発プロジェクト.md")
      expect(projectTitle).toBe("開発プロジェクト")
    })

    test("修正後のプロジェクトパス復元ロジックをテスト", () => {
      // 修正後のロジックをシミュレート
      const metadata = {
        project: "[[実在するプロジェクト]]",
        // project_path は存在しない
      }

      // モックファイルシステム
      const mockFiles = [
        {
          basename: "実在するプロジェクト",
          path: "TaskChute/Project/実在するプロジェクト.md",
        },
        { basename: "別のプロジェクト", path: "Project/別のプロジェクト.md" },
      ]

      let projectPath = null
      let projectTitle = null

      if (metadata) {
        // 後方互換性のため、まずproject_pathをチェック
        projectPath = metadata.project_path || null

        // projectフィールドからプロジェクト名を抽出
        if (metadata.project) {
          const projectMatch = metadata.project.match(/\[\[([^\]]+)\]\]/)
          if (projectMatch) {
            projectTitle = projectMatch[1]

            // project_pathがない場合は、プロジェクト名からパスを復元
            if (!projectPath && projectTitle) {
              // まず規約通りのパスをチェック
              const reconstructedPath = `TaskChute/Project/${projectTitle}.md`
              const projectFile = mockFiles.find(
                (f) => f.path === reconstructedPath,
              )
              if (projectFile) {
                projectPath = reconstructedPath
              } else {
                // 規約通りの場所にない場合は、全プロジェクトファイルから検索
                const matchingProject = mockFiles.find(
                  (file) =>
                    file.basename === projectTitle &&
                    (file.path.includes("Project") ||
                      file.path.includes("project")),
                )
                if (matchingProject) {
                  projectPath = matchingProject.path
                }
              }
            }
          }
        }
      }

      console.log("修正後のロジック結果:")
      console.log("  - projectPath:", projectPath)
      console.log("  - projectTitle:", projectTitle)

      // 修正後の期待される動作
      expect(projectPath).toBe("TaskChute/Project/実在するプロジェクト.md")
      expect(projectTitle).toBe("実在するプロジェクト")
    })
  })
})
