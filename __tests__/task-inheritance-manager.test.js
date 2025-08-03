require("../__mocks__/obsidian")

// グローバルにTFileを定義
global.TFile = class TFile {}
global.TFolder = class TFolder {}

// TaskInheritanceManagerクラスを取得するためのヘルパー
function getTaskInheritanceManagerClass() {
  const fs = require("fs")
  const path = require("path")
  const mainCode = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8")
  
  // TaskInheritanceManagerクラスの定義を抽出
  const classMatch = mainCode.match(/class TaskInheritanceManager[\s\S]+?(?=\nclass\s|\n\/\/\s*End of file|$)/)
  if (!classMatch) {
    throw new Error("TaskInheritanceManager class not found")
  }
  
  // クラスを評価して返す
  const TaskInheritanceManager = eval(`(function() { return ${classMatch[0]}; })()`)
  return TaskInheritanceManager
}

describe("TaskInheritanceManager", () => {
  let plugin
  let inheritanceManager
  let TaskInheritanceManager
  let mockApp
  let mockFile
  let mockMetadata

  beforeEach(() => {
    // モックプラグインを作成
    plugin = {
      pathManager: {
        getTaskFolderPath: jest.fn().mockReturnValue("TaskChute/Task")
      }
    }
    
    // mockFileの設定
    mockFile = Object.create(global.TFile.prototype)
    mockFile.path = "TaskChute/Task/テストタスク.md"
    mockFile.basename = "テストタスク"
    mockFile.extension = "md"
    
    // mockMetadataの設定
    mockMetadata = {
      frontmatter: {
        project: "TaskChute/Project/テストプロジェクト.md",
        isRoutine: true,
        routineStart: "09:00",
        routineEnd: "10:00",
        routineType: "daily",
        weekday: 1
      }
    }
    
    // mockAppの設定
    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn(),
        read: jest.fn()
      },
      metadataCache: {
        getFileCache: jest.fn()
      }
    }
    
    plugin.app = mockApp
    
    // クラスを取得してインスタンスを作成
    TaskInheritanceManager = getTaskInheritanceManagerClass()
    inheritanceManager = new TaskInheritanceManager(plugin)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe("findExistingTask", () => {
    test("既存タスクが見つかった場合、タスク情報を返す", async () => {
      const content = `---
project: "TaskChute/Project/テストプロジェクト.md"
isRoutine: true
routineStart: "09:00"
routineEnd: "10:00"
---

#task

これはタスクの説明です。
複数行の説明も可能です。`

      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.metadataCache.getFileCache.mockReturnValue(mockMetadata)
      mockApp.vault.read.mockResolvedValue(content)
      
      const result = await inheritanceManager.findExistingTask("テストタスク")
      
      expect(result).not.toBeNull()
      expect(result.file).toBe(mockFile)
      expect(result.metadata).toEqual(mockMetadata.frontmatter)
      expect(result.inheritableData.project).toBe("TaskChute/Project/テストプロジェクト.md")
      expect(result.inheritableData.isRoutine).toBe(true)
      expect(result.inheritableData.description).toBe("これはタスクの説明です。\n複数行の説明も可能です。")
    })

    test("タスクが見つからない場合、nullを返す", async () => {
      mockApp.vault.getAbstractFileByPath.mockReturnValue(null)
      
      const result = await inheritanceManager.findExistingTask("存在しないタスク")
      
      expect(result).toBeNull()
    })

    test("メタデータがない場合でも動作する", async () => {
      const content = `#task

説明のみのタスク`

      mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile)
      mockApp.metadataCache.getFileCache.mockReturnValue({})
      mockApp.vault.read.mockResolvedValue(content)
      
      const result = await inheritanceManager.findExistingTask("テストタスク")
      
      expect(result).not.toBeNull()
      expect(result.inheritableData.project).toBeNull()
      expect(result.inheritableData.isRoutine).toBe(false)
      expect(result.inheritableData.description).toBe("説明のみのタスク")
    })
  })

  describe("extractDescription", () => {
    test("フロントマターと#taskタグを除外して説明文を抽出する", () => {
      const content = `---
project: "test"
---

#task

これは説明文です。
複数行にわたる
説明も含みます。`

      const result = inheritanceManager.extractDescription(content)
      
      expect(result).toBe("これは説明文です。\n複数行にわたる\n説明も含みます。")
    })

    test("フロントマターがない場合も動作する", () => {
      const content = `#task

シンプルな説明文`

      const result = inheritanceManager.extractDescription(content)
      
      expect(result).toBe("シンプルな説明文")
    })

    test("説明文がない場合は空文字を返す", () => {
      const content = `---
project: "test"
---

#task`

      const result = inheritanceManager.extractDescription(content)
      
      expect(result).toBe("")
    })

    test("空行は除外される", () => {
      const content = `#task

最初の行

中間に空行

最後の行`

      const result = inheritanceManager.extractDescription(content)
      
      expect(result).toBe("最初の行\n中間に空行\n最後の行")
    })
  })
})