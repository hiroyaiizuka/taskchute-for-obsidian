const { Plugin, ItemView, WorkspaceLeaf, TFile, Notice, PluginSettingTab, Setting } = require("obsidian")

const VIEW_TYPE_TASKCHUTE = "taskchute-view"

// PathManager class for managing file paths
class PathManager {
  constructor(plugin) {
    this.plugin = plugin
  }
  
  // デフォルトパスの定義
  static DEFAULT_PATHS = {
    taskFolder: "TaskChute/Task",
    projectFolder: "TaskChute/Project",
    logData: "TaskChute/Log"
  }
  
  // 設定されたパスを取得（設定がない場合はデフォルト）
  getTaskFolderPath() {
    return this.plugin.settings.taskFolderPath || PathManager.DEFAULT_PATHS.taskFolder
  }
  
  getProjectFolderPath() {
    return this.plugin.settings.projectFolderPath || PathManager.DEFAULT_PATHS.projectFolder
  }
  
  getLogDataPath() {
    return this.plugin.settings.logDataPath || PathManager.DEFAULT_PATHS.logData
  }
  
  // パスの検証
  validatePath(path) {
    // 絶対パスのチェック
    if (path.startsWith('/') || path.match(/^[A-Za-z]:\\/)) {
      return { valid: false, error: "絶対パスは使用できません" }
    }
    
    // 危険な文字のチェック
    if (path.includes('..')) {
      return { valid: false, error: "パスに'..'を含めることはできません" }
    }
    
    // 特殊文字のチェック
    if (path.match(/[<>"|?*]/)) {
      return { valid: false, error: "パスに特殊文字を含めることはできません" }
    }
    
    return { valid: true }
  }
  
  // フォルダの自動作成
  async ensureFolderExists(path) {
    const folder = this.plugin.app.vault.getAbstractFileByPath(path)
    if (!folder) {
      try {
        await this.plugin.app.vault.createFolder(path)
      } catch (error) {
        console.error(`フォルダの作成に失敗しました: ${path}`, error)
        throw error
      }
    }
  }
}

// NavigationState class for managing navigation panel state
class NavigationState {
  constructor() {
    this.isVisible = false
    this.activeSection = null
  }

  toggle() {
    this.isVisible = !this.isVisible
  }

  setActiveSection(section) {
    this.activeSection = section
  }
}

// TaskNameAutocomplete class for task name suggestions
class TaskNameAutocomplete {
  constructor(plugin, inputElement, containerElement) {
    this.plugin = plugin
    this.inputElement = inputElement
    this.containerElement = containerElement
    this.taskNames = []
    this.selectedIndex = -1
    this.suggestionsElement = null
    this.debounceTimer = null
    this.isVisible = false
    this.fileEventRefs = []
  }

  async initialize() {
    await this.loadTaskNames()
    this.setupEventListeners()
    this.setupFileEventListeners()
  }

  async loadTaskNames() {
    // TASK-002: タスク名の読み込み機能を実装
    const { TFolder, TFile } = require("obsidian")
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    const taskFolder = this.plugin.app.vault.getAbstractFileByPath(taskFolderPath)
    
    if (!taskFolder || !(taskFolder instanceof TFolder)) {
      console.log("[TaskChute] Taskフォルダが見つかりません")
      return
    }

    const files = taskFolder.children.filter(f => f instanceof TFile && f.extension === "md")
    
    this.taskNames = files.map(file => file.basename)
    
    console.log(`[TaskChute] ${this.taskNames.length}個のタスク名をロードしました`)
  }

  searchTasks(query) {
    // TASK-003: 検索アルゴリズムの実装
    if (!query || query.length < 1) return []
    
    const lowerQuery = query.toLowerCase()
    
    // スコアリング関数
    const scoredResults = this.taskNames
      .map(name => {
        const lowerName = name.toLowerCase()
        let score = 0
        
        // 完全一致
        if (lowerName === lowerQuery) score = 1000
        // 前方一致
        else if (lowerName.startsWith(lowerQuery)) score = 100
        // 部分一致
        else if (lowerName.includes(lowerQuery)) score = 10
        // 一致なし
        else return null
        
        return { name, score }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5) // 最大5件
    
    return scoredResults.map(r => r.name)
  }

  setupEventListeners() {
    // TASK-007: 入力イベントの処理を実装
    this.inputElement.addEventListener("input", (e) => {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        const query = e.target.value.trim()
        const suggestions = this.searchTasks(query)
        this.showSuggestions(suggestions)
      }, 150) // 150msデバウンス
    })

    // キーボードイベント
    this.inputElement.addEventListener("keydown", (e) => {
      // サジェストが表示されている場合のみナビゲーション処理
      if (this.isVisible && (e.key === "ArrowDown" || e.key === "ArrowUp" || 
          (e.key === "Enter" && this.selectedIndex >= 0) || e.key === "Escape")) {
        this.handleKeyNavigation(e)
      }
    })

    // TASK-009: フォーカス管理の実装
    this.inputElement.addEventListener("blur", (e) => {
      // クリックによるフォーカス移動の場合、少し遅延させる
      setTimeout(() => {
        // サジェスト要素がクリックされた場合は非表示にしない
        if (!this.suggestionsElement?.contains(document.activeElement)) {
          this.hideSuggestions()
        }
      }, 200)
    })

    // ウィンドウのリサイズやスクロールでサジェストを非表示
    window.addEventListener("resize", () => this.hideSuggestions())
    window.addEventListener("scroll", () => this.hideSuggestions(), true)
  }
  
  setupFileEventListeners() {
    // TASK-011: ファイルイベントへの対応
    const { TFile } = require("obsidian")
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    
    // ファイル作成時
    const createRef = this.plugin.app.vault.on("create", async (file) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath) && file.extension === "md") {
        console.log(`[TaskChute] 新規タスクファイルが作成されました: ${file.path}`)
        await this.loadTaskNames()
      }
    })
    this.fileEventRefs.push(createRef)
    
    // ファイル削除時
    const deleteRef = this.plugin.app.vault.on("delete", async (file) => {
      if (file instanceof TFile && file.path.startsWith(taskFolderPath) && file.extension === "md") {
        console.log(`[TaskChute] タスクファイルが削除されました: ${file.path}`)
        await this.loadTaskNames()
      }
    })
    this.fileEventRefs.push(deleteRef)
    
    // ファイルリネーム時
    const renameRef = this.plugin.app.vault.on("rename", async (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") {
        if (file.path.startsWith(taskFolderPath) || oldPath.startsWith(taskFolderPath)) {
          console.log(`[TaskChute] タスクファイルがリネームされました: ${oldPath} → ${file.path}`)
          await this.loadTaskNames()
        }
      }
    })
    this.fileEventRefs.push(renameRef)
  }
  
  cleanup() {
    // イベントリスナーのクリーンアップ
    this.fileEventRefs.forEach(ref => this.plugin.app.vault.offref(ref))
    this.fileEventRefs = []
    clearTimeout(this.debounceTimer)
    this.hideSuggestions()
  }

  showSuggestions(suggestions) {
    // TASK-004: サジェストUIの基本構造を実装
    if (!suggestions || suggestions.length === 0) {
      this.hideSuggestions()
      return
    }

    // 既存のサジェスト要素があれば削除
    if (this.suggestionsElement) {
      this.suggestionsElement.remove()
    }

    // サジェスト要素を作成
    this.suggestionsElement = document.createElement("div")
    this.suggestionsElement.className = "task-name-suggestions"
    
    // 各候補を追加
    suggestions.forEach((suggestion, index) => {
      const item = document.createElement("div")
      item.className = "suggestion-item"
      item.textContent = suggestion
      item.setAttribute("data-index", index)
      
      // TASK-005: マウス操作のイベント処理
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = index
        this.updateSelection(this.suggestionsElement.querySelectorAll(".suggestion-item"))
      })
      
      item.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.selectSuggestion(suggestion)
      })
      
      this.suggestionsElement.appendChild(item)
    })

    // 入力フィールドの位置を取得して配置
    const rect = this.inputElement.getBoundingClientRect()
    this.suggestionsElement.style.position = "absolute"
    this.suggestionsElement.style.top = `${rect.bottom + 2}px`
    this.suggestionsElement.style.left = `${rect.left}px`
    this.suggestionsElement.style.width = `${rect.width}px`
    
    // DOMに追加
    document.body.appendChild(this.suggestionsElement)
    this.isVisible = true
    this.selectedIndex = -1
  }

  hideSuggestions() {
    if (this.suggestionsElement) {
      this.suggestionsElement.remove()
      this.suggestionsElement = null
      this.isVisible = false
      this.selectedIndex = -1
    }
  }

  handleKeyNavigation(e) {
    // TASK-006: キーボードナビゲーションの実装
    if (!this.isVisible || !this.suggestionsElement) return

    const items = this.suggestionsElement.querySelectorAll(".suggestion-item")
    if (items.length === 0) return

    switch(e.key) {
      case "ArrowDown":
        e.preventDefault()
        this.selectedIndex = Math.min(this.selectedIndex + 1, items.length - 1)
        this.updateSelection(items)
        break
        
      case "ArrowUp":
        e.preventDefault()
        this.selectedIndex = Math.max(this.selectedIndex - 1, -1)
        this.updateSelection(items)
        break
        
      case "Enter":
        if (this.selectedIndex >= 0 && items[this.selectedIndex]) {
          e.preventDefault()
          e.stopPropagation()
          this.selectSuggestion(items[this.selectedIndex].textContent)
        }
        break
        
      case "Escape":
        e.preventDefault()
        this.hideSuggestions()
        break
    }
  }

  selectSuggestion(taskName) {
    // 既存の検証ロジックを適用
    const validation = this.plugin.TaskNameValidator.validate(taskName)
    if (!validation.isValid) {
      new Notice("このタスク名には使用できない文字が含まれています")
      return
    }
    
    this.inputElement.value = taskName
    this.hideSuggestions()
    
    // 入力イベントを発火して検証UIを更新
    this.inputElement.dispatchEvent(new Event("input", { bubbles: true }))
  }

  updateSelection(items) {
    items.forEach((item, index) => {
      if (index === this.selectedIndex) {
        item.classList.add("suggestion-item-selected")
      } else {
        item.classList.remove("suggestion-item-selected")
      }
    })
  }
}

class TaskChuteView extends ItemView {
  // タスク名検証ユーティリティ
  TaskNameValidator = {
    // 禁止文字のパターン
    INVALID_CHARS_PATTERN: /[:|\/\\#^]/g,
    
    // 検証メソッド
    validate(taskName) {
      const invalidChars = taskName.match(this.INVALID_CHARS_PATTERN);
      return {
        isValid: !invalidChars,
        invalidChars: invalidChars ? [...new Set(invalidChars)] : []
      };
    },
    
    // エラーメッセージ生成
    getErrorMessage(invalidChars) {
      return `使用できない文字が含まれています: ${invalidChars.join(', ')}`;
    }
  };
  
  // 現在の日付文字列を取得するヘルパーメソッド
  getCurrentDateString() {
    const y = this.currentDate.getFullYear()
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
    const d = this.currentDate.getDate().toString().padStart(2, "0")
    return `${y}-${m}-${d}`
  }
  
  // 削除管理システムの統一化 - ヘルパーメソッド
  
  // 削除済みインスタンスを取得
  getDeletedInstances(dateStr) {
    const key = `taskchute-deleted-instances-${dateStr}`
    try {
      const data = localStorage.getItem(key)
      if (!data) return []
      return JSON.parse(data)
    } catch (e) {
      console.error("[TaskChute] 削除済みインスタンスの読み込みエラー:", e)
      return []
    }
  }
  
  // 削除済みインスタンスを保存
  saveDeletedInstances(dateStr, instances) {
    const key = `taskchute-deleted-instances-${dateStr}`
    try {
      localStorage.setItem(key, JSON.stringify(instances))
    } catch (e) {
      console.error("[TaskChute] 削除済みインスタンスの保存エラー:", e)
    }
  }
  
  // 非表示ルーチンタスクを取得（新形式対応）
  getHiddenRoutines(dateStr) {
    const keyPlural = `taskchute-hidden-routines-${dateStr}`  // 複数形（新形式）
    const keySingular = `taskchute-hidden-routine-${dateStr}` // 単数形（旧形式）
    const hiddenRoutines = []
    
    try {
      // 新形式（複数形）のデータを読み込み
      const dataPlural = localStorage.getItem(keyPlural)
      if (dataPlural) {
        const parsed = JSON.parse(dataPlural)
        // 後方互換性: 文字列配列の場合は新形式に変換
        if (parsed.length > 0 && typeof parsed[0] === "string") {
          hiddenRoutines.push(...parsed.map(path => ({
            path: path,
            instanceId: null // 旧形式はインスタンスIDを持たない
          })))
        } else {
          hiddenRoutines.push(...parsed)
        }
      }
      
      // 旧形式（単数形）のデータも読み込み（ホットキー削除で保存されたデータ）
      const dataSingular = localStorage.getItem(keySingular)
      if (dataSingular) {
        const parsed = JSON.parse(dataSingular)
        // 文字列配列をオブジェクト形式に変換
        if (Array.isArray(parsed)) {
          parsed.forEach(path => {
            // 重複を避ける
            if (!hiddenRoutines.some(h => h.path === path)) {
              hiddenRoutines.push({ path, instanceId: null })
            }
          })
        }
      }
      
      return hiddenRoutines
    } catch (e) {
      console.error("[TaskChute] 非表示ルーチンの読み込みエラー:", e)
      return []
    }
  }
  
  // 非表示ルーチンタスクを保存
  saveHiddenRoutines(dateStr, routines) {
    const keyPlural = `taskchute-hidden-routines-${dateStr}`
    const keySingular = `taskchute-hidden-routine-${dateStr}` // 旧形式のキー
    
    try {
      // 新形式で保存
      localStorage.setItem(keyPlural, JSON.stringify(routines))
      
      // 旧形式のキーが存在する場合は削除（移行完了）
      if (localStorage.getItem(keySingular)) {
        localStorage.removeItem(keySingular)
      }
    } catch (e) {
      console.error("[TaskChute] 非表示ルーチンの保存エラー:", e)
    }
  }
  
  // 複製されたインスタンスを取得
  getDuplicatedInstances(dateStr) {
    const key = `taskchute-duplicated-instances-${dateStr}`
    try {
      const data = localStorage.getItem(key)
      if (!data) return []
      return JSON.parse(data)
    } catch (e) {
      console.error("[TaskChute] 複製インスタンスの読み込みエラー:", e)
      return []
    }
  }
  
  // インスタンスが削除済みかチェック
  isInstanceDeleted(instanceId, taskPath, dateStr) {
    const deletedInstances = this.getDeletedInstances(dateStr)
    return deletedInstances.some(del => {
      // インスタンスIDでの一致を優先
      if (instanceId && del.instanceId === instanceId) return true
      // 永続削除されたファイルの場合
      if (del.deletionType === "permanent" && del.path === taskPath) return true
      return false
    })
  }
  
  // インスタンスが非表示かチェック
  isInstanceHidden(instanceId, taskPath, dateStr) {
    const hiddenRoutines = this.getHiddenRoutines(dateStr)
    return hiddenRoutines.some(hidden => {
      // 新形式：インスタンスIDでの一致
      if (hidden.instanceId && hidden.instanceId === instanceId) return true
      // 旧形式：文字列（パス）での一致 - ただし、この場合もインスタンスIDがあるものは除外
      if (typeof hidden === 'string' && hidden === taskPath && !instanceId) return true
      return false
    })
  }

  constructor(leaf, plugin) {
    super(leaf)
    this.plugin = plugin
    this.tasks = [] // タスクファイル情報
    this.taskInstances = [] // タスクインスタンス（描画・計測単位）
    this.globalTimerInterval = null // 複数のタイマーを管理するグローバルタイマー

    // 日付ナビゲーション用
    const today = new Date()
    this.currentDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    )

    // フェーズ2: 新しいソート方式のフラグ（デフォルトで有効）
    this.useOrderBasedSort =
      localStorage.getItem("taskchute-use-order-sort") !== "false"

    // Navigation state management
    this.navigationState = new NavigationState()
    
    // Keyboard selection state
    this.selectedTaskInstance = null
    
    // 既存データの移行処理（初回のみ）
    this.migrateOldDeletionData()
  }
  
  // 既存データの移行処理
  async migrateOldDeletionData() {
    try {
      // 旧形式の削除リストをチェック
      const oldDeletedTasks = localStorage.getItem("taskchute-deleted-tasks")
      if (!oldDeletedTasks) return // 移行不要
      
      const deletedPaths = JSON.parse(oldDeletedTasks)
      if (!Array.isArray(deletedPaths) || deletedPaths.length === 0) {
        localStorage.removeItem("taskchute-deleted-tasks")
        return
      }
      
      console.log("[TaskChute] 旧形式の削除データを移行中...")
      
      // 現在の日付で新形式に移行
      const dateStr = this.getCurrentDateString()
      const newDeletedInstances = deletedPaths.map(path => ({
        path: path,
        instanceId: "legacy-" + path, // 旧データ用の特別なID
        deletionType: "permanent",
        deletedAt: new Date().toISOString()
      }))
      
      // 既存の新形式データとマージ
      const existingInstances = this.getDeletedInstances(dateStr)
      const mergedInstances = [...existingInstances, ...newDeletedInstances]
      
      // 重複を除去
      const uniqueInstances = mergedInstances.filter((item, index, self) =>
        index === self.findIndex((t) => t.path === item.path)
      )
      
      this.saveDeletedInstances(dateStr, uniqueInstances)
      
      // 旧データを削除
      localStorage.removeItem("taskchute-deleted-tasks")
      
      console.log(`[TaskChute] ${deletedPaths.length}件の削除データを移行しました`)
    } catch (e) {
      console.error("[TaskChute] 削除データの移行に失敗:", e)
    }
  }

  getViewType() {
    return VIEW_TYPE_TASKCHUTE
  }

  getDisplayText() {
    return "TaskChute"
  }

  async onOpen() {
    const container = this.containerEl.children[1]
    container.empty()

    // トップバーコンテナ（日付ナビゲーションとdrawerアイコンを同じ高さに）
    const topBarContainer = container.createEl("div", {
      cls: "top-bar-container",
    })
    
    // Drawer Toggle Button
    const drawerToggle = topBarContainer.createEl("button", {
      cls: "drawer-toggle",
      attr: { title: "ナビゲーションを開く" },
    })
    const drawerIcon = drawerToggle.createEl("span", {
      cls: "drawer-toggle-icon",
      text: "☰",
    })

    // 日付ナビゲーション
    const navContainer = topBarContainer.createEl("div", {
      cls: "date-nav-container compact",
    })
    const leftBtn = navContainer.createEl("button", {
      cls: "date-nav-arrow",
      text: "<",
    })
    // カレンダーアイコンボタン
    const calendarBtn = navContainer.createEl("button", {
      cls: "calendar-btn",
      text: "🗓️",
      attr: { title: "カレンダーを開く" },
      style:
        "font-size:18px;padding:0 6px;background:none;border:none;cursor:pointer;",
    })
    const dateLabel = navContainer.createEl("span", { cls: "date-nav-label" })
    const rightBtn = navContainer.createEl("button", {
      cls: "date-nav-arrow",
      text: ">",
    })
    // 日付表示
    this.updateDateLabel(dateLabel)
    leftBtn.addEventListener("click", async () => {
      this.currentDate.setDate(this.currentDate.getDate() - 1)
      this.updateDateLabel(dateLabel)
      await this.loadTasks()
    })
    rightBtn.addEventListener("click", async () => {
      this.currentDate.setDate(this.currentDate.getDate() + 1)
      this.updateDateLabel(dateLabel)
      await this.loadTasks()
    })

    // 仕切り線を追加
    topBarContainer.createEl("div", {
      cls: "header-divider",
    })

    // タスク追加ボタンとロボットボタンをtopBarContainerに移動
    const actionSection = topBarContainer.createEl("div", {
      cls: "header-action-section",
    })
    const addTaskButton = actionSection.createEl("button", {
      cls: "add-task-button repositioned",
      text: "+",
      attr: { title: "新しいタスクを追加" },
    })
    const robotButton = actionSection.createEl("button", {
      cls: "robot-terminal-button",
      text: "🤖",
      attr: { title: "ターミナルを開く" },
    })
    
    // Event listeners for action buttons
    addTaskButton.addEventListener("click", () => this.showAddTaskModal())
    robotButton.addEventListener("click", async () => {
      try {
        await this.app.commands.executeCommandById(
          "terminal:open-terminal.integrated.root"
        )
      } catch (error) {
        new Notice("ターミナルを開けませんでした: " + error.message)
      }
    })
    
    // カレンダーUI
    calendarBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      // 既存のinputがあれば削除
      const oldInput = document.getElementById("calendar-date-input")
      if (oldInput) oldInput.remove()
      const input = document.createElement("input")
      input.type = "date"
      input.id = "calendar-date-input"
      input.style.position = "absolute"
      input.style.left = `${calendarBtn.getBoundingClientRect().left}px`
      input.style.top = `${calendarBtn.getBoundingClientRect().bottom + 5}px`
      input.style.zIndex = 10000
      // 現在日付をセット
      const y = this.currentDate.getFullYear()
      const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
      const d = this.currentDate.getDate().toString().padStart(2, "0")
      input.value = `${y}-${m}-${d}`
      document.body.appendChild(input)

      // カレンダーを自動的に開く
      setTimeout(() => {
        try {
          input.focus()
          input.click()

          // clickイベントが効かない場合の代替手段
          if (input.showPicker && typeof input.showPicker === "function") {
            input.showPicker()
          } else {
            // mousedownイベントをシミュレート
            const mouseEvent = new MouseEvent("mousedown", {
              view: window,
              bubbles: true,
              cancelable: true,
            })
            input.dispatchEvent(mouseEvent)
          }
        } catch (e) {
          // エラーを無視（テスト環境など）
          console.log("Calendar auto-open failed:", e.message)
        }
      }, 50)

      input.addEventListener("change", async () => {
        const [yy, mm, dd] = input.value.split("-").map(Number)
        this.currentDate = new Date(yy, mm - 1, dd)
        this.updateDateLabel(dateLabel)
        await this.loadTasks()
        input.remove()
      })
      // フォーカス外で消す
      input.addEventListener("blur", () => input.remove())
    })

    // メインコンテナ
    const mainContainer = container.createEl("div", {
      cls: "taskchute-container",
    })

    // Main container for navigation panel and task list
    const contentContainer = mainContainer.createEl("div", {
      cls: "main-container",
    })

    // Overlay for click outside to close
    this.navigationOverlay = contentContainer.createEl("div", {
      cls: "navigation-overlay navigation-overlay-hidden",
    })

    // Navigation Panel
    this.navigationPanel = contentContainer.createEl("div", {
      cls: "navigation-panel navigation-panel-hidden",
    })

    // Navigation menu
    const navMenu = this.navigationPanel.createEl("nav", {
      cls: "navigation-nav",
    })

    // Navigation items
    const navigationItems = [
      {
        key: "routine",
        label: "ルーチン",
        icon: "🔄",
      },
      {
        key: "review",
        label: "レビュー",
        icon: "📋",
      },
      {
        key: "project",
        label: "プロジェクト",
        icon: "📁",
      },
    ]

    navigationItems.forEach((item) => {
      const navItem = navMenu.createEl("div", {
        cls: "navigation-nav-item",
        attr: { "data-section": item.key },
      })
      navItem.createEl("span", {
        cls: "navigation-nav-icon",
        text: item.icon,
      })
      navItem.createEl("span", {
        cls: "navigation-nav-label",
        text: item.label,
      })

      // Add click handler
      navItem.addEventListener("click", () => {
        this.handleNavigationItemClick(item.key)
      })
    })

    // 上部：タスクリストエリア
    const taskListContainer = contentContainer.createEl("div", {
      cls: "task-list-container",
    })

    this.taskList = taskListContainer.createEl("div", { cls: "task-list" })

    // Add keyboard shortcut listener
    this.registerDomEvent(document, "keydown", (e) => {
      this.handleKeyboardShortcut(e)
    })

    // Add click listener for clearing selection
    this.registerDomEvent(container, "click", (e) => {
      // Clear selection if clicked outside of task items
      if (!e.target.closest(".task-item")) {
        this.clearTaskSelection()
      }
    })

    await this.loadTasks()
    this.applyStyles()

    // リサイズ監視を設定
    this.setupResizeObserver()

    // Initialize navigation event listeners
    this.initializeNavigationEventListeners()

    // ファイルリネームイベントのリスナーを追加
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        // タスクファイルかどうかチェック
        if (file.extension === "md") {
          try {
            const content = await this.app.vault.read(file)
            if (content.includes("#task")) {
              console.log(
                `[TaskChute] タスクファイルがリネームされました: ${oldPath} → ${file.path}`,
              )

              // localStorageのキーも更新
              const oldSlotKey = localStorage.getItem(
                `taskchute-slotkey-${oldPath}`,
              )
              const oldManualPosition = localStorage.getItem(
                `taskchute-manual-position-${oldPath}`,
              )
              const oldPositionInSlot = localStorage.getItem(
                `taskchute-position-in-slot-${oldPath}`,
              )

              if (oldSlotKey) {
                localStorage.setItem(
                  `taskchute-slotkey-${file.path}`,
                  oldSlotKey,
                )
                localStorage.removeItem(`taskchute-slotkey-${oldPath}`)
              }
              if (oldManualPosition) {
                localStorage.setItem(
                  `taskchute-manual-position-${file.path}`,
                  oldManualPosition,
                )
                localStorage.removeItem(`taskchute-manual-position-${oldPath}`)
              }
              if (oldPositionInSlot) {
                localStorage.setItem(
                  `taskchute-position-in-slot-${file.path}`,
                  oldPositionInSlot,
                )
                localStorage.removeItem(`taskchute-position-in-slot-${oldPath}`)
              }

              // 削除済みリストからも更新
              let deletedTasks = []
              try {
                deletedTasks = JSON.parse(
                  localStorage.getItem("taskchute-deleted-tasks") || "[]",
                )
                const oldIndex = deletedTasks.indexOf(oldPath)
                if (oldIndex !== -1) {
                  deletedTasks[oldIndex] = file.path
                  localStorage.setItem(
                    "taskchute-deleted-tasks",
                    JSON.stringify(deletedTasks),
                  )
                }
              } catch (e) {
                // エラーは無視
              }

              // 実行中タスクのパスを更新
              await this.updateRunningTaskPath(
                oldPath,
                file.path,
                file.basename,
              )

              // タスクリストを再読み込み
              await this.loadTasks()
            }
          } catch (e) {
            // ファイル読み込みエラーは無視
            console.error(`[TaskChute] ファイル読み込みエラー: ${e}`)
          }
        }
      }),
    )

    // デバッグ関数を設定
    this.setupDebugFunctions()
  }

  updateDateLabel(dateLabel) {
    const y = this.currentDate.getFullYear()
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
    const d = this.currentDate.getDate().toString().padStart(2, "0")
    const dateStr = `${y}-${m}-${d}`
    // Wikiリンク風に表示
    dateLabel.innerHTML = `<a href="#" class="date-wikilink" style="color:#1976d2;font-weight:bold;text-decoration:none;">${dateStr}</a>`
    // クリックでノートを開く
    const link = dateLabel.querySelector(".date-wikilink")
    if (link) {
      link.addEventListener("click", (e) => {
        e.preventDefault()
        this.app.workspace.openLinkText(dateStr, "", false)
      })
    }
  }
  
  // 選択された日付を設定
  setSelectedDate(date) {
    // date は YYYY-MM-DD 形式の文字列
    const [year, month, day] = date.split('-').map(Number);
    this.currentDate = new Date(year, month - 1, day);
    
    // 日付ラベルを更新
    const dateLabel = this.containerEl.querySelector('.date-nav-label');
    if (dateLabel) {
      this.updateDateLabel(dateLabel);
    }
    
    // タスクを再読み込み
    this.loadTasks();
  }

  // Initialize navigation event listeners
  initializeNavigationEventListeners() {
    // Drawer toggle click handler
    const drawerToggle = this.containerEl.querySelector(".drawer-toggle")
    if (drawerToggle) {
      drawerToggle.addEventListener("click", () => {
        this.toggleNavigation()
      })
    }

    // Overlay click handler - close navigation when clicking outside
    if (this.navigationOverlay) {
      this.navigationOverlay.addEventListener("click", () => {
        this.toggleNavigation()
      })
    }
  }
  
  // Toggle navigation panel visibility
  toggleNavigation() {
    this.navigationState.toggle()
    
    if (this.navigationPanel && this.navigationOverlay) {
      const taskListContainer = this.containerEl.querySelector(".task-list-container")
      
      if (this.navigationState.isVisible) {
        this.navigationPanel.removeClass("navigation-panel-hidden")
        this.navigationPanel.addClass("navigation-panel-visible")
        this.navigationOverlay.removeClass("navigation-overlay-hidden")
        this.navigationOverlay.addClass("navigation-overlay-visible")
        
        // Add grayed out effect to task list
        if (taskListContainer) {
          taskListContainer.addClass("grayed-out")
        }
      } else {
        this.navigationPanel.removeClass("navigation-panel-visible")
        this.navigationPanel.addClass("navigation-panel-hidden")
        this.navigationOverlay.removeClass("navigation-overlay-visible")
        this.navigationOverlay.addClass("navigation-overlay-hidden")

        // Remove grayed out effect from task list
        if (taskListContainer) {
          taskListContainer.removeClass("grayed-out")
        }
      }
    }
  }
  
  // Handle navigation item clicks
  handleNavigationItemClick(section) {
    this.navigationState.setActiveSection(section)
    
    // Update active state visually
    const navItems = this.navigationPanel.querySelectorAll(".navigation-nav-item")
    navItems.forEach((item) => {
      if (item.getAttribute("data-section") === section) {
        item.addClass("active")
      } else {
        item.removeClass("active")
      }
    })

    // Call appropriate section handler
    switch (section) {
      case "routine":
        this.showRoutineSection()
        break
      case "review":
        this.showReviewSection()
        break
      case "project":
        this.showProjectSection()
        break
    }
  }
  
  // Placeholder methods for navigation sections
  showRoutineSection() {
    console.log("[TaskChute] Showing routine section")
    // TODO: Implement routine section display
  }
  
  showReviewSection() {
    console.log("[TaskChute] Showing review section")
    // TODO: Implement review section display
  }
  
  showProjectSection() {
    console.log("[TaskChute] Showing project section")
    // TODO: Implement project section display
  }

  async loadTasks() {
    const startTime = performance.now()

    let runningTaskPathsOnLoad = []
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      if (await this.app.vault.adapter.exists(dataPath)) {
        const content = await this.app.vault.adapter.read(dataPath)
        const runningData = JSON.parse(content) // 配列を期待
        if (Array.isArray(runningData)) {
          // 日付チェックはrestoreRunningTaskStateに任せる
          runningTaskPathsOnLoad = runningData.map((task) => task.taskPath)
        }
      }
    } catch (e) {
      // ファイルがない、JSONが不正などの場合は静かに失敗
    }

    this.tasks = []
    this.taskInstances = []
    this.taskList.empty()

    // 削除済みインスタンスを取得（新形式）
    const deletedInstances = this.getDeletedInstances(this.getCurrentDateString())

    // 指定日付を取得（日本時間）
    const y = this.currentDate.getFullYear()
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
    const d = this.currentDate.getDate().toString().padStart(2, "0")
    const dateString = `${y}-${m}-${d}`

    // 保存されたorder情報を読み込む（新実装）
    const savedOrders = this.loadSavedOrders(dateString)

    // 複製されたインスタンスの情報を読み込み
    const duplicationStorageKey = `taskchute-duplicated-instances-${dateString}`
    let duplicatedInstances = []
    try {
      const storageData = JSON.parse(
        localStorage.getItem(duplicationStorageKey) || "[]",
      )

      // 後方互換性: 古いpath配列形式の場合は新形式に変換
      if (storageData.length > 0 && typeof storageData[0] === "string") {
        duplicatedInstances = storageData.map((path) => ({
          path: path,
          instanceId: this.generateInstanceId(path), // 新規生成
        }))
      } else {
        duplicatedInstances = storageData
      }
    } catch (e) {
      duplicatedInstances = []
    }

    // パスごとのカウント数を計算（既存コードとの互換性のため）
    const duplicatedCounts = duplicatedInstances.reduce((acc, instance) => {
      acc[instance.path] = (acc[instance.path] || 0) + 1
      return acc
    }, {})

    // その日に非表示にするルーチンタスクのリストを取得（新形式対応）
    const hiddenRoutines = this.getHiddenRoutines(dateString)
    // 後方互換性のためパスのみの配列も作成
    // ただし、インスタンスIDを持つものは除外（複製されたタスクの削除は元のタスクに影響しない）
    const hiddenRoutinePaths = hiddenRoutines
      .filter(h => !h.instanceId || h.instanceId === null)  // インスタンスIDがないものだけ
      .map(h => typeof h === 'string' ? h : h.path)

    // 並列処理でパフォーマンス改善
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()

    // 実行履歴の読み込みとタスクファイル取得を並列実行
    const [todayExecutions, files] = await Promise.all([
      this.loadTodayExecutions(dateString),
      this.getTaskFiles(taskFolderPath),
    ])

    // デバッグ情報
    console.log(`[TaskChute] 指定日: ${dateString}`)
    console.log(`[TaskChute] 実行履歴数: ${todayExecutions.length}`)
    console.log(`[TaskChute] タスクファイル数: ${files.length}`)

    // ファイル内容の並列読み込み準備
    const fileReadPromises = []

    // 各ファイルの読み込みタスクを準備
    for (const file of files) {
      // 非表示リストに含まれるルーチンタスクはスキップ
      if (hiddenRoutinePaths.includes(file.path)) {
        continue
      }
      // 永続削除されたファイルはスキップ
      const permanentlyDeleted = deletedInstances.some(
        del => del.path === file.path && del.deletionType === "permanent"
      )
      if (permanentlyDeleted) continue

      // ファイル読み込みをPromiseとして追加
      fileReadPromises.push(
        this.app.vault
          .read(file)
          .then((content) => ({ file, content }))
          .catch((error) => {
            console.error(
              `[TaskChute] ファイル読み込みエラー: ${file.path}`,
              error,
            )
            return null
          }),
      )
    }

    // 全ファイルを並列で読み込み
    const fileContents = await Promise.all(fileReadPromises)

    // 読み込んだファイルを処理
    for (const fileData of fileContents) {
      if (!fileData) continue // エラーがあったファイルはスキップ

      const { file, content } = fileData
      if (content.includes("#task")) {
        // メタデータからルーチン情報を読み込み
        const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter
        let isRoutine = false
        let scheduledTime = null
        let routineStart = null
        let routineEnd = null
        let routineType = "daily" // デフォルトは毎日
        let weekday = null
        let weekdays = null // 複数曜日対応

        if (metadata) {
          // メタデータから読み込み
          isRoutine = metadata.routine === true
          scheduledTime = metadata.開始時刻 || null
          routineStart = metadata.routine_start || null
          routineEnd = metadata.routine_end || null
          routineType = metadata.routine_type || "daily" // 新規追加
          weekday = metadata.weekday !== undefined ? metadata.weekday : null // 新規追加
          weekdays = metadata.weekdays || null // 複数曜日対応
        } else {
          // 後方互換性: 既存のタグ形式から読み込み
          isRoutine = content.includes("#routine")
          const timeMatches = [...content.matchAll(/開始時刻: (\d{2}:\d{2})/g)]
          if (timeMatches.length > 0) {
            scheduledTime = timeMatches[timeMatches.length - 1][1]
          }
        }

        // プロジェクト情報を読み込み
        let projectPath = null
        let projectTitle = null
        if (metadata) {
          // 後方互換性のため、まずproject_pathをチェック
          projectPath = metadata.project_path || null
          // projectフィールドからプロジェクト名を抽出（[[Project名]]形式）
          if (metadata.project) {
            const projectMatch = metadata.project.match(/\[\[([^\]]+)\]\]/)
            if (projectMatch) {
              projectTitle = projectMatch[1]
              // project_pathが存在しない場合、projectTitleからprojectPathを復元
              if (!projectPath && projectTitle) {
                // まず規約通りのパスをチェック
                const projectFolderPath = this.plugin.pathManager.getProjectFolderPath()
                const reconstructedPath = `${projectFolderPath}/${projectTitle}.md`
                const projectFile =
                  this.app.vault.getAbstractFileByPath(reconstructedPath)
                if (projectFile) {
                  projectPath = reconstructedPath
                } else {
                  // 規約通りの場所にない場合は、全プロジェクトファイルから検索
                  try {
                    const allFiles = this.app.vault.getMarkdownFiles()
                    const matchingProject = allFiles.find(
                      (file) =>
                        file.basename === projectTitle &&
                        (file.path.includes("Project") ||
                          file.path.includes("project")),
                    )
                    if (matchingProject) {
                      projectPath = matchingProject.path
                      console.log(
                        `[TaskChute] プロジェクトパスを復元: ${projectTitle} → ${projectPath}`,
                      )
                    }
                  } catch (e) {
                    console.warn(
                      `[TaskChute] プロジェクトファイル検索エラー: ${e}`,
                    )
                  }
                }
              }
            }
          }
        }

        // ルーチン化されていないタスクは、今日の実行履歴がある場合のみ表示
        const todayExecutionsForTask = todayExecutions.filter(
          (exec) => exec.taskTitle === file.basename,
        )

        // ルーチンタスクでない場合は、今日の実行履歴がない場合はスキップ
        // ただし、routine_endが今日なら1日だけ表示
        if (!isRoutine && todayExecutionsForTask.length === 0) {
          let shouldShow = false

          // 実行中の非ルーチンタスクは実行開始日のみ表示
          if (runningTaskPathsOnLoad.includes(file.path)) {
            // 実行中タスクの実行開始日をチェック
            shouldShow = await this.isRunningTaskStartedToday(
              file.path,
              dateString,
            )
          } else {
            // メタデータのtarget_dateを優先的にチェック
            let targetDate = null
            if (metadata && metadata.target_date) {
              targetDate = metadata.target_date
              console.log(
                `[TaskChute] target_dateを使用: ${file.basename} → ${targetDate}`,
              )

              // target_dateが現在の表示日付と一致するかチェック
              if (dateString === targetDate) {
                shouldShow = true
              }
            } else {
              // target_dateがない場合は従来通りファイルの作成日をチェック
              const fileStats = this.app.vault.adapter.getFullPath(file.path)
              const fs = require("fs")

              try {
                const stats = fs.statSync(fileStats)
                const fileCreationDate = new Date(stats.birthtime)
                // ローカルタイムゾーンで日付文字列を生成（UTCではなく）
                const year = fileCreationDate.getFullYear()
                const month = (fileCreationDate.getMonth() + 1)
                  .toString()
                  .padStart(2, "0")
                const day = fileCreationDate
                  .getDate()
                  .toString()
                  .padStart(2, "0")
                const fileCreationDateString = `${year}-${month}-${day}`

                // 非ルーチンタスクは作成日当日のみ表示
                if (dateString === fileCreationDateString) {
                  shouldShow = true
                }
              } catch (error) {
                console.log(`[TaskChute] ファイル作成日取得エラー: ${error}`)
                // エラーの場合は安全のため表示
                shouldShow = true
              }
            }

            // 複製されたタスクは表示
            if (duplicatedCounts[file.path]) {
              shouldShow = true
            }

            if (routineEnd && dateString === routineEnd) {
              // 解除当日は非ルーチンとして表示
              shouldShow = true
            }
          }

          if (!shouldShow) {
            continue
          }
        }
        // ルーチンタスクの場合、routine_startより前の日付はスキップ
        if (isRoutine && routineStart) {
          if (dateString < routineStart) {
            continue
          }
        }
        // ルーチンタスクの場合、routine_end以降はスキップ
        if (isRoutine && routineEnd) {
          if (dateString > routineEnd) {
            continue
          }
        }

        // ルーチンタスクの表示判定
        if (isRoutine) {
          // 新規作成日（routine_start）は常に表示
          const isCreationDate = routineStart && dateString === routineStart

          // 既存の実行履歴がある日は表示
          const hasExecutions = todayExecutionsForTask.length > 0

          // ルーチンタイプに応じた表示判定
          let shouldShowRoutine = false

          if (routineType === "daily") {
            // 毎日ルーチンは常に表示
            shouldShowRoutine = true
          } else if (routineType === "weekly" || routineType === "custom") {
            // 週次またはカスタムルーチンの場合は曜日をチェック
            shouldShowRoutine = this.shouldShowWeeklyRoutine(
              { routineType, weekday, weekdays },
              this.currentDate,
            )
          }

          // 新規作成日、実行履歴がある日、または表示すべきルーチンでない場合はスキップ
          if (!isCreationDate && !hasExecutions && !shouldShowRoutine) {
            continue
          }
        }

        // 重複防止のためのチェック
        const isDuplicate = this.tasks.some((t) => t.path === file.path)
        if (isDuplicate) {
          console.warn(`[TaskChute] 重複タスクをスキップ: ${file.path}`)
          continue
        }

        // slotKeyの初期値設定
        let slotKey = "none"

        // 保存されたorder情報を使用してslotKeyを決定
        slotKey = this.determineSlotKey(file.path, savedOrders, { scheduledTime })
        const savedOrder = savedOrders[file.path]?.order ?? null

        const taskObj = {
          title: file.basename,
          path: file.path,
          file: file,
          isRoutine: isRoutine,
          scheduledTime: scheduledTime,
          slotKey: slotKey,
          routineType: routineType,
          weekday: weekday,
          weekdays: weekdays,
          projectPath: projectPath,
          projectTitle: projectTitle,
        }

        this.tasks.push(taskObj)

        if (todayExecutionsForTask.length > 0) {
          // 実行履歴がある場合は、完了済みインスタンスを追加
          todayExecutionsForTask.forEach((exec) => {
            // 実行履歴から時間帯を決定するロジック
            let instanceSlotKey

            // ルーチンタスクの場合は実行時刻から時間帯を計算
            if (isRoutine && exec.startTime) {
              // exec.startTimeはDate オブジェクトのはずだが、念のため変換
              const startDate = exec.startTime instanceof Date ? exec.startTime : new Date(exec.startTime)
              const startHour = startDate.getHours()
              const startMinute = startDate.getMinutes()
              const timeInMinutes = startHour * 60 + startMinute

              if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
                instanceSlotKey = "0:00-8:00"
              } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
                instanceSlotKey = "8:00-12:00"
              } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
                instanceSlotKey = "12:00-16:00"
              } else {
                instanceSlotKey = "16:00-0:00"
              }
            } else {
              // 非ルーチンタスクは保存されたslotKeyを使用
              instanceSlotKey = exec.slotKey || slotKey
            }

            const instance = {
              task: taskObj,
              state: "done",
              startTime: new Date(exec.startTime),
              stopTime: new Date(exec.stopTime),
              slotKey: instanceSlotKey,
              order: savedOrder, // 保存された値またはnull
              instanceId:
                exec.instanceId || this.generateInstanceId(taskObj.path), // 保存されたIDを使用、なければ新規生成
            }

            // manuallyPositionedフィールドは削除

            this.taskInstances.push(instance)
          })
        }

        // 未実行のインスタンスを1つ追加（実行履歴がない場合のみ）
        if (todayExecutionsForTask.length === 0) {
          // 実行履歴がない場合は、元の位置に未実行インスタンスを追加
          const instance = {
            task: taskObj,
            state: "idle",
            startTime: null,
            stopTime: null,
            slotKey: slotKey,
            order: null, // initializeTaskOrdersで設定される
            instanceId: this.generateInstanceId(taskObj.path), // 一意のインスタンスID
          }

          // インスタンスレベルでのフィルタリング
          const isDeleted = this.isInstanceDeleted(instance.instanceId, taskObj.path, dateString)
          const isHidden = this.isInstanceHidden(instance.instanceId, taskObj.path, dateString)
          
          if (!isDeleted && !isHidden) {
            this.taskInstances.push(instance)
          }
        }

        // 複製された分の未実行インスタンスを追加
        const duplicatesForThisPath = duplicatedInstances.filter(
          (dup) => dup.path === file.path,
        )
        if (duplicatesForThisPath.length > 0) {
          duplicatesForThisPath.forEach((duplicateInfo) => {
            const instance = {
              task: taskObj,
              state: "idle",
              startTime: null,
              stopTime: null,
              slotKey: slotKey,
              order: savedOrder, // 保存された値またはnull
              instanceId: duplicateInfo.instanceId, // 保存されたinstanceIdを使用
            }

            // インスタンスレベルでのフィルタリング
            const isDeleted = this.isInstanceDeleted(instance.instanceId, taskObj.path, dateString)
            const isHidden = this.isInstanceHidden(instance.instanceId, taskObj.path, dateString)
            
            if (!isDeleted && !isHidden) {
              this.taskInstances.push(instance)
            }
          })
        }
      }
    }

    // 各時間帯グループ内で時系列順にソート
    this.sortTaskInstancesByTimeOrder()

    // 実行中タスクの状態を復元
    await this.restoreRunningTaskState()

    // デバッグ情報: 最終的なタスクインスタンスの状態
    console.log(
      `[TaskChute] 最終的なタスクインスタンス数: ${this.taskInstances.length}`,
    )
    this.taskInstances.forEach((inst, index) => {
      console.log(
        `[TaskChute] インスタンス${index + 1}: ${inst.task.title} (状態: ${
          inst.state
        }, 開始: ${inst.startTime}, 終了: ${inst.stopTime})`,
      )
    })

    // orderフィールドの初期化（フェーズ1: 既存機能を壊さない）
    this.initializeTaskOrders()

    // 未実施タスクを現在の時間帯に自動移動
    this.moveIdleTasksToCurrentSlot()

    this.renderTaskList()

    // フェーズ3: orderベースソート使用時に古いlocalStorageキーを自動クリーンアップ
    if (this.useOrderBasedSort) {
      // 初回のみクリーンアップ実行（1日1回制限）
      const today = new Date().toDateString()
      const lastCleanup = localStorage.getItem("taskchute-last-cleanup")

      if (lastCleanup !== today) {
        console.log(
          "[TaskChute] 古いlocalStorageキーの自動クリーンアップを実行",
        )
        this.cleanupOldStorageKeys()
        localStorage.setItem("taskchute-last-cleanup", today)
      }
    }

    // パフォーマンス計測結果
    const loadTime = performance.now() - startTime
    console.log(`[TaskChute] タスク読み込み完了: ${loadTime.toFixed(0)}ms`)
  }

  // タスクファイルを取得する新しいメソッド
  async getTaskFiles(taskFolderPath) {
    const taskFolder = this.app.vault.getAbstractFileByPath(taskFolderPath)

    if (taskFolder && taskFolder.children) {
      // タスクフォルダ内のMarkdownファイルのみを取得
      const files = taskFolder.children.filter(
        (file) => file.extension === "md" && file.stat,
      )
      console.log(
        `[TaskChute] タスクフォルダから${files.length}個のファイルを読み込み`,
      )
      return files
    } else {
      console.warn(
        `[TaskChute] タスクフォルダが見つかりません: ${taskFolderPath}`,
      )
      // フォールバック：従来の全ファイル検索（#taskタグでフィルタ）
      const allFiles = this.app.vault.getMarkdownFiles()
      const files = []

      // 並列でファイル内容をチェック
      const checkPromises = allFiles.map((file) =>
        this.app.vault
          .read(file)
          .then((content) => (content.includes("#task") ? file : null))
          .catch(() => null),
      )

      const results = await Promise.all(checkPromises)
      const taskFiles = results.filter((file) => file !== null)

      console.log(
        `[TaskChute] フォールバック: #taskタグから${taskFiles.length}個のタスクを検出`,
      )
      return taskFiles
    }
  }

  // orderフィールドの初期化（フェーズ1: 既存機能を壊さない）
  initializeTaskOrders() {
    console.log("[TaskChute] orderフィールドの初期化を開始")

    // 日付文字列を生成
    const y = this.currentDate.getFullYear()
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
    const d = this.currentDate.getDate().toString().padStart(2, "0")
    const dateStr = `${y}-${m}-${d}`

    // localStorageから保存された順序を読み込み
    const storageKey = `taskchute-orders-${dateStr}`
    let savedOrders = {}
    try {
      const savedData = localStorage.getItem(storageKey)
      if (savedData) {
        savedOrders = JSON.parse(savedData)
        console.log("[TaskChute] 保存された順序を読み込みました:", savedOrders)
      }
    } catch (e) {
      console.error("[TaskChute] 順序の読み込みに失敗:", e)
    }

    // 時間帯ごとにグループ化
    const slotGroups = {}
    this.taskInstances.forEach((inst) => {
      const slot = inst.slotKey || "none"
      if (!slotGroups[slot]) slotGroups[slot] = []
      slotGroups[slot].push(inst)
    })

    // 各時間帯内で順序番号を付与
    Object.entries(slotGroups).forEach(([slotKey, instances]) => {
      // 状態ごとに分類
      const doneInstances = instances.filter((inst) => inst.state === "done")
      const runningInstances = instances.filter(
        (inst) => inst.state === "running",
      )
      const idleInstances = instances.filter((inst) => inst.state === "idle")

      let orderCounter = 100

      // 完了タスクに順序番号を付与（時系列順）
      doneInstances
        .sort(
          (a, b) =>
            (a.startTime?.getTime() || 0) - (b.startTime?.getTime() || 0),
        )
        .forEach((inst) => {
          inst.order = orderCounter
          orderCounter += 100
        })

      // 実行中タスクに順序番号を付与
      runningInstances.forEach((inst) => {
        inst.order = orderCounter
        orderCounter += 100
      })

      // 未実行タスクの順序番号を付与
      // 1. 保存された順序があるタスクと、ないタスクを分離
      const savedIdleInstances = idleInstances.filter((inst) => {
        const savedOrder = savedOrders[inst.task.path]
        return savedOrder && savedOrder.slot === slotKey
      })

      const unsavedIdleInstances = idleInstances.filter((inst) => {
        const savedOrder = savedOrders[inst.task.path]
        return !savedOrder || savedOrder.slot !== slotKey
      })

      // 2. 保存された順序があるタスクは、保存された順序番号を使用
      savedIdleInstances.forEach((inst) => {
        const savedOrder = savedOrders[inst.task.path]
        inst.order = savedOrder.order
      })

      // 3. 保存された順序がないタスクのみを時刻順にソートして、順序番号を付与
      if (unsavedIdleInstances.length > 0) {
        unsavedIdleInstances
          .sort((a, b) => {
            const timeA = a.task.scheduledTime
            const timeB = b.task.scheduledTime
            if (!timeA && !timeB) return 0
            if (!timeA) return 1
            if (!timeB) return -1
            const [hourA, minuteA] = timeA.split(":").map(Number)
            const [hourB, minuteB] = timeB.split(":").map(Number)
            return hourA * 60 + minuteA - (hourB * 60 + minuteB)
          })
          .forEach((inst, index) => {
            inst.order = orderCounter + index * 100
          })
      }

      // 4. 最終的に全体をorder順でソート
      idleInstances.sort((a, b) => a.order - b.order)
    })

    console.log("[TaskChute] orderフィールドの初期化完了")
  }

  // orderフィールドをlocalStorageに保存
  saveTaskOrders() {
    // 日付文字列を生成
    const y = this.currentDate.getFullYear()
    const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
    const d = this.currentDate.getDate().toString().padStart(2, "0")
    const dateStr = `${y}-${m}-${d}`

    // 保存するデータを作成
    const orders = {}
    this.taskInstances.forEach((inst) => {
      if (inst.task.path && inst.order !== null) {
        orders[inst.task.path] = {
          slot: inst.slotKey,
          order: inst.order,
        }
      }
    })

    // localStorageに保存
    const storageKey = `taskchute-orders-${dateStr}`
    localStorage.setItem(storageKey, JSON.stringify(orders))
    console.log("[TaskChute] orderフィールドを保存しました:", orders)
  }

  // 未実施タスクを現在の時間帯に自動移動する
  moveIdleTasksToCurrentSlot() {
    // 今日以外の日付では自動移動を無効化
    const today = new Date()
    const isToday =
      this.currentDate.getFullYear() === today.getFullYear() &&
      this.currentDate.getMonth() === today.getMonth() &&
      this.currentDate.getDate() === today.getDate()

    if (!isToday) {
      console.log("[TaskChute] 未来日・過去日では自動移動を無効化")
      return
    }

    const currentSlot = this.getCurrentTimeSlot()
    const now = new Date()
    const currentHour = now.getHours()
    const currentMinute = now.getMinutes()
    const currentTimeInMinutes = currentHour * 60 + currentMinute

    // 各時間帯の開始時刻（分単位）
    const slotStartTimes = {
      "0:00-8:00": 0,
      "8:00-12:00": 8 * 60,
      "12:00-16:00": 12 * 60,
      "16:00-0:00": 16 * 60,
    }

    // 現在の時間帯の開始時刻
    const currentSlotStartTime = slotStartTimes[currentSlot]

    // 未実施タスクで、過去の時間帯にあるものを移動
    this.taskInstances.forEach((inst) => {
      if (inst.state === "idle" && inst.slotKey !== "none") {
        const taskSlotStartTime = slotStartTimes[inst.slotKey]

        // タスクが過去の時間帯にある場合
        if (taskSlotStartTime < currentSlotStartTime) {
          console.log(
            `[TaskChute] 未実施タスク "${inst.task.title}" を ${inst.slotKey} から ${currentSlot} に移動`,
          )

          // 現在の時間帯に移動
          inst.slotKey = currentSlot

          // 手動配置フラグはリセットしない（ユーザーが手動で配置した順序は保持）
          // localStorageも更新
          localStorage.setItem(
            `taskchute-slotkey-${inst.task.path}`,
            currentSlot,
          )
        }
      }
    })
  }

  // 各時間帯グループ内で時系列順にソート
  sortTaskInstancesByTimeOrder() {
    if (this.useOrderBasedSort) {
      // 新しいorderベースのソート関数を使用
      this.taskInstances = sortTaskInstancesByOrder(
        this.taskInstances,
        this.getTimeSlotKeys(),
      )
    } else {
      // 従来のソート関数を使用
      this.taskInstances = sortTaskInstances(
        this.taskInstances,
        this.getTimeSlotKeys(),
      )
    }
  }

  // ソート方式を切り替える（デバッグ・テスト用）
  toggleSortMethod() {
    this.useOrderBasedSort = !this.useOrderBasedSort
    localStorage.setItem(
      "taskchute-use-order-sort",
      this.useOrderBasedSort.toString(),
    )

    console.log(
      `[TaskChute] ソート方式を切り替え: ${
        this.useOrderBasedSort ? "orderベース" : "従来方式"
      }`,
    )

    // 即座に再ソート
    this.sortTaskInstancesByTimeOrder()
    this.renderTaskList()

    new Notice(
      `ソート方式: ${this.useOrderBasedSort ? "orderベース" : "従来方式"}`,
    )
  }

  // 新しい順序番号を計算する（フェーズ2）
  calculateNewOrder(targetIndex, slotTasks, otherStatesMaxOrder = 0) {
    // slotTasksをorder順にソート
    const sortedSlotTasks = slotTasks.sort(
      (a, b) => (a.order ?? 999999) - (b.order ?? 999999),
    )

    if (sortedSlotTasks.length === 0) {
      const baseOrder = Math.max(100, otherStatesMaxOrder + 100)
      return baseOrder
    }

    if (targetIndex === 0) {
      // 一番上に移動
      const firstOrder = sortedSlotTasks[0].order ?? 100
      const newOrder = Math.max(firstOrder - 100, otherStatesMaxOrder + 10, 50)
      return newOrder
    }

    if (targetIndex >= sortedSlotTasks.length) {
      // 一番下に移動
      const lastOrder = sortedSlotTasks[sortedSlotTasks.length - 1].order ?? 100
      const newOrder = Math.max(lastOrder + 100, otherStatesMaxOrder + 100)
      return newOrder
    }

    // 間に挿入
    const prevOrder = sortedSlotTasks[targetIndex - 1].order ?? 100
    const nextOrder = sortedSlotTasks[targetIndex].order ?? 200
    const gap = nextOrder - prevOrder

    if (gap <= 1) {
      // 隙間がない場合は、その時間帯の順序番号を正規化
      this.normalizeOrdersInSlot(sortedSlotTasks)
      // 正規化後に再計算（正規化後は100刻みなので、間に挿入できる）
      if (targetIndex === 0) {
        const newOrder = Math.max(50, otherStatesMaxOrder + 10) // 最初の要素より前
        return newOrder
      } else if (targetIndex >= sortedSlotTasks.length) {
        const newOrder = Math.max(
          sortedSlotTasks.length * 100 + 100,
          otherStatesMaxOrder + 100,
        )
        return newOrder
      } else {
        const baseOrder = targetIndex * 100 + 50 // 間に挿入
        const newOrder = Math.max(baseOrder, otherStatesMaxOrder + 10)
        return newOrder
      }
    }

    // 中間値を使用
    const middleOrder = Math.floor((prevOrder + nextOrder) / 2)
    const newOrder = Math.max(middleOrder, otherStatesMaxOrder + 10)
    return newOrder
  }

  // 複製タスクの順序番号を計算（元タスクの直下に配置）
  calculateDuplicateTaskOrder(newInst, originalInst) {
    // 同じ時間帯のタスクを取得して順序でソート
    const slotTasks = this.taskInstances.filter(
      (inst) => inst.slotKey === originalInst.slotKey
    ).sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999))

    // 元タスクのソート後のインデックスを取得
    const originalIndex = slotTasks.findIndex(inst => inst === originalInst)
    
    if (originalIndex === -1) {
      // 元タスクが見つからない場合は、デフォルトの順序番号を設定
      newInst.order = 999999
      return
    }

    // 元タスクの次の位置にあるタスクを取得
    const nextTask = slotTasks[originalIndex + 1]

    if (!nextTask) {
      // 元タスクが最後の場合、元タスクの順序番号 + 100
      newInst.order = (originalInst.order ?? 0) + 100
    } else {
      // 元タスクと次のタスクの間の順序番号を計算
      const originalOrder = originalInst.order ?? 0
      const nextOrder = nextTask.order ?? originalOrder + 200

      // 間の値を計算
      const gap = nextOrder - originalOrder
      if (gap > 1) {
        // 十分な隙間がある場合は中間値を使用
        newInst.order = originalOrder + Math.floor(gap / 2)
      } else {
        // 隙間がない場合は、時間帯内の順序番号を正規化してから再計算
        this.normalizeOrdersInSlot(slotTasks.filter(t => t.slotKey === originalInst.slotKey))
        
        // 正規化後の元タスクの順序番号を取得
        const normalizedOriginalOrder = originalInst.order ?? 0
        newInst.order = normalizedOriginalOrder + 50
      }
    }

    // 順序番号を保存
    this.saveTaskOrders()
  }

  // 時間帯内の順序番号を正規化する
  normalizeOrdersInSlot(slotTasks) {
    // 現在の順序でソート
    slotTasks.sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999))

    // 100刻みで再割り当て
    slotTasks.forEach((task, index) => {
      task.order = (index + 1) * 100
    })

    console.log("[TaskChute] 時間帯内の順序番号を正規化しました")
  }

  // 全ての順序番号を正規化する（メンテナンス用）
  normalizeAllOrders() {
    if (!this.useOrderBasedSort) {
      new Notice("orderベースのソート方式が有効になっていません")
      return
    }

    const timeSlotKeys = this.getTimeSlotKeys()
    const allSlots = ["none", ...timeSlotKeys]

    allSlots.forEach((slotKey) => {
      const slotTasks = this.taskInstances.filter(
        (inst) => inst.slotKey === slotKey,
      )
      if (slotTasks.length > 0) {
        this.normalizeOrdersInSlot(slotTasks)
      }
    })

    // 変更を保存
    this.saveTaskOrders()

    // 再ソートして表示
    this.sortTaskInstancesByTimeOrder()
    this.renderTaskList()

    new Notice("全ての順序番号を正規化しました")
    console.log("[TaskChute] 全ての順序番号を正規化完了")
  }

  // ========== 新しいシンプルな実装（フェーズ2） ==========
  
  // 保存されたorder情報を読み込む
  loadSavedOrders(dateStr) {
    try {
      const data = localStorage.getItem(`taskchute-orders-${dateStr}`)
      return data ? JSON.parse(data) : {}
    } catch (e) {
      console.error('[TaskChute] Failed to load saved orders:', e)
      return {}
    }
  }

  // タスクのorder情報を保存する
  saveTaskOrders() {
    const dateStr = this.getCurrentDateString()
    const orderData = {}
    
    this.taskInstances.forEach(inst => {
      if (inst.order !== null && inst.order !== undefined) {
        orderData[inst.task.path] = {
          slot: inst.slotKey,
          order: inst.order
        }
      }
    })
    
    localStorage.setItem(`taskchute-orders-${dateStr}`, JSON.stringify(orderData))
  }

  // slotKeyを決定する（優先順位: 保存データ > scheduledTime > デフォルト）
  determineSlotKey(taskPath, savedOrders, taskObj) {
    // 1. 保存されたslot情報を最優先
    if (savedOrders[taskPath]?.slot) {
      return savedOrders[taskPath].slot
    }
    
    // 2. scheduledTimeから計算（フォールバック）
    if (taskObj.scheduledTime) {
      return this.getSlotFromScheduledTime(taskObj.scheduledTime)
    }
    
    // 3. デフォルト
    return 'none'
  }

  // scheduledTimeから時間帯を計算
  getSlotFromScheduledTime(scheduledTime) {
    if (!scheduledTime) return 'none'
    
    const [hourStr, minuteStr] = scheduledTime.split(':')
    const hour = parseInt(hourStr)
    const minute = parseInt(minuteStr)
    const timeInMinutes = hour * 60 + minute
    
    if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
      return '0:00-8:00'
    } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
      return '8:00-12:00'
    } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
      return '12:00-16:00'
    } else {
      return '16:00-0:00'
    }
  }

  // シンプルなorder計算（配列操作なし）
  calculateSimpleOrder(targetIndex, sameTasks) {
    const sorted = sameTasks.sort((a, b) => a.order - b.order)
    
    if (sorted.length === 0) return 100
    if (targetIndex <= 0) return sorted[0].order - 100
    if (targetIndex >= sorted.length) return sorted[sorted.length - 1].order + 100
    
    const prev = sorted[targetIndex - 1].order
    const next = sorted[targetIndex].order
    
    // 隙間が十分ある場合
    if (next - prev > 1) {
      return Math.floor((prev + next) / 2)
    }
    
    // 正規化が必要
    this.normalizeOrders(sorted)
    return targetIndex * 100 + 50
  }

  // 統一されたソート関数（状態優先 → order番号）
  sortByOrder() {
    this.taskInstances.sort((a, b) => {
      // 1. 状態優先
      const stateOrder = { done: 0, running: 1, idle: 2 }
      if (a.state !== b.state) {
        return stateOrder[a.state] - stateOrder[b.state]
      }

      // 2. 同じ状態内はorder番号
      return a.order - b.order
    })
  }

  // order番号の正規化（簡素版）
  normalizeOrders(tasks) {
    tasks.forEach((task, index) => {
      task.order = (index + 1) * 100
    })
  }

  // nullのorderを初期化
  initializeNullOrders() {
    const timeSlotKeys = this.getTimeSlotKeys()
    const allSlots = ['none', ...timeSlotKeys]
    
    allSlots.forEach(slotKey => {
      const slotTasks = this.taskInstances.filter(
        inst => inst.slotKey === slotKey && (inst.order === null || inst.order === undefined)
      )
      
      if (slotTasks.length > 0) {
        // 既存のorder値の最大値を取得
        const existingOrders = this.taskInstances
          .filter(inst => inst.slotKey === slotKey && inst.order !== null && inst.order !== undefined)
          .map(inst => inst.order)
        
        const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) : 0
        
        // nullのタスクに順番にorder値を割り当て
        slotTasks.forEach((task, index) => {
          task.order = maxOrder + (index + 1) * 100
        })
      }
    })
  }

  // 新しいloadTasksのシンプル実装（段階的移行用）
  async loadTasksSimple() {
    const startTime = performance.now()
    const dateStr = this.getCurrentDateString()
    const savedOrders = this.loadSavedOrders(dateStr)

    // 実行中タスクの復元準備
    let runningTaskPathsOnLoad = []
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      if (await this.app.vault.adapter.exists(dataPath)) {
        const content = await this.app.vault.adapter.read(dataPath)
        const runningData = JSON.parse(content)
        if (Array.isArray(runningData)) {
          runningTaskPathsOnLoad = runningData.map(task => task.taskPath)
        }
      }
    } catch (e) {
      // Silent fail
    }
    
    // 初期化
    this.tasks = []
    this.taskInstances = []
    this.taskList.empty()
    
    // 削除済みタスクリスト
    const deletedTasks = JSON.parse(localStorage.getItem('taskchute-deleted-tasks') || '[]')
    
    // 複製タスク情報
    const duplicationKey = `taskchute-duplicated-instances-${dateStr}`
    let duplicatedInstances = []
    try {
      const storageData = JSON.parse(localStorage.getItem(duplicationKey) || '[]')
      if (storageData.length > 0 && typeof storageData[0] === 'string') {
        duplicatedInstances = storageData.map(path => ({
          path: path,
          instanceId: this.generateInstanceId(path)
        }))
      } else {
        duplicatedInstances = storageData
      }
    } catch (e) {
      duplicatedInstances = []
    }
    
    // 非表示ルーチンタスク
    const hiddenRoutineKey = `taskchute-hidden-routines-${dateStr}`
    const hiddenRoutinePaths = JSON.parse(localStorage.getItem(hiddenRoutineKey) || '[]')
    
    // タスクファイルの取得
    const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
    const [todayExecutions, files] = await Promise.all([
      this.loadTodayExecutions(dateStr),
      this.getTaskFiles(taskFolderPath)
    ])
    
    // ファイル処理
    for (const file of files) {
      // スキップ条件
      if (hiddenRoutinePaths.includes(file.path)) continue
      if (deletedTasks.includes(file.path)) continue
      
      try {
        const content = await this.app.vault.read(file)
        if (!content.includes("#task")) continue
        
        const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter
        
        // タスク情報の抽出
        const taskObj = await this.createTaskObject(file, metadata, content)
        
        // 表示判定
        if (!this.shouldShowTask(taskObj, dateStr, todayExecutions, runningTaskPathsOnLoad, duplicatedInstances)) {
          continue
        }
        
        // slotKey決定（優先順位明確化）
        const slotKey = this.determineSlotKey(file.path, savedOrders, taskObj)
        const order = savedOrders[file.path]?.order ?? null
        
        this.tasks.push(taskObj)
        
        // 実行履歴の処理
        const executions = todayExecutions.filter(exec => exec.taskTitle === file.basename)
        
        if (executions.length > 0) {
          // 完了済みインスタンス
          for (const exec of executions) {
            // ルーチンタスクの場合は実行時刻から時間帯を計算
            let instanceSlotKey
            if (taskObj.isRoutine && exec.startTime) {
              const startDate = exec.startTime instanceof Date ? exec.startTime : new Date(exec.startTime)
              const startHour = startDate.getHours()
              const startMinute = startDate.getMinutes()
              const timeInMinutes = startHour * 60 + startMinute

              if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
                instanceSlotKey = "0:00-8:00"
              } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
                instanceSlotKey = "8:00-12:00"
              } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
                instanceSlotKey = "12:00-16:00"
              } else {
                instanceSlotKey = "16:00-0:00"
              }
            } else {
              // 非ルーチンタスクは保存されたslotKeyを使用
              instanceSlotKey = exec.slotKey || slotKey
            }
            
            this.taskInstances.push({
              task: taskObj,
              state: 'done',
              startTime: new Date(exec.startTime),
              stopTime: new Date(exec.stopTime),
              slotKey: instanceSlotKey,
              order: order,
              instanceId: exec.instanceId || this.generateInstanceId(taskObj.path)
            })
          }
        } else {
          // 未実行インスタンス
          this.taskInstances.push({
            task: taskObj,
            state: 'idle',
            startTime: null,
            stopTime: null,
            slotKey: slotKey,
            order: order,
            instanceId: this.generateInstanceId(taskObj.path)
          })
        }
        
        // 複製インスタンス
        const duplicates = duplicatedInstances.filter(dup => dup.path === file.path)
        for (const dup of duplicates) {
          this.taskInstances.push({
            task: taskObj,
            state: 'idle',
            startTime: null,
            stopTime: null,
            slotKey: slotKey,
            order: order,
            instanceId: dup.instanceId
          })
        }
        
      } catch (error) {
        console.error(`[TaskChute] ファイル処理エラー: ${file.path}`, error)
      }
    }
    
    // null orderの初期化
    this.initializeNullOrders()
    
    // シンプルなソート
    this.sortByOrder()
    
    // 実行中タスクの復元
    await this.restoreRunningTaskState()
    
    // 未実施タスクを現在の時間帯に自動移動
    this.moveIdleTasksToCurrentSlot()
    
    // 描画
    this.renderTaskList()
    
    const endTime = performance.now()
    console.log(`[TaskChute] loadTasksSimple完了: ${endTime - startTime}ms`)
  }

  // タスクオブジェクトの作成（ヘルパー）
  async createTaskObject(file, metadata, content) {
    let isRoutine = false
    let scheduledTime = null
    let routineStart = null
    let routineEnd = null
    let routineType = 'daily'
    let weekday = null
    let projectPath = null
    let projectTitle = null
    
    if (metadata) {
      isRoutine = metadata.routine === true
      scheduledTime = metadata.開始時刻 || null
      routineStart = metadata.routine_start || null
      routineEnd = metadata.routine_end || null
      routineType = metadata.routine_type || 'daily'
      weekday = metadata.weekday !== undefined ? metadata.weekday : null
      
      // プロジェクト情報
      projectPath = metadata.project_path || null
      if (metadata.project) {
        const projectMatch = metadata.project.match(/\[\[([^\]]+)\]\]/)
        if (projectMatch) {
          projectTitle = projectMatch[1]
          if (!projectPath && projectTitle) {
            // プロジェクトパスの復元ロジック（省略）
          }
        }
      }
    } else {
      // 後方互換性
      isRoutine = content.includes("#routine")
      const timeMatches = [...content.matchAll(/開始時刻: (\d{2}:\d{2})/g)]
      if (timeMatches.length > 0) {
        scheduledTime = timeMatches[timeMatches.length - 1][1]
      }
    }

    return {
      title: file.basename,
      path: file.path,
      file: file,
      isRoutine: isRoutine,
      scheduledTime: scheduledTime,
      routineStart: routineStart,
      routineEnd: routineEnd,
      routineType: routineType,
      weekday: weekday,
      weekdays: weekdays,
      projectPath: projectPath,
      projectTitle: projectTitle
    }
  }

  // タスク表示判定（ヘルパー）
  shouldShowTask(taskObj, dateStr, todayExecutions, runningTaskPathsOnLoad, duplicatedInstances) {
    const executions = todayExecutions.filter(exec => exec.taskTitle === taskObj.title)
    
    // ルーチンタスクの判定
    if (taskObj.isRoutine) {
      if (taskObj.routineStart && dateStr < taskObj.routineStart) return false
      if (taskObj.routineEnd && dateStr > taskObj.routineEnd) return false
      
      // 週1ルーチンの判定
      if (taskObj.routineType === 'weekly') {
        const isCreationDate = taskObj.routineStart && dateStr === taskObj.routineStart
        const hasExecutions = executions.length > 0
        const isTargetWeekday = this.shouldShowWeeklyRoutine(taskObj, this.currentDate)
        
        if (!isCreationDate && !hasExecutions && !isTargetWeekday) return false
      }
      
      return true
    }
    
    // 非ルーチンタスクの判定
    if (executions.length > 0) return true
    if (runningTaskPathsOnLoad.includes(taskObj.path)) return true
    if (duplicatedInstances.some(dup => dup.path === taskObj.path)) return true
    
    // target_dateまたは作成日の判定（簡略化）
    return false // 詳細な実装は省略
  }

  // ========== フェーズ3: シンプルなドラッグ&ドロップ実装 ==========
  
  // 新しいmoveInstanceToSlot（超シンプル版）
  moveInstanceToSlotSimple(taskInstance, targetSlot, targetIndex) {
    // 同じ状態のタスクのみ抽出
    const sameTasks = this.taskInstances.filter(
      inst => inst.slotKey === targetSlot && 
              inst.state === taskInstance.state && 
              inst !== taskInstance
    )
    
    // 新しいorder計算
    const newOrder = this.calculateSimpleOrder(targetIndex, sameTasks)
    
    // 更新
    taskInstance.slotKey = targetSlot
    taskInstance.order = newOrder
    
    // 保存
    this.saveTaskOrders()
    
    // 再ソート・再描画
    this.sortByOrder()
    this.renderTaskList()
  }

  // ========== フェーズ4: クリーンアップ関数 ==========
  
  // 古いlocalStorageキーを削除
  cleanupOldStorageKeys() {
    const keysToCheck = []
    
    // すべてのlocalStorageキーを取得
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      keysToCheck.push(key)
    }
    
    // 削除対象のキーパターン
    const patternsToDelete = [
      /^taskchute-manual-position-/,
      /^taskchute-slotkey-/
    ]
    
    let deletedCount = 0
    keysToCheck.forEach(key => {
      if (patternsToDelete.some(pattern => pattern.test(key))) {
        localStorage.removeItem(key)
        deletedCount++
      }
    })
    
    if (deletedCount > 0) {
      console.log(`[TaskChute] 古いlocalStorageキーを${deletedCount}個削除しました`)
    }
  }

  // デバッグ用: グローバル関数を設定
  setupDebugFunctions() {
    // グローバルにデバッグ関数を公開
    window.TaskChuteDebug = {
      toggleSort: () => this.toggleSortMethod(),
      normalizeOrders: () => this.normalizeAllOrders(),
      enableOrderSort: () => {
        this.useOrderBasedSort = true
        localStorage.setItem("taskchute-use-order-sort", "true")
        this.sortTaskInstancesByTimeOrder()
        this.renderTaskList()
        new Notice("orderベースソートを有効化")
      },
      disableOrderSort: () => {
        this.useOrderBasedSort = false
        localStorage.setItem("taskchute-use-order-sort", "false")
        this.sortTaskInstancesByTimeOrder()
        this.renderTaskList()
        new Notice("従来ソートを有効化")
      },
      showOrders: () => {
        console.log("=== 現在の順序番号 ===")
        this.taskInstances.forEach((inst) => {
          console.log(
            `${inst.task.title}: order=${inst.order}, slot=${inst.slotKey}, state=${inst.state}`,
          )
        })
      },
      cleanupOldKeys: () => this.cleanupOldStorageKeys(),
    }

    console.log("[TaskChute] デバッグ関数を設定: window.TaskChuteDebug")
  }

  // 古いlocalStorageキーをクリーンアップ（フェーズ3）
  cleanupOldStorageKeys() {
    if (!this.useOrderBasedSort) {
      new Notice("orderベースのソート方式が有効になっていません")
      return
    }

    let removedCount = 0
    const keysToRemove = []

    // 古いキーパターンを検索
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (
        key &&
        (key.startsWith("taskchute-manual-position-") ||
          key.startsWith("taskchute-position-in-slot-"))
      ) {
        keysToRemove.push(key)
      }
    }

    // 古いキーを削除
    keysToRemove.forEach((key) => {
      localStorage.removeItem(key)
      removedCount++
      console.log(`[TaskChute] 古いキーを削除: ${key}`)
    })

    new Notice(`古いlocalStorageキーを${removedCount}個削除しました`)
    console.log(
      `[TaskChute] 古いlocalStorageキーのクリーンアップ完了: ${removedCount}個削除`,
    )
  }

  // 手動配置フラグをリセットする（デバッグ用）
  resetManualPositioning(taskPath) {
    if (this.useOrderBasedSort) {
      console.log(
        `[TaskChute] orderベースソート使用中のため、手動配置フラグのリセットはスキップ`,
      )
      return
    }

    localStorage.removeItem(
      `taskchute-manual-position-${this.getCurrentDateString()}-${taskPath}`,
    )
    console.log(`[TaskChute] 手動配置フラグをリセット: ${taskPath}`)

    // 該当するタスクインスタンスのフラグもリセット
    this.taskInstances.forEach((inst) => {
      if (
        inst.task.path === taskPath &&
        inst.manuallyPositioned !== undefined
      ) {
        inst.manuallyPositioned = false
      }
    })

    this.renderTaskList()
  }

  // 全タスクの手動配置フラグをリセットする（デバッグ用）
  resetAllManualPositioning() {
    if (this.useOrderBasedSort) {
      console.log(
        `[TaskChute] orderベースソート使用中のため、手動配置フラグのリセットはスキップ`,
      )
      return
    }

    this.taskInstances.forEach((inst) => {
      if (inst.manuallyPositioned !== undefined) {
        inst.manuallyPositioned = false
      }
      localStorage.removeItem(
        `taskchute-manual-position-${this.getCurrentDateString()}-${
          inst.task.path
        }`,
      )
    })
    console.log(`[TaskChute] 全タスクの手動配置フラグをリセット`)
    this.renderTaskList()
  }

  // タスクの右クリックメニューを表示
  showTaskContextMenu(e, inst) {
    // 既存のメニューを削除
    const existingMenu = document.querySelector(".taskchute-context-menu")
    if (existingMenu) {
      existingMenu.remove()
    }

    const menu = document.createElement("div")
    menu.className = "taskchute-context-menu"
    menu.style.position = "fixed"
    menu.style.left = e.clientX + "px"
    menu.style.top = e.clientY + "px"
    menu.style.backgroundColor = "var(--background-primary)"
    menu.style.border = "1px solid var(--background-modifier-border)"
    menu.style.borderRadius = "4px"
    menu.style.padding = "4px 0"
    menu.style.zIndex = "10000"
    menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)"
    menu.style.minWidth = "150px"

    // 自動配置に戻すオプション
    if (inst.manuallyPositioned) {
      const resetOption = document.createElement("div")
      resetOption.className = "context-menu-item"
      resetOption.textContent = "自動配置に戻す"
      resetOption.style.padding = "6px 12px"
      resetOption.style.cursor = "pointer"
      resetOption.style.fontSize = "13px"
      resetOption.addEventListener("mouseenter", () => {
        resetOption.style.backgroundColor = "var(--background-modifier-hover)"
      })
      resetOption.addEventListener("mouseleave", () => {
        resetOption.style.backgroundColor = "transparent"
      })
      resetOption.addEventListener("click", () => {
        this.resetManualPositioning(inst.task.path)
        menu.remove()
      })
      menu.appendChild(resetOption)
    }

    // 時間帯移動オプション
    const timeSlots = this.getTimeSlotKeys()
    const currentSlot = inst.slotKey

    timeSlots.forEach((slot) => {
      if (slot !== currentSlot) {
        const moveOption = document.createElement("div")
        moveOption.className = "context-menu-item"
        moveOption.textContent = `${slot}に移動`
        moveOption.style.padding = "6px 12px"
        moveOption.style.cursor = "pointer"
        moveOption.style.fontSize = "13px"
        moveOption.addEventListener("mouseenter", () => {
          moveOption.style.backgroundColor = "var(--background-modifier-hover)"
        })
        moveOption.addEventListener("mouseleave", () => {
          moveOption.style.backgroundColor = "transparent"
        })
        moveOption.addEventListener("click", () => {
          const currentSlotInstances = this.taskInstances.filter(
            (i) => i.slotKey === currentSlot,
          )
          const currentIndex = currentSlotInstances.indexOf(inst)
          this.moveInstanceToSlot(currentSlot, currentIndex, slot, 0)
          menu.remove()
        })
        menu.appendChild(moveOption)
      }
    })

    // "時間指定なし"に移動オプション
    if (currentSlot !== "none") {
      const moveToNoneOption = document.createElement("div")
      moveToNoneOption.className = "context-menu-item"
      moveToNoneOption.textContent = "時間指定なしに移動"
      moveToNoneOption.style.padding = "6px 12px"
      moveToNoneOption.style.cursor = "pointer"
      moveToNoneOption.style.fontSize = "13px"
      moveToNoneOption.addEventListener("mouseenter", () => {
        moveToNoneOption.style.backgroundColor =
          "var(--background-modifier-hover)"
      })
      moveToNoneOption.addEventListener("mouseleave", () => {
        moveToNoneOption.style.backgroundColor = "transparent"
      })
      moveToNoneOption.addEventListener("click", () => {
        const currentSlotInstances = this.taskInstances.filter(
          (i) => i.slotKey === currentSlot,
        )
        const currentIndex = currentSlotInstances.indexOf(inst)
        this.moveInstanceToSlot(currentSlot, currentIndex, "none", 0)
        menu.remove()
      })
      menu.appendChild(moveToNoneOption)
    }

    document.body.appendChild(menu)

    // メニューの外をクリックしたら閉じる
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove()
        document.removeEventListener("click", closeMenu)
      }
    }
    setTimeout(() => {
      document.addEventListener("click", closeMenu)
    }, 0)
  }

  // 今日の実行履歴を読み込み → 指定日付の実行履歴を読み込み（JSONベース）
  async loadTodayExecutions(dateString) {
    try {
      // 月次ログファイルのパスを生成
      const [year, month] = dateString.split("-")
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`

      // ログファイルが存在しない場合は空配列を返す
      if (!(await this.app.vault.adapter.exists(logFilePath))) {
        return []
      }

      // ログファイルを読み込み
      const logContent = await this.app.vault.adapter.read(logFilePath)
      const monthlyLog = JSON.parse(logContent)

      // 指定日付のタスク実行履歴を取得
      const dayExecutions = monthlyLog.taskExecutions?.[dateString] || []

      // 完了したタスクのみをフィルタリングし、TaskChute形式に変換
      const executions = dayExecutions
        .filter((exec) => exec.isCompleted && exec.startTime && exec.stopTime)
        .map((exec) => {
          // 時刻文字列をDateオブジェクトに変換
          const today = new Date(dateString + "T00:00:00+09:00")
          const [startHour, startMin, startSec] = exec.startTime
            .split(":")
            .map(Number)
          const [stopHour, stopMin, stopSec] = exec.stopTime
            .split(":")
            .map(Number)

          const startTime = new Date(
            today.getTime() +
              (startHour * 3600 + startMin * 60 + startSec) * 1000,
          )
          const stopTime = new Date(
            today.getTime() + (stopHour * 3600 + stopMin * 60 + stopSec) * 1000,
          )

          return {
            taskTitle: exec.taskName,
            startTime: startTime,
            stopTime: stopTime,
            slotKey: exec.slot || "none",
            instanceId: exec.instanceId, // instanceIdを追加
          }
        })

      return executions
    } catch (error) {
      console.error("実行履歴の読み込みに失敗:", error)
      return []
    }
  }

  // 実行中タスクの状態を復元
  async restoreRunningTaskState() {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      if (!(await this.app.vault.adapter.exists(dataPath))) {
        return // ファイルがなければ何もしない
      }

      const content = await this.app.vault.adapter.read(dataPath)
      const runningTasksData = JSON.parse(content) // 配列を期待

      if (!Array.isArray(runningTasksData)) return

      // 削除済みタスクリストを取得
      let deletedTasks = []
      try {
        deletedTasks = JSON.parse(
          localStorage.getItem("taskchute-deleted-tasks") || "[]",
        )
      } catch (e) {
        deletedTasks = []
      }

      const currentDate = this.currentDate
      const y = currentDate.getFullYear()
      const m = (currentDate.getMonth() + 1).toString().padStart(2, "0")
      const d = currentDate.getDate().toString().padStart(2, "0")
      const currentDateString = `${y}-${m}-${d}`

      let restored = false
      for (const runningData of runningTasksData) {
        if (runningData.date !== currentDateString) continue

        // 削除済みタスクはスキップ
        if (
          runningData.taskPath &&
          deletedTasks.includes(runningData.taskPath)
        ) {
          console.log(
            `[TaskChute] 削除済みタスクをスキップ: ${runningData.taskTitle} (${runningData.taskPath})`,
          )
          continue
        }

        // まず既存のタスクインスタンスを探す
        // 保存されたslotKeyと一致するインスタンスを優先的に探す
        let runningInstance = this.taskInstances.find(
          (inst) =>
            inst.task.path === runningData.taskPath && 
            inst.state === "idle" &&
            inst.slotKey === runningData.slotKey
        )
        
        // slotKeyが一致するインスタンスが見つからない場合は、
        // 異なるslotKeyのインスタンスを探して移動させる
        if (!runningInstance) {
          runningInstance = this.taskInstances.find(
            (inst) =>
              inst.task.path === runningData.taskPath && inst.state === "idle",
          )

          // 見つかった場合は正しいslotKeyに移動
          if (runningInstance) {
            runningInstance.slotKey = runningData.slotKey
          }
        }

        // 見つからない場合、タスクインスタンスを再作成
        if (!runningInstance) {
          let recreatedTask

          if (runningData.taskPath) {
            // ルーチンタスクの場合：pathがあるのでファイルベースで再作成
            recreatedTask = {
              id: runningData.taskId || `temp-${Date.now()}`,
              title: runningData.taskTitle,
              description: runningData.taskDescription || "",
              path: runningData.taskPath,
              isRoutine: runningData.isRoutine || false,
              file: null, // 実際のファイルオブジェクトは後で必要に応じて取得
            }
          } else {
            // 非ルーチンタスクの場合：pathがないので一時的なタスクとして再作成
            recreatedTask = {
              id: runningData.taskId || `temp-${Date.now()}`,
              title: runningData.taskTitle,
              description: runningData.taskDescription || "",
              path: null,
              isRoutine: false,
              file: null,
            }
          }

          // タスクインスタンスを作成
          const recreatedInstance = {
            task: recreatedTask,
            slotKey: runningData.slotKey || "未分類",
            state: "idle",
            startTime: null,
            stopTime: null,
            order: null, // initializeTaskOrdersで設定される
            instanceId:
              runningData.instanceId ||
              this.generateInstanceId(
                recreatedTask.path || `temp-${Date.now()}`,
              ), // 保存されたIDまたは新規生成
          }

          // manuallyPositionedフィールドは削除

          // タスクインスタンスを追加
          this.taskInstances.push(recreatedInstance)
          runningInstance = recreatedInstance
        }

        if (runningInstance) {
          runningInstance.state = "running"
          runningInstance.startTime = new Date(runningData.startTime)
          runningInstance.stopTime = null
          runningInstance.originalSlotKey =
            runningData.originalSlotKey || runningData.slotKey // 開始時のslotKeyを復元
          restored = true
        }
      }

      if (restored) {
        this.renderTaskList()
        this.manageTimers()
      }
    } catch (error) {
      console.error("実行中タスクの復元に失敗:", error)
    }
  }

  // 実行中タスクの状態を保存
  async saveRunningTasksState() {
    try {
      const runningInstances = this.taskInstances.filter(
        (inst) => inst.state === "running",
      )

      const dataToSave = runningInstances.map((inst) => {
        const today = new Date(inst.startTime)
        const y = today.getFullYear()
        const m = (today.getMonth() + 1).toString().padStart(2, "0")
        const d = today.getDate().toString().padStart(2, "0")
        const dateString = `${y}-${m}-${d}`

        return {
          date: dateString,
          taskTitle: inst.task.title,
          taskPath: inst.task.path,
          startTime: inst.startTime.toISOString(),
          // 非ルーチンタスクの場合に必要な情報を追加保存
          taskDescription: inst.task.description || "",
          slotKey: inst.slotKey,
          originalSlotKey: inst.originalSlotKey || inst.slotKey, // 開始時のslotKeyも保存
          isRoutine: inst.task.isRoutine || false,
          taskId: inst.task.id,
          instanceId: inst.instanceId, // インスタンスIDを保存
        }
      })

      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      const content = JSON.stringify(dataToSave, null, 2)

      // ディレクトリが存在しない場合は作成
      const dirPath = this.plugin.pathManager.getLogDataPath()
      if (!(await this.app.vault.adapter.exists(dirPath))) {
        await this.app.vault.createFolder(dirPath)
      }

      // 常に上書き保存する
      await this.app.vault.adapter.write(dataPath, content)
    } catch (error) {
      console.error("実行中タスクの保存に失敗:", error)
      new Notice("実行中タスクの保存に失敗しました")
    }
  }

  // 実行中タスクの状態を削除 (不要になるが、安全のために残しておく)
  async clearRunningTaskState() {
    await this.saveRunningTasksState() // 空の配列を書き込むのと同じ
  }

  // 実行中タスクのパスを更新（ファイルリネーム時）
  async updateRunningTaskPath(oldPath, newPath, newTitle) {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      if (!(await this.app.vault.adapter.exists(dataPath))) {
        return
      }

      const content = await this.app.vault.adapter.read(dataPath)
      const runningTasksData = JSON.parse(content)

      if (!Array.isArray(runningTasksData)) return

      // 該当するタスクのパスとタイトルを更新
      let updated = false
      runningTasksData.forEach((task) => {
        if (task.taskPath === oldPath) {
          task.taskPath = newPath
          task.taskTitle = newTitle
          updated = true
        }
      })

      if (updated) {
        const updatedContent = JSON.stringify(runningTasksData, null, 2)
        await this.app.vault.adapter.write(dataPath, updatedContent)
        console.log(
          `[TaskChute] 実行中タスクのパスを更新: ${oldPath} → ${newPath}`,
        )
      }
    } catch (error) {
      console.error("実行中タスクのパス更新に失敗:", error)
    }
  }

  // インスタンスのみ削除（複製タスク用）
  async deleteInstanceOnly(inst, deletionType = "temporary") {
    console.log(
      `[TaskChute] インスタンスを削除: ${inst.task.title} (instanceId: ${inst.instanceId}, type: ${deletionType})`,
    )
    
    // 1. インスタンスをtaskInstancesから削除
    this.taskInstances = this.taskInstances.filter((i) => i !== inst)
    
    // 2. 削除済みインスタンスとして記録
    const dateStr = this.getCurrentDateString()
    const deletedInstances = this.getDeletedInstances(dateStr)
    
    // 新しい削除記録を追加
    deletedInstances.push({
      path: inst.task.path,
      instanceId: inst.instanceId,
      deletionType: deletionType,
      deletedAt: new Date().toISOString()
    })
    
    this.saveDeletedInstances(dateStr, deletedInstances)
    
    // 3. 複製情報から削除（複製タスクの場合）
    const duplicationKey = `taskchute-duplicated-instances-${dateStr}`
    try {
      let duplicatedInstances = []
      const storageData = JSON.parse(localStorage.getItem(duplicationKey) || "[]")
      
      // 後方互換性処理
      if (storageData.length > 0 && typeof storageData[0] === "string") {
        duplicatedInstances = storageData.map((path) => ({
          path: path,
          instanceId: this.generateInstanceId(path),
        }))
      } else {
        duplicatedInstances = storageData
      }
      
      // 該当するinstanceIdを削除
      duplicatedInstances = duplicatedInstances.filter(
        (dup) => dup.instanceId !== inst.instanceId,
      )
      localStorage.setItem(duplicationKey, JSON.stringify(duplicatedInstances))
    } catch (e) {
      console.error("[TaskChute] 複製情報の更新に失敗:", e)
    }
    
    // 4. 特定のインスタンスIDのログのみを削除
    if (inst.instanceId) {
      try {
        await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
      } catch (e) {
        console.error("[TaskChute] インスタンス固有のログ削除に失敗:", e)
      }
    }
    
    // 5. 実行中タスクの場合は running-task.json を更新
    if (inst.state === "running") {
      await this.saveRunningTasksState()
    }
    
    this.renderTaskList()
    new Notice(`「${inst.task.title}」を削除しました。`)
  }

  // 複製されたインスタンスの削除（プランA） - 後方互換性のため残す
  async deleteDuplicatedInstance(inst) {
    await this.deleteInstanceOnly(inst, "temporary")
  }

  // インスタンスとファイルを削除（最後のインスタンス用）
  async deleteInstanceWithFile(inst, deletionType = "permanent") {
    console.log(
      `[TaskChute] 最後のインスタンスを削除（ファイルも削除）: ${inst.task.title}`,
    )
    
    // 1. インスタンスをtaskInstancesから削除
    this.taskInstances = this.taskInstances.filter((i) => i !== inst)
    this.tasks = this.tasks.filter((t) => t.path !== inst.task.path)
    
    try {
      // 2. ファイルを削除
      await this.app.vault.delete(inst.task.file)
      
      // 3. 削除済みインスタンスとして記録（永続削除）
      const dateStr = this.getCurrentDateString()
      const deletedInstances = this.getDeletedInstances(dateStr)
      
      deletedInstances.push({
        path: inst.task.path,
        instanceId: inst.instanceId,
        deletionType: deletionType,
        deletedAt: new Date().toISOString()
      })
      
      this.saveDeletedInstances(dateStr, deletedInstances)
      
      // 4. タスクログも削除
      await this.deleteTaskLogs(inst.task.path)
      
      // 5. 実行中タスクの場合は running-task.json を更新
      if (inst.state === "running") {
        await this.saveRunningTasksState()
      }
      
      this.renderTaskList()
      new Notice(`「${inst.task.title}」を完全に削除しました。`)
    } catch (err) {
      console.error("[TaskChute] ファイル削除に失敗:", err)
      new Notice("ファイル削除に失敗しました")
    }
  }

  // 最後のインスタンスの削除（プランB） - 後方互換性のため残す
  async deleteLastInstance(inst) {
    await this.deleteInstanceWithFile(inst, "permanent")
  }
  
  // 非ルーチンタスクの削除
  async deleteNonRoutineTask(inst) {
    const samePathInstances = this.taskInstances.filter(
      i => i !== inst && i.task.path === inst.task.path
    )
    
    if (samePathInstances.length > 0) {
      // 複製インスタンスの削除
      await this.deleteInstanceOnly(inst, "temporary")
    } else {
      // 最後のインスタンス：ファイルも削除
      await this.deleteInstanceWithFile(inst, "permanent")
    }
  }
  
  // ルーチンタスクの削除（非表示化）
  async deleteRoutineTask(inst) {
    console.log(
      `[TaskChute] ルーチンタスクを非表示化: ${inst.task.title} (instanceId: ${inst.instanceId})`,
    )
    
    // 1. インスタンスをtaskInstancesから削除
    this.taskInstances = this.taskInstances.filter((i) => i !== inst)
    
    // 2. 複製されたタスクかどうかを判定
    const dateStr = this.getCurrentDateString()
    const duplicationKey = `taskchute-duplicated-instances-${dateStr}`
    let isDuplicated = false
    
    try {
      const duplicatedInstances = JSON.parse(localStorage.getItem(duplicationKey) || "[]")
      isDuplicated = duplicatedInstances.some(dup => 
        dup.instanceId === inst.instanceId || 
        (dup.path === inst.task.path && !dup.instanceId)
      )
    } catch (e) {
      isDuplicated = false
    }
    
    // 非表示リストに追加
    const hiddenRoutines = this.getHiddenRoutines(dateStr)
    const alreadyHidden = hiddenRoutines.some(hidden => {
      if (typeof hidden === 'string') {
        return hidden === inst.task.path
      }
      if (isDuplicated) {
        // 複製の場合はインスタンスIDで判定
        return hidden.instanceId === inst.instanceId
      } else {
        // 複製でない場合はパスで判定
        return hidden.path === inst.task.path && !hidden.instanceId
      }
    })
    
    if (!alreadyHidden) {
      hiddenRoutines.push({
        path: inst.task.path,
        instanceId: isDuplicated ? inst.instanceId : null  // 複製の場合のみインスタンスIDを保存
      })
      this.saveHiddenRoutines(dateStr, hiddenRoutines)
    }
    
    // 複製リストからも削除（複製の場合のみ）
    if (isDuplicated) {
      try {
        let duplicatedInstances = JSON.parse(localStorage.getItem(duplicationKey) || "[]")
        duplicatedInstances = duplicatedInstances.filter(
          dup => dup.instanceId !== inst.instanceId
        )
        localStorage.setItem(duplicationKey, JSON.stringify(duplicatedInstances))
      } catch (e) {
        console.error("[TaskChute] 複製情報の更新に失敗:", e)
      }
    }
    
    // 3. ルーチンタスクでも実行ログがあれば削除する（インスタンス単位）
    if (isDuplicated && inst.instanceId) {
      try {
        await this.deleteTaskLogsByInstanceId(inst.task.path, inst.instanceId)
      } catch (e) {
        console.error("ルーチンタスクのログ削除に失敗:", e)
      }
    } else {
      try {
        await this.deleteTaskLogs(inst.task.path)
      } catch (e) {
        console.error("ルーチンタスクのログ削除に失敗:", e)
      }
    }
    
    // 4. 実行中タスクの場合は running-task.json を更新
    if (inst.state === "running") {
      await this.saveRunningTasksState()
    }
    
    this.renderTaskList()
    
    if (isDuplicated) {
      new Notice(`「${inst.task.title}」の複製を削除しました。`)
    } else {
      new Notice(`「${inst.task.title}」を本日のリストから非表示にしました。`)
    }
  }

  // 実行中タスクが指定日に開始されたかチェック
  async isRunningTaskStartedToday(taskPath, dateString) {
    try {
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const dataPath = `${logDataPath}/running-task.json`
      if (!(await this.app.vault.adapter.exists(dataPath))) {
        return false
      }

      const content = await this.app.vault.adapter.read(dataPath)
      const runningTasksData = JSON.parse(content)

      if (!Array.isArray(runningTasksData)) return false

      // 指定されたタスクパスで、指定された日付に開始されたタスクがあるかチェック
      return runningTasksData.some(
        (runningData) =>
          runningData.taskPath === taskPath && runningData.date === dateString,
      )
    } catch (error) {
      console.error("実行中タスクの開始日チェックに失敗:", error)
      return false // エラーの場合は安全のため非表示
    }
  }

  async toggleRoutine(task, button) {
    try {
      if (task.isRoutine) {
        // ルーチンタスクを解除: frontmatterを消さずroutine_endとroutine:falseのみ記録
        await this.app.fileManager.processFrontMatter(
          task.file,
          (frontmatter) => {
            const y = this.currentDate.getFullYear()
            const m = (this.currentDate.getMonth() + 1)
              .toString()
              .padStart(2, "0")
            const d = this.currentDate.getDate().toString().padStart(2, "0")
            frontmatter.routine_end = `${y}-${m}-${d}`
            frontmatter.routine = false
            delete frontmatter.開始時刻
            return frontmatter
          },
        )

        // 状態リセット（slotKeyは維持）
        task.isRoutine = false
        task.scheduledTime = null
        // slotKeyはそのまま
        button.classList.remove("active")
        button.setAttribute("title", "ルーチンタスクに設定")

        // タスク情報を再取得し、UIを最新化
        await this.loadTasks()
        new Notice(`「${task.title}」をルーチンタスクから解除しました`)
      } else {
        // ルーチンタスクに設定（時刻入力ポップアップを表示）
        this.showRoutineEditModal(task, button)
      }
    } catch (error) {
      console.error("ルーチンタスクの切り替えに失敗しました:", error)
      new Notice("ルーチンタスクの設定に失敗しました")
    }
  }

  showRoutineTimeModal(task, button) {
    // モーダルコンテナ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", { text: `「${task.title}」のルーチン設定` })

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // ルーチンタイプ選択
    const typeGroup = form.createEl("div", { cls: "form-group" })
    typeGroup.createEl("label", { text: "ルーチンタイプ:", cls: "form-label" })

    const typeContainer = typeGroup.createEl("div", { cls: "radio-group" })

    const dailyRadio = typeContainer.createEl("input", {
      type: "radio",
      id: "routine-daily",
      name: "routineType",
      value: "daily",
      checked: true,
    })
    const dailyLabel = typeContainer.createEl("label", {
      text: "毎日",
      attr: { for: "routine-daily" },
    })

    const weeklyRadio = typeContainer.createEl("input", {
      type: "radio",
      id: "routine-weekly",
      name: "routineType",
      value: "weekly",
    })
    const weeklyLabel = typeContainer.createEl("label", {
      text: "週1回",
      attr: { for: "routine-weekly" },
    })

    // 曜日選択（週1回の場合のみ表示）
    const weekdayGroup = form.createEl("div", {
      cls: "form-group",
      style: "display: none;",
    })
    weekdayGroup.id = "weekday-group"
    weekdayGroup.createEl("label", { text: "曜日:", cls: "form-label" })

    const weekdaySelect = weekdayGroup.createEl("select", {
      cls: "form-input",
    })

    const weekdays = [
      { value: "0", text: "日曜日" },
      { value: "1", text: "月曜日" },
      { value: "2", text: "火曜日" },
      { value: "3", text: "水曜日" },
      { value: "4", text: "木曜日" },
      { value: "5", text: "金曜日" },
      { value: "6", text: "土曜日" },
    ]

    weekdays.forEach((day) => {
      const option = weekdaySelect.createEl("option", {
        value: day.value,
        text: day.text,
      })
      if (
        task.routineType === "weekly" &&
        task.weekday === parseInt(day.value)
      ) {
        option.selected = true
      }
    })

    // 開始時刻入力
    const timeGroup = form.createEl("div", { cls: "form-group" })
    timeGroup.createEl("label", { text: "開始予定時刻:", cls: "form-label" })
    const timeInput = timeGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: "09:00",
    })

    // 説明
    const descGroup = form.createEl("div", { cls: "form-group" })
    const descText = descGroup.createEl("p", {
      text: "この時刻にルーチンタスクとして実行予定です。",
      cls: "form-description",
    })

    // ルーチンタイプ変更時の処理
    const updateDescription = () => {
      const isWeekly = weeklyRadio.checked
      weekdayGroup.style.display = isWeekly ? "block" : "none"

      if (isWeekly) {
        const selectedWeekday = weekdaySelect.value
        const weekdayName =
          weekdays.find((d) => d.value === selectedWeekday)?.text || ""
        descText.textContent = `毎週${weekdayName}の${timeInput.value}にルーチンタスクとして実行予定です。`
      } else {
        descText.textContent =
          "毎日この時刻にルーチンタスクとして実行予定です。"
      }
    }

    dailyRadio.addEventListener("change", updateDescription)
    weeklyRadio.addEventListener("change", updateDescription)
    weekdaySelect.addEventListener("change", updateDescription)
    timeInput.addEventListener("input", updateDescription)

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    })
    const createButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "設定",
    })

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    form.addEventListener("submit", async (e) => {
      e.preventDefault()

      const routineType = weeklyRadio.checked ? "weekly" : "daily"
      const scheduledTime = timeInput.value
      const weekday =
        routineType === "weekly" ? parseInt(weekdaySelect.value) : null

      if (!scheduledTime) {
        new Notice("開始時刻を入力してください")
        return
      }

      if (routineType === "weekly" && weekday === null) {
        new Notice("曜日を選択してください")
        return
      }

      await this.setRoutineTask(
        task,
        button,
        scheduledTime,
        routineType,
        weekday,
      )
      document.body.removeChild(modal)
    })

    // モーダルを表示
    document.body.appendChild(modal)

    // フォーカスを設定
    timeInput.focus()
  }

  async setRoutineTask(task, button, scheduledTime, routineType, weekday) {
    try {
      await this.ensureFrontMatter(task.file)
      // メタデータを更新
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          // ルーチンフラグをtrueに設定
          frontmatter.routine = true
          // 開始時刻を設定
          frontmatter.開始時刻 = scheduledTime
          // ルーチンタイプを設定
          frontmatter.routine_type = routineType
          // 週1回の場合は曜日も設定
          if (routineType === "weekly" && weekday !== null) {
            frontmatter.weekday = weekday
          } else {
            // 毎日の場合は曜日を削除
            delete frontmatter.weekday
          }
          // ルーチン化した日付を記録
          if (!frontmatter.routine_start) {
            const y = this.currentDate.getFullYear()
            const m = (this.currentDate.getMonth() + 1)
              .toString()
              .padStart(2, "0")
            const d = this.currentDate.getDate().toString().padStart(2, "0")
            frontmatter.routine_start = `${y}-${m}-${d}`
          }
          // routine_endを必ず削除
          if (frontmatter.routine_end) {
            delete frontmatter.routine_end
          }
          return frontmatter
        },
      )

      task.isRoutine = true
      task.scheduledTime = scheduledTime
      task.routineType = routineType
      task.weekday = weekday
      button.classList.add("active")

      // ルーチンタスクに設定された場合、手動配置フラグをリセット
      // （初期表示時の時間順ソートを有効にするため）
      // ただし、その後の手動操作は尊重される
      localStorage.removeItem(
        `taskchute-manual-position-${this.getCurrentDateString()}-${task.path}`,
      )

      // ボタンのタイトルを更新
      let titleText = "ルーチンタスク"
      if (routineType === "weekly" && weekday !== null) {
        const weekdayName = this.getWeekdayName(weekday)
        titleText = `週1回ルーチン（毎週${weekdayName} ${scheduledTime}開始予定）`
      } else {
        titleText = `ルーチンタスク（${scheduledTime}開始予定）`
      }
      button.setAttribute("title", titleText)

      // タスクリストを再描画
      this.renderTaskList()

      let noticeText = ""
      if (routineType === "weekly" && weekday !== null) {
        const weekdayName = this.getWeekdayName(weekday)
        noticeText = `「${task.title}」を週1回ルーチンに設定しました（毎週${weekdayName} ${scheduledTime}開始予定）`
      } else {
        noticeText = `「${task.title}」をルーチンタスクに設定しました（${scheduledTime}開始予定）`
      }
      new Notice(noticeText)
    } catch (error) {
      console.error("ルーチンタスクの設定に失敗しました:", error)
      new Notice("ルーチンタスクの設定に失敗しました")
    }
  }

  // 拡張版のルーチンタスク設定メソッド（複数曜日対応）
  async setRoutineTaskExtended(task, button, scheduledTime, routineType, weekday, weekdaysArray) {
    try {
      console.log("[setRoutineTaskExtended] Starting with:", {
        routineType,
        weekday,
        weekdaysArray
      });

      await this.ensureFrontMatter(task.file)
      // メタデータを更新
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          // ルーチンフラグをtrueに設定
          frontmatter.routine = true
          // 開始時刻を設定
          frontmatter.開始時刻 = scheduledTime
          // ルーチンタイプを設定
          frontmatter.routine_type = routineType

          // カスタムタイプの場合はweekdays配列を設定
          if (routineType === "custom" && weekdaysArray) {
            frontmatter.weekdays = weekdaysArray
            // 後方互換性のため、単一曜日の場合はweekdayも設定
            if (weekday !== null) {
              frontmatter.weekday = weekday
            }
          } else if (routineType === "daily") {
            // 毎日の場合は曜日関連を削除
            delete frontmatter.weekday
            delete frontmatter.weekdays
          }

          // ルーチン化した日付を記録
          if (!frontmatter.routine_start) {
            const y = this.currentDate.getFullYear()
            const m = (this.currentDate.getMonth() + 1)
              .toString()
              .padStart(2, "0")
            const d = this.currentDate.getDate().toString().padStart(2, "0")
            frontmatter.routine_start = `${y}-${m}-${d}`
          }
          // routine_endを必ず削除
          if (frontmatter.routine_end) {
            delete frontmatter.routine_end
          }
          return frontmatter
        },
      )

      task.isRoutine = true
      task.scheduledTime = scheduledTime
      task.routineType = routineType
      task.weekday = weekday
      task.weekdays = weekdaysArray
      button.classList.add("active")

      // ルーチンタスクに設定された場合、手動配置フラグをリセット
      localStorage.removeItem(
        `taskchute-manual-position-${this.getCurrentDateString()}-${task.path}`,
      )

      // ボタンのタイトルを更新
      let titleText = "ルーチンタスク"
      let noticeText = ""
      
      if (routineType === "custom" && weekdaysArray && weekdaysArray.length > 0) {
        const weekdayNames = weekdaysArray.map(day => this.getWeekdayName(day)).join("・")
        titleText = `カスタムルーチン（毎週 ${weekdayNames} ${scheduledTime}開始予定）`
        noticeText = `「${task.title}」をカスタムルーチンに設定しました（毎週 ${weekdayNames} ${scheduledTime}開始予定）`
      } else if (routineType === "daily") {
        titleText = `ルーチンタスク（${scheduledTime}開始予定）`
        noticeText = `「${task.title}」をルーチンタスクに設定しました（${scheduledTime}開始予定）`
      }
      
      button.setAttribute("title", titleText)

      // タスクリストを再描画
      this.renderTaskList()
      
      new Notice(noticeText)
      console.log("[setRoutineTaskExtended] Successfully saved routine task");
    } catch (error) {
      console.error("ルーチンタスクの設定に失敗しました:", error)
      new Notice("ルーチンタスクの設定に失敗しました")
    }
  }

  // 時間帯グループ定義
  getTimeSlotKeys() {
    return ["0:00-8:00", "8:00-12:00", "12:00-16:00", "16:00-0:00"]
  }

  // タスクインスタンスに一意のIDを生成
  generateInstanceId(taskPath) {
    const timestamp = Date.now()
    const random = Math.random().toString(36).substr(2, 9)
    return `${taskPath}#${timestamp}#${random}`
  }

  // 現在時刻に基づいて時間帯を取得
  getCurrentTimeSlot() {
    const now = new Date()
    const hour = now.getHours()
    const minute = now.getMinutes()
    const timeInMinutes = hour * 60 + minute

    if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
      return "0:00-8:00"
    } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
      return "8:00-12:00"
    } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
      return "12:00-16:00"
    } else {
      return "16:00-0:00"
    }
  }

  // 時刻文字列（HH:MM）から時間帯を判定するヘルパー関数
  getSlotFromTime(timeStr) {
    const [hour, minute] = timeStr.split(":").map(Number)
    const timeInMinutes = hour * 60 + minute

    if (timeInMinutes >= 0 && timeInMinutes < 8 * 60) {
      return "0:00-8:00"
    } else if (timeInMinutes >= 8 * 60 && timeInMinutes < 12 * 60) {
      return "8:00-12:00"
    } else if (timeInMinutes >= 12 * 60 && timeInMinutes < 16 * 60) {
      return "12:00-16:00"
    } else {
      return "16:00-0:00"
    }
  }

  renderTaskList() {
    // スクロール位置を保存
    const scrollTop = this.taskList.scrollTop
    const scrollLeft = this.taskList.scrollLeft

    // ペインの幅を検出してレスポンシブクラスを適用
    this.applyResponsiveClasses()

    this.sortTaskInstancesByTimeOrder()
    this.taskList.empty()
    // slotKeyのみでグループ分け
    const timeSlots = {}
    this.getTimeSlotKeys().forEach((slot) => {
      timeSlots[slot] = []
    })
    let noTimeInstances = []
    this.taskInstances.forEach((inst) => {
      if (inst.slotKey && inst.slotKey !== "none")
        timeSlots[inst.slotKey].push(inst)
      else noTimeInstances.push(inst)
    })
    // 時間指定なしを一番上に表示（タスクがなくても常に表示）
    const noTimeHeader = this.taskList.createEl("div", {
      cls: "time-slot-header other",
      text: "時間指定なし",
    })
    noTimeHeader.addEventListener("dragover", (e) => {
      e.preventDefault()

      // ドラッグ中のタスクが完了済みの場合は何もしない
      const from = e.dataTransfer.types.includes("text/plain") ? true : false
      if (!from) return

      // 時間指定なしグループの完了済み・実行中タスク数を取得
      const noneSlotInstances = this.taskInstances.filter(
        (inst) => inst.slotKey === "none",
      )
      const completedCount = noneSlotInstances.filter(
        (inst) => inst.state === "done",
      ).length
      const runningCount = noneSlotInstances.filter(
        (inst) => inst.state === "running",
      ).length

      // 完了済み・実行中タスクがある場合は、ヘッダーへのドロップを許可
      // （最後の位置に配置される）
      noTimeHeader.classList.add("dragover")
    })
    noTimeHeader.addEventListener("dragleave", () => {
      noTimeHeader.classList.remove("dragover")
    })
    noTimeHeader.addEventListener("drop", (e) => {
      e.preventDefault()
      noTimeHeader.classList.remove("dragover")
      const from = e.dataTransfer.getData("text/plain")
      const [fromSlot, fromIdx] = from.split("::")

      // 時間指定なしグループの完了済み・実行中タスク数を取得
      const noneSlotInstances = this.taskInstances.filter(
        (inst) => inst.slotKey === "none",
      )
      const completedCount = noneSlotInstances.filter(
        (inst) => inst.state === "done",
      ).length
      const runningCount = noneSlotInstances.filter(
        (inst) => inst.state === "running",
      ).length

      this.moveInstanceToSlot(
        fromSlot === "none" ? "none" : fromSlot,
        parseInt(fromIdx),
        "none",
        completedCount + runningCount, // 完了済み・実行中タスクの後に配置
      )
    })
    noTimeInstances.forEach((inst, idx) => {
      this.createTaskInstanceItem(inst, "none", idx)
    })
    // 時間帯グループを下に順番に表示
    this.getTimeSlotKeys().forEach((slot) => {
      const instancesInSlot = timeSlots[slot]
      const timeSlotHeader = this.taskList.createEl("div", {
        cls: "time-slot-header",
        text: slot,
      })
      timeSlotHeader.addEventListener("dragover", (e) => {
        e.preventDefault()

        // ドラッグ中のタスクが完了済みの場合は何もしない
        const from = e.dataTransfer.types.includes("text/plain") ? true : false
        if (!from) return

        // 該当時間帯の完了済み・実行中タスク数を取得
        const slotInstances = this.taskInstances.filter(
          (inst) => inst.slotKey === slot,
        )
        const completedCount = slotInstances.filter(
          (inst) => inst.state === "done",
        ).length
        const runningCount = slotInstances.filter(
          (inst) => inst.state === "running",
        ).length

        // 完了済み・実行中タスクがある場合は、ヘッダーへのドロップを許可
        // （最後の位置に配置される）
        timeSlotHeader.classList.add("dragover")
      })
      timeSlotHeader.addEventListener("dragleave", () => {
        timeSlotHeader.classList.remove("dragover")
      })
      timeSlotHeader.addEventListener("drop", (e) => {
        e.preventDefault()
        timeSlotHeader.classList.remove("dragover")
        const from = e.dataTransfer.getData("text/plain")
        const [fromSlot, fromIdx] = from.split("::")

        // 該当時間帯の完了済み・実行中タスク数を取得
        const slotInstances = this.taskInstances.filter(
          (inst) => inst.slotKey === slot,
        )
        const completedCount = slotInstances.filter(
          (inst) => inst.state === "done",
        ).length
        const runningCount = slotInstances.filter(
          (inst) => inst.state === "running",
        ).length

        this.moveInstanceToSlot(
          fromSlot === "none" ? "none" : fromSlot,
          parseInt(fromIdx),
          slot,
          completedCount + runningCount, // 完了済み・実行中タスクの後に配置
        )
      })
      instancesInSlot.forEach((inst, idx) => {
        this.createTaskInstanceItem(inst, slot, idx)
      })
    })

    // Phase 2: タスクリストコンテナへのdragover追加
    // 既存のイベントリスナーを削除（重複防止）
    if (this.taskListDragoverHandler) {
      this.taskList.removeEventListener("dragover", this.taskListDragoverHandler)
    }
    if (this.taskListDragleaveHandler) {
      this.taskList.removeEventListener("dragleave", this.taskListDragleaveHandler)
    }
    if (this.taskListDropHandler) {
      this.taskList.removeEventListener("drop", this.taskListDropHandler)
    }
    
    // dragoverハンドラー
    this.taskListDragoverHandler = (e) => {
      // 最後のタスクを取得
      const taskItems = this.taskList.querySelectorAll(".task-item")
      if (taskItems.length === 0) return
      
      const lastTask = taskItems[taskItems.length - 1]
      const lastTaskRect = lastTask.getBoundingClientRect()
      
      // 最後のタスクの下にマウスがある場合
      if (e.clientY > lastTaskRect.bottom) {
        e.preventDefault()
        this.taskList.classList.add("dragover-bottom")
      }
    }
    
    // dragleaveハンドラー
    this.taskListDragleaveHandler = (e) => {
      // マウスがtaskListから完全に離れた場合のみクラスを削除
      if (e.target === this.taskList) {
        this.taskList.classList.remove("dragover-bottom")
      }
    }
    
    // dropハンドラー
    this.taskListDropHandler = (e) => {
      const taskItems = this.taskList.querySelectorAll(".task-item")
      if (taskItems.length === 0) return
      
      const lastTask = taskItems[taskItems.length - 1]
      const lastTaskRect = lastTask.getBoundingClientRect()
      
      if (e.clientY > lastTaskRect.bottom) {
        e.preventDefault()
        this.taskList.classList.remove("dragover-bottom")
        
        // Phase 3: 最下部へのドロップ処理
        const from = e.dataTransfer.getData("text/plain")
        const [fromSlot, fromIdx] = from.split("::")
        
        // 現在のslotを特定（最後のタスクから取得）
        const lastTaskSlot = lastTask.getAttribute("data-slot") || "none"
        
        // 該当スロットのタスク数を取得
        const slotInstances = this.taskInstances.filter(
          (i) => i.slotKey === lastTaskSlot
        )
        
        // 最下部にドロップ（全タスクの後）
        this.moveInstanceToSlot(
          fromSlot === "none" ? "none" : fromSlot,
          parseInt(fromIdx),
          lastTaskSlot,
          slotInstances.length // 最後の位置
        )
      }
    }
    
    // イベントリスナーを追加
    this.taskList.addEventListener("dragover", this.taskListDragoverHandler)
    this.taskList.addEventListener("dragleave", this.taskListDragleaveHandler)
    this.taskList.addEventListener("drop", this.taskListDropHandler)
    
    // スクロール位置を復元
    // DOM更新が完了してから復元するため、非同期で実行
    setTimeout(() => {
      this.taskList.scrollTop = scrollTop
      this.taskList.scrollLeft = scrollLeft
    }, 0)
  }

  updateTaskItemDisplay(taskItem, inst) {
    // プレイボタンの更新
    const playButton = taskItem.querySelector(".play-stop-button")
    if (playButton) {
      if (inst.state === "running") {
        playButton.classList.add("stop")
        playButton.textContent = "⏹"
        playButton.setAttribute("title", "ストップ")
      } else if (inst.state === "done") {
        playButton.classList.remove("stop")
        playButton.textContent = "☑️"
        playButton.setAttribute("title", "完了タスクを再計測")
      } else {
        playButton.classList.remove("stop")
        playButton.textContent = "▶️"
        playButton.setAttribute("title", "スタート")
      }
    }

    // 時刻表示の更新
    const timeRangeEl = taskItem.querySelector(".task-time-range")
    if (timeRangeEl) {
      const formatTime = (date) =>
        date
          ? date.toLocaleTimeString("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : ""

      if (inst.state === "running" && inst.startTime) {
        timeRangeEl.textContent = `${formatTime(inst.startTime)} →`
      } else if (inst.state === "done" && inst.startTime && inst.stopTime) {
        timeRangeEl.textContent = `${formatTime(inst.startTime)} → ${formatTime(
          inst.stopTime,
        )}`
      } else {
        timeRangeEl.textContent = ""
      }
    }

    // 実行時間/タイマー表示の更新
    const durationEl = taskItem.querySelector(".task-duration")
    const timerEl = taskItem.querySelector(".task-timer-display")

    if (inst.state === "done" && inst.startTime && inst.stopTime) {
      // 完了済み：実行時間を表示
      if (timerEl) timerEl.remove()

      if (!durationEl) {
        const newDurationEl = taskItem.createEl("span", {
          cls: "task-duration",
        })
        // ルーチンボタンの前に挿入
        const routineButton = taskItem.querySelector(".routine-button")
        if (routineButton) {
          taskItem.insertBefore(newDurationEl, routineButton)
        }
      }

      const duration = inst.stopTime - inst.startTime
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000) % 60
      const durationStr = `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}`

      const finalDurationEl = taskItem.querySelector(".task-duration")
      if (finalDurationEl) {
        finalDurationEl.textContent = durationStr
      }
    } else if (inst.state === "running") {
      // 実行中：タイマー表示
      if (durationEl) durationEl.remove()

      if (!timerEl) {
        const newTimerEl = taskItem.createEl("span", {
          cls: "task-timer-display",
        })
        // ルーチンボタンの前に挿入
        const routineButton = taskItem.querySelector(".routine-button")
        if (routineButton) {
          taskItem.insertBefore(newTimerEl, routineButton)
        }
      }
    } else {
      // アイドル状態：両方削除
      if (durationEl) durationEl.remove()
      if (timerEl) timerEl.remove()
    }

    // 完了状態のスタイル更新
    if (inst.state === "done") {
      taskItem.classList.add("completed")
    } else {
      taskItem.classList.remove("completed")
    }

    // コメントボタンの状態更新
    const commentButton = taskItem.querySelector(".comment-button")
    if (commentButton) {
      this.hasCommentData(inst).then((hasComment) => {
        if (hasComment) {
          commentButton.classList.add("active")
          commentButton.setAttribute("title", "コメントを編集")
        } else {
          commentButton.classList.remove("active")
          commentButton.setAttribute("title", "コメントを記録")
        }
      })
    }
  }

  createTaskInstanceItem(inst, slot, idx) {
    const taskItem = this.taskList.createEl("div", { cls: "task-item" })

    // タスクのパスをデータ属性として設定
    if (inst.task.path) {
      taskItem.setAttribute("data-task-path", inst.task.path)
    }
    
    // Phase 3: スロット情報をデータ属性として設定
    taskItem.setAttribute("data-slot", slot || "none")

    // --- ▼ 未来日タスクの判定を追加 ---
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const viewDate = new Date(this.currentDate)
    viewDate.setHours(0, 0, 0, 0)
    const isFutureTask = viewDate > today
    // --- ▲ 未来日タスクの判定を追加 ---

    if (this.currentInstance === inst && inst.state === "running") {
      taskItem.classList.add("selected")
    }

    // 完了済みタスクの視覚的区別
    if (inst.state === "done") {
      taskItem.classList.add("completed")
    }

    // ドラッグハンドルを追加（完了済みタスクにも表示するが機能は無効）
    const isDraggable = inst.state !== "done"

    const dragHandle = taskItem.createEl("div", {
      cls: "drag-handle",
      attr: isDraggable
        ? {
            draggable: "true",
            title: "ドラッグして移動",
          }
        : {
            title: "完了済みタスク",
          },
    })

    // 完了済みタスクの場合はスタイルを調整
    if (!isDraggable) {
      dragHandle.classList.add("disabled")
    }

    // グリップアイコン（6つのドット）
    dragHandle.innerHTML = `
      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
        <circle cx="2" cy="2" r="1.5"/>
        <circle cx="8" cy="2" r="1.5"/>
        <circle cx="2" cy="8" r="1.5"/>
        <circle cx="8" cy="8" r="1.5"/>
        <circle cx="2" cy="14" r="1.5"/>
        <circle cx="8" cy="14" r="1.5"/>
      </svg>
    `

    // ドラッグハンドルのイベント（ドラッグ可能な場合のみ）
    if (isDraggable) {
      dragHandle.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", `${slot ?? "none"}::${idx}`)
        taskItem.classList.add("dragging")
      })

      dragHandle.addEventListener("dragend", () => {
        taskItem.classList.remove("dragging")
      })
    }

    // Add click handler for selection
    dragHandle.addEventListener("click", (e) => {
      e.stopPropagation()
      this.selectTaskForKeyboard(inst, taskItem)
    })

    // 右クリックメニューを追加
    taskItem.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      this.showTaskContextMenu(e, inst)
    })
    taskItem.addEventListener("dragover", (e) => {
      e.preventDefault()

      // ドラッグ中のタスクが完了済みの場合は何もしない
      const from = e.dataTransfer.types.includes("text/plain") ? true : false
      if (!from) return

      // 完了済みタスクの場合は常に移動不可
      if (inst.state === "done") {
        taskItem.classList.add("dragover-invalid")
        return
      }

      // 実行中タスクの場合、最後のタスクでない限り移動不可
      if (inst.state === "running") {
        // 同じ時間帯の全タスクを取得
        const slotInstances = this.taskInstances.filter(
          (i) => i.slotKey === (slot ?? "none"),
        )

        // 現在のタスクのインデックスを取得
        const currentTaskIndex = slotInstances.indexOf(inst)

        if (currentTaskIndex < slotInstances.length - 1) {
          taskItem.classList.add("dragover-invalid")
          return
        }
      }

      // Phase 2: マウス位置からドロップ位置を判定
      const rect = taskItem.getBoundingClientRect()
      const midpoint = rect.top + rect.height / 2
      
      if (e.clientY < midpoint) {
        // 上半分: 上縁にインジケーター
        taskItem.classList.add("dragover")
        taskItem.classList.remove("dragover-bottom")
      } else {
        // 下半分: 下縁にインジケーター
        taskItem.classList.remove("dragover")
        taskItem.classList.add("dragover-bottom")
      }
    })
    taskItem.addEventListener("dragleave", () => {
      taskItem.classList.remove("dragover")
      taskItem.classList.remove("dragover-bottom")
      taskItem.classList.remove("dragover-invalid")
    })
    taskItem.addEventListener("drop", (e) => {
      e.preventDefault()
      taskItem.classList.remove("dragover")
      taskItem.classList.remove("dragover-bottom")
      taskItem.classList.remove("dragover-invalid")
      const from = e.dataTransfer.getData("text/plain")
      const [fromSlot, fromIdx] = from.split("::")
      
      // スロット名の正規化
      const fromSlotNormalized = fromSlot === "none" ? "none" : fromSlot
      const toSlotNormalized = slot ?? "none"
      const fromIdxNum = parseInt(fromIdx)

      // Phase 3: ドロップ位置の判定
      const rect = taskItem.getBoundingClientRect()
      const midpoint = rect.top + rect.height / 2
      let targetIdx = idx
      
      // 完了済み・実行中タスクにドロップした場合、その位置を最小許可位置として扱う
      if (inst.state === "done" || inst.state === "running") {
        // 同じ時間帯の全タスクを取得
        const slotInstances = this.taskInstances.filter(
          (i) => i.slotKey === (slot ?? "none"),
        )
        // 完了済みと実行中タスクの数を数える
        const completedCount = slotInstances.filter(
          (i) => i.state === "done",
        ).length
        const runningCount = slotInstances.filter(
          (i) => i.state === "running",
        ).length
        // 完了済み・実行中タスクの最後の位置にドロップ
        targetIdx = completedCount + runningCount
      } else if (e.clientY >= midpoint) {
        // 下半分にドロップ
        if (fromSlotNormalized === toSlotNormalized && fromIdxNum <= idx) {
          // 同じスロット内で、移動元が現在位置以前にある場合
          // 移動元が削除されることを考慮して、targetIdxはそのまま現在のインデックス
          targetIdx = idx
        } else {
          // 異なるスロット間、または移動元が現在位置より後ろの場合
          targetIdx = idx + 1
        }
      }
      

      this.moveInstanceToSlot(
        fromSlot === "none" ? "none" : fromSlot,
        parseInt(fromIdx),
        slot ?? "none",
        targetIdx,
      )
    })
    // ボタン
    let btnCls = "play-stop-button"
    let btnText = "▶️"
    let btnTitle = "スタート"

    if (isFutureTask) {
      btnCls += " future-task-button"
      btnText = "—" // 全角ダッシュ
      btnTitle = "未来のタスクは実行できません"
    } else if (inst.state === "running") {
      btnCls += " stop"
      btnText = "⏹"
      btnTitle = "ストップ"
    } else if (inst.state === "done") {
      btnText = "☑️"
      btnTitle = "完了タスクを再計測"
    }
    const playButton = taskItem.createEl("button", {
      cls: btnCls,
      text: btnText,
      attr: { title: btnTitle },
    })

    if (isFutureTask) {
      playButton.disabled = true
    }

    playButton.addEventListener("click", async (e) => {
      e.stopPropagation()

      if (isFutureTask) {
        new Notice("未来のタスクは実行できません。", 2000)
        return
      }

      if (inst.state === "running") {
        await this.stopInstance(inst)
      } else if (inst.state === "done") {
        await this.duplicateAndStartInstance(inst)
      } else {
        await this.startInstance(inst)
      }

      // renderTaskList()の代わりに、該当するタスクアイテムのみを更新
      this.updateTaskItemDisplay(taskItem, inst)
    })
    // タスク名
    const taskName = taskItem.createEl("a", {
      cls: "task-name wikilink",
      text: inst.task.title,
      href: "#",
      attr: { title: `${inst.task.title} を開く` },
    })
    taskName.addEventListener("click", (e) => {
      e.preventDefault()
      this.app.workspace.openLinkText(inst.task.title, "", false)
    })

    // プロジェクト表示コンポーネント（タスク名の隣に配置）
    const projectDisplay = taskItem.createEl("span", {
      cls: "taskchute-project-display"
    })
    
    if (inst.task.projectPath && inst.task.projectTitle) {
      // プロジェクト設定済みの場合
      
      // フォルダアイコン + プロジェクト名のクリッカブルエリア
      const projectButton = projectDisplay.createEl("span", {
        cls: "taskchute-project-button",
        attr: { 
          title: `プロジェクト: ${inst.task.projectTitle}` 
        }
      })
      
      // フォルダアイコン
      const folderIcon = projectButton.createEl("span", {
        cls: "taskchute-project-icon",
        text: "📁"
      })
      
      // プロジェクト名（"Project - " プレフィックスを除去）
      const projectName = projectButton.createEl("span", {
        cls: "taskchute-project-name",
        text: inst.task.projectTitle.replace(/^Project\s*-\s*/, '')
      })
      
      // プロジェクトボタンのクリックイベント（統合モーダルを表示）
      projectButton.addEventListener("click", async (e) => {
        e.stopPropagation()
        await this.showUnifiedProjectModal(inst)
      })
      
      // External Linkアイコン
      const externalLinkIcon = projectDisplay.createEl("span", {
        cls: "taskchute-external-link",
        text: "🔗",
        attr: { title: "プロジェクトノートを開く" }
      })
      
      // External Linkアイコンのクリックイベント
      externalLinkIcon.addEventListener("click", async (e) => {
        e.stopPropagation()
        await this.openProjectInSplit(inst.task.projectPath)
      })
    } else {
      // プロジェクト未設定の場合（ホバーで表示）
      const projectPlaceholder = projectDisplay.createEl("span", {
        cls: "taskchute-project-placeholder",
        attr: { title: "クリックしてプロジェクトを設定" }
      })
      
      projectPlaceholder.addEventListener("click", async (e) => {
        e.stopPropagation()
        await this.showUnifiedProjectModal(inst)
      })
    }

    const formatTime = (date) =>
      date
        ? date.toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : ""

    // 開始・終了時刻
    const timeRangeEl = taskItem.createEl("span", { cls: "task-time-range" })
    if (inst.state === "running" && inst.startTime) {
      // 実行中タスクの場合、終了時刻の代わりにスペースを入れて幅を揃える
      timeRangeEl.innerHTML = `${formatTime(inst.startTime)} → <span style="display: inline-block; width: 45px;"></span>`
    } else if (inst.state === "done" && inst.startTime && inst.stopTime) {
      timeRangeEl.setText(
        `${formatTime(inst.startTime)} → ${formatTime(inst.stopTime)}`,
      )
    }
    // ★ 追加: 完了タスク・実行中タスクの時間帯を編集可能にする
    if (
      (inst.state === "done" && inst.startTime && inst.stopTime) ||
      (inst.state === "running" && inst.startTime)
    ) {
      timeRangeEl.classList.add("editable")
      timeRangeEl.addEventListener("click", (e) => {
        e.stopPropagation()
        this.showTimeEditModal(inst)
      })
    }

    // 実行時間 or 実行中タイマー or プレースホルダー
    if (inst.state === "done" && inst.startTime && inst.stopTime) {
      // 実行時間を計算
      const duration = inst.stopTime - inst.startTime
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000) % 60
      const durationStr = `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}`
      taskItem.createEl("span", {
        cls: "task-duration",
        text: durationStr,
      })
    } else if (inst.state === "running") {
      // 実行中タイマー表示用のspan
      taskItem.createEl("span", {
        cls: "task-timer-display",
      })
    } else {
      // 未実行タスクの場合も空のスパンを作成（グリッドレイアウトの位置を保つ）
      taskItem.createEl("span", {
        cls: "task-duration-placeholder",
      })
    }

    // コメントボタン
    const commentButton = taskItem.createEl("button", {
      cls: "comment-button",
      text: "💬",
      attr: { title: "コメントを記録" },
    })

    // コメントボタンのクリックイベント
    commentButton.addEventListener("click", async (e) => {
      e.stopPropagation()
      await this.showTaskCompletionModal(inst)
    })

    // コメント状態に応じてボタンの見た目を変更
    this.hasCommentData(inst).then((hasComment) => {
      if (hasComment) {
        commentButton.classList.add("active")
        commentButton.setAttribute("title", "コメントを編集")
      } else {
        commentButton.classList.remove("active")
        commentButton.setAttribute("title", "コメントを記録")
      }
    })

    // ルーチンボタン
    const routineButton = taskItem.createEl("button", {
      cls: `routine-button ${inst.task.isRoutine ? "active" : ""}`,
      text: "🔄",
      attr: {
        title: inst.task.isRoutine
          ? inst.task.routineType === "weekly" && inst.task.weekday !== null
            ? `週1回ルーチン（毎週${this.getWeekdayName(inst.task.weekday)} ${
                inst.task.scheduledTime || "時刻未設定"
              }開始予定）`
            : `ルーチンタスク（${
                inst.task.scheduledTime || "時刻未設定"
              }開始予定）`
          : "ルーチンタスクに設定",
      },
    })
    routineButton.addEventListener("click", (e) => {
      e.stopPropagation()
      if (inst.task.isRoutine) {
        this.showRoutineEditModal(inst.task, routineButton)
      } else {
        this.toggleRoutine(inst.task, routineButton)
      }
    })

    // 設定ボタン（ツールチップ付き）
    const settingsButton = taskItem.createEl("button", {
      cls: "settings-task-button",
      text: "⚙️",
      attr: { title: "タスク設定" },
    })
    settingsButton.addEventListener("click", (e) => {
      e.stopPropagation()
      this.showTaskSettingsTooltip(inst, settingsButton)
    })
  }

  moveInstanceToSlot(fromSlot, fromIdx, toSlot, toIdx) {
    // fromSlot, toSlot: グループ名（"none"は時間指定なし）
    // fromIdx, toIdx: グループ内インデックス
    const fromInstances = this.taskInstances.filter(
      (inst) => inst.slotKey === fromSlot,
    )
    const toInstances = this.taskInstances.filter(
      (inst) => inst.slotKey === toSlot,
    )
    const moved = fromInstances[fromIdx]
    if (!moved) return


    // 完了済みタスクの移動を防ぐ
    if (moved.state === "done") {
      new Notice("完了済みタスクは移動できません")
      return
    }

    // ドロップ先の時間帯の完了済みと実行中タスク数をカウント
    const completedTasksInSlot = toInstances.filter(
      (inst) => inst.state === "done",
    ).length
    const runningTasksInSlot = toInstances.filter(
      (inst) => inst.state === "running",
    ).length
    const topTasksCount = completedTasksInSlot + runningTasksInSlot

    // ドロップ位置が完了済み・実行中タスクより上の場合は拒否
    if (toIdx < topTasksCount) {
      new Notice("完了済み・実行中タスクより上には配置できません")
      return
    }

    const globalFromIdx = this.taskInstances.indexOf(moved)

    // フェーズ2: orderベースの処理
    if (this.useOrderBasedSort) {
      // シンプルな実装を使用
      const adjustedTargetIndex = toIdx - topTasksCount
      this.moveInstanceToSlotSimple(moved, toSlot, adjustedTargetIndex)
      return // 早期リターン（以下の配列操作は不要）
    } else {
      // 従来の処理（削除予定だが一時的に残す）
      // slotKeyをlocalStorageに保存
      localStorage.setItem(`taskchute-slotkey-${moved.task.path}`, toSlot)
      // 手動配置状態もlocalStorageに保存
      localStorage.setItem(
        `taskchute-manual-position-${this.getCurrentDateString()}-${
          moved.task.path
        }`,
        "true",
      )

      console.log(
        `[TaskChute] 従来方式移動: ${moved.task.title} → ${toSlot}`,
      )
    }

    // slotKeyを新グループに更新（このインスタンスだけ）
    moved.slotKey = toSlot

    // 配列の並び替え処理（orderベースの場合は順序番号で決定、従来方式は位置で決定）
    // 移動先の正確な位置を計算
    let globalToIdx
    
    if (toInstances.length === 0) {
      // 移動先グループが空の場合
      globalToIdx = this.taskInstances.length
    } else if (toIdx >= toInstances.length) {
      // 移動先グループの最後に配置
      const lastInGroup = toInstances[toInstances.length - 1]
      globalToIdx = this.taskInstances.indexOf(lastInGroup) + 1
    } else {
      // 指定された位置に配置
      const target = toInstances[toIdx]
      globalToIdx = this.taskInstances.indexOf(target)
    }


    if (globalFromIdx === -1 || globalToIdx === -1) return

    // 並び替え
    this.taskInstances.splice(globalFromIdx, 1)

    // 移動元より後ろに移動する場合はインデックスを調整
    if (globalFromIdx < globalToIdx) {
      globalToIdx--
    }


    this.taskInstances.splice(globalToIdx, 0, moved)

    // 移動したタスクを記憶
    const movedTaskPath = moved.task.path

    this.renderTaskList()

    // 移動したタスクを再選択
    if (movedTaskPath) {
      // data-task-path属性を使ってタスクアイテムを見つける
      const movedTaskItem = this.taskList.querySelector(
        `[data-task-path="${movedTaskPath}"]`,
      )
      if (movedTaskItem) {
        // 他の選択を解除
        this.taskList
          .querySelectorAll(".task-item.selected")
          .forEach((item) => {
            item.classList.remove("selected")
          })

        // ホバー時の色を適用（一時的なハイライト）
        movedTaskItem.style.background = "var(--background-secondary)"
        movedTaskItem.style.transition = "background 0.3s ease"

        // スクロールして表示
        movedTaskItem.scrollIntoView({ behavior: "smooth", block: "nearest" })

        // 0.5秒後に元の色に戻す
        setTimeout(() => {
          movedTaskItem.style.background = ""
          movedTaskItem.style.transition = ""
        }, 500)
      }
    }
  }

  async startInstance(inst) {
    // --- ▼ 未来日タスクの実行防止ガードを追加 ---
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const viewDate = new Date(this.currentDate)
    viewDate.setHours(0, 0, 0, 0)
    if (viewDate > today) {
      new Notice("未来のタスクは実行できません。", 2000)
      return
    }
    // --- ▲ 未来日タスクの実行防止ガードを追加 ---

    if (this.currentInstance && this.currentInstance.state === "running") {
      await this.stopInstance(this.currentInstance)
    }

    // --- ▼ 非ルーチンタスクのtarget_date更新ロジックを追加 ---
    // 非ルーチンタスクで、表示日付が本日でない場合
    if (!inst.task.isRoutine) {
      const todayDateString = `${today.getFullYear()}-${(today.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${today.getDate().toString().padStart(2, "0")}`
      const viewDateString = `${viewDate.getFullYear()}-${(
        viewDate.getMonth() + 1
      )
        .toString()
        .padStart(2, "0")}-${viewDate.getDate().toString().padStart(2, "0")}`

      // 表示日付が本日でない場合（前日のタスクを実行する場合）
      if (viewDateString !== todayDateString) {
        console.log(
          `[TaskChute] 非ルーチンタスク "${inst.task.title}" を本日（${todayDateString}）に移動します`,
        )

        // target_dateを本日に更新
        const updateSuccess = await this.updateTaskTargetDate(inst.task, today)

        if (updateSuccess) {
          new Notice(`タスク「${inst.task.title}」を本日に移動しました`)
        } else {
          console.error(
            `[TaskChute] タスクの日付更新に失敗しました: ${inst.task.title}`,
          )
        }
      }
    }
    // --- ▲ 非ルーチンタスクのtarget_date更新ロジックを追加 ---

    // 開始時のslotKeyを保存（時間帯をまたいでも元の位置を保持するため）
    inst.originalSlotKey = inst.slotKey

    // 実行開始時は常に現在の時間帯に移動
    const currentSlot = this.getCurrentTimeSlot()
    if (inst.slotKey !== currentSlot) {
      console.log(
        `[TaskChute] タスク "${inst.task.title}" を実行開始: ${inst.slotKey} → ${currentSlot}`,
      )

      // 現在の時間帯に移動
      inst.slotKey = currentSlot

      // localStorageも更新
      localStorage.setItem(`taskchute-slotkey-${inst.task.path}`, currentSlot)

      // 手動配置フラグはリセットしない（ユーザーが手動で配置した順序は保持）
    }

    inst.state = "running"
    inst.startTime = new Date()
    inst.stopTime = null

    // 実行中タスクの状態を保存
    await this.saveRunningTasksState()
    this.manageTimers() // タイマー管理を開始

    // タスクリストを再描画してソートを適用（実行中タスクを実行済みタスクの直後に配置）
    this.renderTaskList()
  }

  async stopInstance(inst) {
    inst.state = "done"
    inst.stopTime = new Date()

    // すべてのタスクは停止時に現在の時間帯に留まる
    // localStorageも現在のslotKeyで更新
    localStorage.setItem(`taskchute-slotkey-${inst.task.path}`, inst.slotKey)

    // 実行中タスクの状態を保存（このタスクがリストから除外される）
    await this.saveRunningTasksState()
    this.manageTimers() // タイマー表示を更新

    try {
      // JSONファイルに基本データを保存（コメントなし）
      await this.saveTaskCompletion(inst, null)
    } catch (e) {
      new Notice("タスク記録の保存に失敗しました")
      console.error("Task completion save error:", e)
    }

    // 全タスク完了チェック
    this.checkAllTasksCompleted()

    // タスクリストを再描画してソートを適用
    this.renderTaskList()
  }

  // 全タスク完了チェック
  checkAllTasksCompleted() {
    // 実行可能なタスク（idle状態）が残っているかチェック
    const remainingTasks = this.taskInstances.filter(
      (inst) => inst.state === "idle",
    )

    if (remainingTasks.length === 0 && this.taskInstances.length > 0) {
      // 全てのタスクが完了した場合、演出を開始
      this.showCompletionCelebration()
    }
  }

  // 完了演出を表示
  showCompletionCelebration() {
    const plugin = this.app.plugins.plugins["taskchute-plus"]
    const settings = plugin?.settings || {
      enableCelebration: true,
      enableSound: true,
      enableFireworks: true,
      enableConfetti: true,
    }

    if (!settings.enableCelebration) {
      new Notice("🎉 素晴らしい！全てのタスクを完了しました！", 5000)
      return
    }

    // オーバーレイ
    const overlay = document.createElement("div")
    overlay.className = "celebration-overlay"

    // モーダル本体
    const content = document.createElement("div")
    content.className = "celebration-content"

    // タイトル
    const title = document.createElement("div")
    title.className = "celebration-title"
    title.textContent = "🎉 お疲れ様でした！ 🎉"
    content.appendChild(title)

    // メッセージ
    const msg = document.createElement("div")
    msg.className = "celebration-message"
    msg.innerHTML = `今日のタスクを全て完了しました！<br> <b>先送りゼロ達成、おめでとうございます！</b>`
    content.appendChild(msg)

    // 統計
    const stats = document.createElement("div")
    stats.className = "celebration-stats"
    stats.innerHTML = `
      <div class="stat-item">
        <span class="stat-number">${
          this.taskInstances.filter((inst) => inst.state === "done").length
        }</span>
        <span class="stat-label">完了タスク</span>
      </div>
      <div class="stat-item">
        <span class="stat-number">${this.calculateTotalTime()}</span>
        <span class="stat-label">総作業時間</span>
      </div>
    `
    content.appendChild(stats)

    // 拍手メッセージ
    const applause = document.createElement("div")
    applause.style.marginTop = "18px"
    applause.style.fontSize = "18px"
    applause.style.color = "#fff"
    applause.style.fontWeight = "bold"
    applause.style.textAlign = "center"
    applause.textContent = "今日の自分に、拍手を送りましょう👏"
    content.appendChild(applause)

    // 花火・紙吹雪
    if (settings.enableFireworks) {
      const fireworks = document.createElement("div")
      fireworks.className = "fireworks-container"
      content.appendChild(fireworks)
      this.startFireworks(fireworks)
    }
    if (settings.enableConfetti) {
      const confetti = document.createElement("div")
      confetti.className = "confetti-container"
      content.appendChild(confetti)
      this.startConfetti(confetti)
    }

    // 自動で5秒後に閉じる
    setTimeout(() => {
      if (overlay.parentNode) document.body.removeChild(overlay)
    }, 5000)

    // 音
    if (settings.enableSound) this.playCelebrationSound()

    // 通知
    new Notice("🎉 先送りゼロ達成！全てのタスクを完了しました！", 5000)

    // DOM追加
    overlay.appendChild(content)
    document.body.appendChild(overlay)
  }

  // 総作業時間を計算
  calculateTotalTime() {
    const completedTasks = this.taskInstances.filter(
      (inst) => inst.state === "done",
    )
    let totalMinutes = 0

    completedTasks.forEach((inst) => {
      if (inst.startTime && inst.stopTime) {
        const duration = inst.stopTime - inst.startTime
        totalMinutes += duration / (1000 * 60)
      }
    })

    const hours = Math.floor(totalMinutes / 60)
    const minutes = Math.floor(totalMinutes % 60)

    if (hours > 0) {
      return `${hours}時間${minutes}分`
    } else {
      return `${minutes}分`
    }
  }

  // 紙吹雪エフェクト
  startConfetti(container) {
    const colors = [
      "#ff6b6b",
      "#4ecdc4",
      "#45b7d1",
      "#96ceb4",
      "#feca57",
      "#ff9ff3",
      "#54a0ff",
      "#5f27cd",
    ]

    const createConfetti = () => {
      const confetti = document.createElement("div")
      confetti.className = "confetti"

      // ランダムな位置、色、サイズ
      const x = Math.random() * 100
      const color = colors[Math.floor(Math.random() * colors.length)]
      const size = Math.random() * 10 + 5

      confetti.style.left = `${x}%`
      confetti.style.backgroundColor = color
      confetti.style.width = `${size}px`
      confetti.style.height = `${size}px`

      container.appendChild(confetti)

      // アニメーション終了後に要素を削除
      setTimeout(() => {
        if (confetti.parentNode) {
          confetti.parentNode.removeChild(confetti)
        }
      }, 3000)
    }

    // 紙吹雪を連続で生成
    const confettiInterval = setInterval(createConfetti, 100)

    // 8秒後に停止
    setTimeout(() => {
      clearInterval(confettiInterval)
    }, 8000)
  }

  // 花火エフェクト
  startFireworks(container) {
    const colors = [
      "#ff6b6b",
      "#4ecdc4",
      "#45b7d1",
      "#96ceb4",
      "#feca57",
      "#ff9ff3",
      "#54a0ff",
      "#5f27cd",
    ]

    const createFirework = () => {
      const firework = document.createElement("div")
      firework.className = "firework"

      // ランダムな位置と色
      const x = Math.random() * 100
      const y = Math.random() * 100
      const color = colors[Math.floor(Math.random() * colors.length)]

      firework.style.left = `${x}%`
      firework.style.top = `${y}%`
      firework.style.backgroundColor = color

      container.appendChild(firework)

      // パーティクル効果を追加
      this.createParticles(container, x, y, color)

      // アニメーション終了後に要素を削除
      setTimeout(() => {
        if (firework.parentNode) {
          firework.parentNode.removeChild(firework)
        }
      }, 2000)
    }

    // 花火を連続で発射
    const fireworkInterval = setInterval(createFirework, 300)

    // 10秒後に停止
    setTimeout(() => {
      clearInterval(fireworkInterval)
    }, 10000)
  }

  // パーティクル効果
  createParticles(container, x, y, color) {
    for (let i = 0; i < 8; i++) {
      const particle = document.createElement("div")
      particle.className = "particle"
      particle.style.left = `${x}%`
      particle.style.top = `${y}%`
      particle.style.backgroundColor = color
      particle.style.transform = `rotate(${i * 45}deg)`

      container.appendChild(particle)

      setTimeout(() => {
        if (particle.parentNode) {
          particle.parentNode.removeChild(particle)
        }
      }, 1500)
    }
  }

  // 音効果（オプション）
  playCelebrationSound() {
    // Web Audio APIを使用して音を再生
    try {
      const audioContext = new (window.AudioContext ||
        window.webkitAudioContext)()
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)

      // 成功音のメロディー
      const frequencies = [523.25, 659.25, 783.99, 1046.5] // C, E, G, C
      let currentNote = 0

      const playNote = () => {
        if (currentNote < frequencies.length) {
          oscillator.frequency.setValueAtTime(
            frequencies[currentNote],
            audioContext.currentTime,
          )
          gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)
          gainNode.gain.exponentialRampToValueAtTime(
            0.01,
            audioContext.currentTime + 0.3,
          )
          currentNote++
          setTimeout(playNote, 300)
        } else {
          oscillator.stop()
        }
      }

      oscillator.start()
      playNote()
    } catch (error) {
      console.log("音効果の再生に失敗しました:", error)
    }
  }

  duplicateInstance(inst) {
    const newInst = {
      task: inst.task,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: inst.slotKey,
      order: null, // 後で計算される
      instanceId: this.generateInstanceId(inst.task.path), // 新しい一意のインスタンスID
    }

    const currentIndex = this.taskInstances.indexOf(inst)

    if (currentIndex !== -1) {
      this.taskInstances.splice(currentIndex + 1, 0, newInst)
    } else {
      this.taskInstances.push(newInst)
    }

    // 複製タスクの順序番号を計算（元タスクの直下に配置）
    this.calculateDuplicateTaskOrder(newInst, inst)

    // 複製情報をlocalStorageに保存
    const today = this.currentDate
    const y = today.getFullYear()
    const m = (today.getMonth() + 1).toString().padStart(2, "0")
    const d = today.getDate().toString().padStart(2, "0")
    const dateString = `${y}-${m}-${d}`
    const storageKey = `taskchute-duplicated-instances-${dateString}`

    let duplicatedInstances = []
    try {
      const storageData = JSON.parse(localStorage.getItem(storageKey) || "[]")

      // 後方互換性: 古いpath配列形式の場合は新形式に変換
      if (storageData.length > 0 && typeof storageData[0] === "string") {
        duplicatedInstances = storageData.map((path) => ({
          path: path,
          instanceId: this.generateInstanceId(path), // 新規生成
        }))
      } else {
        duplicatedInstances = storageData
      }
    } catch (e) {
      duplicatedInstances = []
    }

    // 新しい複製インスタンスの情報を追加
    duplicatedInstances.push({
      path: inst.task.path,
      instanceId: newInst.instanceId,
    })
    localStorage.setItem(storageKey, JSON.stringify(duplicatedInstances))

    this.renderTaskList()
    
    // ルーチンタスクの複製の場合は特別なメッセージ
    if (inst.task.isRoutine) {
      new Notice(`「${inst.task.title}」を複製しました。複製されたタスクは今日のみ表示されます。`)
    } else {
      new Notice(`「${inst.task.title}」を複製しました。`)
    }
  }

  async duplicateAndStartInstance(inst) {
    // 現在の時間帯を取得
    const currentSlot = this.getCurrentTimeSlot()

    // 同じタスク参照の新インスタンスを現在の時間帯に追加し、計測開始
    const newInst = {
      task: inst.task,
      state: "idle",
      startTime: null,
      stopTime: null,
      slotKey: currentSlot, // 現在の時間帯に設定
      order: null, // 現在の時間帯の最後に追加される
      instanceId: this.generateInstanceId(inst.task.path), // 新しい一意のインスタンスID
    }
    this.taskInstances.push(newInst)

    // 複製情報をlocalStorageに保存（duplicateInstance と同じ処理）
    const today = this.currentDate
    const y = today.getFullYear()
    const m = (today.getMonth() + 1).toString().padStart(2, "0")
    const d = today.getDate().toString().padStart(2, "0")
    const dateString = `${y}-${m}-${d}`
    const storageKey = `taskchute-duplicated-instances-${dateString}`

    let duplicatedInstances = []
    try {
      const storageData = JSON.parse(localStorage.getItem(storageKey) || "[]")

      // 後方互換性: 古いpath配列形式の場合は新形式に変換
      if (storageData.length > 0 && typeof storageData[0] === "string") {
        duplicatedInstances = storageData.map((path) => ({
          path: path,
          instanceId: this.generateInstanceId(path), // 新規生成
        }))
      } else {
        duplicatedInstances = storageData
      }
    } catch (e) {
      duplicatedInstances = []
    }

    // 新しい複製インスタンスの情報を追加
    duplicatedInstances.push({
      path: inst.task.path,
      instanceId: newInst.instanceId,
    })
    localStorage.setItem(storageKey, JSON.stringify(duplicatedInstances))

    console.log(
      `[TaskChute] duplicateAndStartInstance: 複製情報を記録 (instanceId: ${newInst.instanceId})`,
    )

    // startInstanceを呼ぶ前にrenderTaskListを呼んで、新しいインスタンスを表示
    this.renderTaskList()

    await this.startInstance(newInst)

    // startInstance後にも再度renderTaskListを呼んで、実行中状態を反映
    this.renderTaskList()
  }

  // タスクコメント入力モーダルを表示
  async showTaskCompletionModal(inst) {
    // 既存のコメントデータを取得
    const existingComment = await this.getExistingTaskComment(inst)

    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", {
      cls: "task-modal-content completion-modal",
    })

    // ヘッダー
    const header = modalContent.createEl("div", { cls: "modal-header" })
    const isCompleted = inst.state === "done"

    let headerText
    if (existingComment) {
      headerText = isCompleted
        ? `✏️ 「${inst.task.title}」のコメントを編集`
        : `✏️ 「${inst.task.title}」のコメントを編集`
    } else {
      headerText = isCompleted
        ? `🎉 お疲れ様でした！「${inst.task.title}」が完了しました`
        : `💬 「${inst.task.title}」にコメントを記録`
    }

    header.createEl("h3", { text: headerText })

    // 既存コメントがある場合の表示
    if (existingComment) {
      const existingInfo = header.createEl("div", {
        cls: "existing-comment-info",
      })
      existingInfo.innerHTML = `
        <small style="color: #666; font-style: italic;">
          前回記録: ${new Date(existingComment.timestamp).toLocaleString(
            "ja-JP",
          )}
        </small>
      `
    }

    // メインコンテンツ
    const form = modalContent.createEl("div", {
      cls: "task-form completion-form",
    })

    // 実行時間表示（完了したタスクの場合のみ）
    if (isCompleted && inst.startTime && inst.stopTime) {
      const duration = inst.stopTime - inst.startTime
      const hours = Math.floor(duration / 3600000)
      const minutes = Math.floor((duration % 3600000) / 60000)
      const seconds = Math.floor((duration % 60000) / 1000)
      const durationStr = `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`

      const timeInfo = form.createEl("div", { cls: "completion-time-info" })
      timeInfo.innerHTML = `
        <p><strong>実行時間:</strong> ${durationStr}</p>
        <p><strong>開始:</strong> ${inst.startTime.toLocaleTimeString("ja-JP")} 
           <strong>終了:</strong> ${inst.stopTime.toLocaleTimeString(
             "ja-JP",
           )}</p>
      `
    }

    // 評価セクション
    const ratingSection = form.createEl("div", {
      cls: "completion-rating-section",
    })
    const ratingHeaderText = isCompleted
      ? "今回のタスクはいかがでしたか？"
      : "このタスクについて記録しませんか？"
    ratingSection.createEl("h4", { text: ratingHeaderText })

    // 集中度
    const focusGroup = ratingSection.createEl("div", { cls: "rating-group" })
    focusGroup.createEl("label", { text: "集中度:", cls: "rating-label" })
    const focusRating = focusGroup.createEl("div", { cls: "star-rating" })
    const initialFocusRating = existingComment?.focusLevel || 0
    focusRating.setAttribute("data-rating", initialFocusRating.toString())
    focusRating.setAttribute("data-type", "focus")
    for (let i = 1; i <= 5; i++) {
      const star = focusRating.createEl("span", {
        text: "⭐",
        cls: "star",
        attr: { "data-value": i.toString() },
      })
      star.addEventListener("click", () => this.setRating(focusRating, i))
      star.addEventListener("mouseover", () =>
        this.highlightRating(focusRating, i),
      )
    }
    focusRating.addEventListener("mouseleave", () =>
      this.resetRatingHighlight(focusRating),
    )
    // 初期値を表示に反映
    this.updateRatingDisplay(focusRating, initialFocusRating)

    // 元気度
    const energyGroup = ratingSection.createEl("div", {
      cls: "rating-group",
    })
    energyGroup.createEl("label", {
      text: "元気度:",
      cls: "rating-label",
    })
    const energyRating = energyGroup.createEl("div", {
      cls: "star-rating",
    })
    const initialEnergyRating = existingComment?.energyLevel || 0
    energyRating.setAttribute(
      "data-rating",
      initialEnergyRating.toString(),
    )
    energyRating.setAttribute("data-type", "energy")
    for (let i = 1; i <= 5; i++) {
      const star = energyRating.createEl("span", {
        text: "⭐",
        cls: "star",
        attr: { "data-value": i.toString() },
      })
      star.addEventListener("click", () =>
        this.setRating(energyRating, i),
      )
      star.addEventListener("mouseover", () =>
        this.highlightRating(energyRating, i),
      )
    }
    energyRating.addEventListener("mouseleave", () =>
      this.resetRatingHighlight(energyRating),
    )
    // 初期値を表示に反映
    this.updateRatingDisplay(energyRating, initialEnergyRating)

    // コメント入力
    const commentGroup = form.createEl("div", { cls: "form-group" })
    commentGroup.createEl("label", {
      text: "感想・学び・次回への改善点:",
      cls: "form-label",
    })
    const commentTextarea = commentGroup.createEl("textarea", {
      cls: "form-textarea completion-comment",
      attr: {
        placeholder:
          "今回のタスクで感じたこと、学んだこと、次回への改善点などを自由にお書きください...\n例：朝一番で頭がスッキリしていた。事前準備が効果的だった。",
        rows: "4",
      },
    })

    // 既存コメントがある場合は値をセット
    if (existingComment?.executionComment) {
      commentTextarea.value = existingComment.executionComment
    }

    // ボタン群
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })

    // キャンセルボタン
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button secondary",
      text: "キャンセル",
    })
    cancelButton.addEventListener("click", async (e) => {
      e.preventDefault()
      e.stopPropagation()
      modal.remove()
    })

    // 保存ボタン
    const saveButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button primary",
      text: existingComment ? "更新" : "保存",
    })
    saveButton.addEventListener("click", async (e) => {
      e.preventDefault()
      e.stopPropagation()

      try {
        // フォームデータを収集
        const focusLevel =
          parseInt(focusRating.getAttribute("data-rating")) || 0
        const energyLevel =
          parseInt(energyRating.getAttribute("data-rating")) || 0
        const comment = commentTextarea.value.trim()

        const completionData = {
          executionComment: comment,
          focusLevel: focusLevel,
          energyLevel: energyLevel,
          timestamp: new Date().toISOString(),
        }

        console.log("保存開始:", completionData)
        await this.saveTaskCompletion(inst, completionData)
        console.log("保存完了")
        modal.remove()

        // コメント保存後にタスクリスト表示を更新（コメントボタンの状態を反映）
        this.renderTaskList()
      } catch (error) {
        console.error("保存ボタンでエラー:", error)
        new Notice("コメントの保存中にエラーが発生しました")
        modal.remove()
      }
    })

    // モーダルを表示
    document.body.appendChild(modal)

    // ESCキーで閉じる
    const handleKeydown = (e) => {
      if (e.key === "Escape") {
        cancelButton.click()
        document.removeEventListener("keydown", handleKeydown)
      }
    }
    document.addEventListener("keydown", handleKeydown)

    // 背景クリックで閉じる機能を無効化
    // ユーザーが誤って背景をクリックしてコメントが消えることを防ぐ
    // modal.addEventListener("click", (e) => {
    //   if (e.target === modal) {
    //     cancelButton.click()
    //   }
    // })
  }

  // 星評価の設定
  setRating(ratingEl, value) {
    ratingEl.setAttribute("data-rating", value.toString())
    this.updateRatingDisplay(ratingEl, value)
  }

  // 星評価のハイライト
  highlightRating(ratingEl, value) {
    this.updateRatingDisplay(ratingEl, value)
  }

  // 星評価のハイライトリセット
  resetRatingHighlight(ratingEl) {
    const currentRating = parseInt(ratingEl.getAttribute("data-rating")) || 0
    this.updateRatingDisplay(ratingEl, currentRating)
  }

  // 星評価の表示更新
  updateRatingDisplay(ratingEl, value) {
    const stars = ratingEl.querySelectorAll(".star")
    stars.forEach((star, index) => {
      if (index < value) {
        star.style.opacity = "1"
        star.style.transform = "scale(1.1)"
      } else {
        star.style.opacity = "0.3"
        star.style.transform = "scale(1)"
      }
    })
  }

  // 指定したタスクの既存コメントを取得
  async getExistingTaskComment(inst) {
    try {
      // instanceId が存在しない場合は、コメントは存在しないものとして扱う
      if (!inst.instanceId) {
        return null
      }

      // 月次ログファイルのパスを生成（表示中の日付を使用）
      const currentDate = this.currentDate
      const year = currentDate.getFullYear()
      const month = (currentDate.getMonth() + 1).toString().padStart(2, "0")
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`

      // ログファイルが存在しない場合は null を返す
      if (!(await this.app.vault.adapter.exists(logFilePath))) {
        return null
      }

      // ログファイルを読み込み
      const logContent = await this.app.vault.adapter.read(logFilePath)
      const monthlyLog = JSON.parse(logContent)

      // 表示中の日付文字列を生成
      const day = currentDate.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      // 表示中の日付のタスク実行ログを取得
      const todayTasks = monthlyLog.taskExecutions?.[dateString] || []

      // instanceId で検索（シンプルで確実）
      const existingEntry = todayTasks.find(
        (entry) =>
          entry.instanceId === inst.instanceId &&
          (entry.executionComment ||
            entry.focusLevel > 0 ||
            entry.energyLevel > 0),
      )

      return existingEntry || null
    } catch (error) {
      console.error("既存コメントの取得に失敗:", error)
      return null
    }
  }

  // タスクインスタンスにコメントデータがあるかチェック
  async hasCommentData(inst) {
    try {
      const existingComment = await this.getExistingTaskComment(inst)
      if (!existingComment) {
        return false
      }

      return (
        (existingComment.executionComment &&
          existingComment.executionComment.trim().length > 0) ||
        existingComment.focusLevel > 0 ||
        existingComment.energyLevel > 0
      )
    } catch (error) {
      console.error("コメントデータチェックに失敗:", error)
      return false
    }
  }

  // タスク完了データを保存
  async saveTaskCompletion(inst, completionData) {
    console.log("saveTaskCompletion開始:", {
      inst: inst.task.title,
      completionData,
    })

    try {
      // 月次ログファイルのパスを生成
      const today = new Date()
      const year = today.getFullYear()
      const month = (today.getMonth() + 1).toString().padStart(2, "0")
      const day = today.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`
      const monthString = `${year}-${month}`
      const logDataPath = this.plugin.pathManager.getLogDataPath()
      const logFilePath = `${logDataPath}/${monthString}-tasks.json`

      console.log("ログファイルパス:", logFilePath)

      // dataディレクトリが存在することを確認
      const dataDir = this.plugin.pathManager.getLogDataPath()
      console.log("ディレクトリ確認:", dataDir)
      if (!(await this.app.vault.adapter.exists(dataDir))) {
        console.log("ディレクトリを作成中...")
        await this.app.vault.adapter.mkdir(dataDir)
        console.log("ディレクトリ作成完了")
      }

      // 基本的なタスク実行情報を作成
      const isCompleted =
        inst.state === "done" && inst.startTime && inst.stopTime
      const taskExecution = {
        taskId: inst.task.path || `temp-${Date.now()}`,
        taskName: inst.task.title,
        taskType: inst.task.isRoutine ? "routine" : "project",
        project: inst.task.projectTitle || null,
        slot: inst.slotKey || "none",

        isCompleted: isCompleted,
        ...completionData, // コメントデータをマージ
      }

      // instanceIdがある場合のみ追加（後方互換性のため）
      if (inst.instanceId) {
        taskExecution.instanceId = inst.instanceId
      }

      // 完了したタスクの場合のみ実行時間を記録
      if (isCompleted) {
        const duration = inst.stopTime - inst.startTime
        taskExecution.startTime = inst.startTime.toTimeString().slice(0, 8)
        taskExecution.stopTime = inst.stopTime.toTimeString().slice(0, 8)
        taskExecution.duration = Math.floor(duration / 1000) // 秒単位
      }

      // 既存のログファイルを読み込み
      console.log("ログファイル構造初期化中...")
      let monthlyLog = {
        metadata: {
          version: "2.0",
          month: monthString,
          lastUpdated: new Date().toISOString(),
          totalDays: 0,
          activeDays: 0,
        },
        dailySummary: {},
        taskExecutions: {},
        patterns: {},
      }

      // ファイルが存在する場合は既存データを読み込み
      console.log("既存ログファイル確認中...")
      if (await this.app.vault.adapter.exists(logFilePath)) {
        console.log("既存ファイル発見、読み込み中...")
        try {
          const existingContent = await this.app.vault.adapter.read(logFilePath)
          const existingLog = JSON.parse(existingContent)
          monthlyLog = { ...monthlyLog, ...existingLog }
          console.log("既存ファイル読み込み完了")
        } catch (e) {
          console.warn("既存ログファイルの読み込みに失敗、新規作成します:", e)
        }
      } else {
        console.log("新規ログファイルを作成します")
      }

      // 日次実行ログにタスクを追加または更新
      if (!monthlyLog.taskExecutions[dateString]) {
        monthlyLog.taskExecutions[dateString] = []
      }

      // 同じタスクの既存エントリを探す
      // インスタンスIDがある場合は、インスタンスIDでのみ検索（複製タスク対応）
      // インスタンスIDがない場合は、後方互換性のため他の条件で検索
      let existingIndex = -1

      if (taskExecution.instanceId) {
        // インスタンスIDがある場合は、インスタンスIDでのみ検索
        existingIndex = monthlyLog.taskExecutions[dateString].findIndex(
          (entry) => entry.instanceId === taskExecution.instanceId,
        )
      } else {
        // インスタンスIDがない場合は、後方互換性のため他の条件で検索
        // 1. タスクIDでの完全一致検索
        existingIndex = monthlyLog.taskExecutions[dateString].findIndex(
          (entry) => entry.taskId === taskExecution.taskId,
        )

        // 2. タスクIDでの一致がない場合、タスク名とスロットで検索
        if (existingIndex === -1) {
          existingIndex = monthlyLog.taskExecutions[dateString].findIndex(
            (entry) =>
              entry.taskName === taskExecution.taskName &&
              entry.slot === taskExecution.slot,
          )
        }

        // 3. それでも見つからない場合、タスク名のみで検索
        if (existingIndex === -1) {
          existingIndex = monthlyLog.taskExecutions[dateString].findIndex(
            (entry) => entry.taskName === taskExecution.taskName,
          )
        }
      }

      if (existingIndex !== -1) {
        // 既存エントリを更新（コメント追加/編集時）
        console.log("既存エントリを更新:", taskExecution.taskName)
        monthlyLog.taskExecutions[dateString][existingIndex] = {
          ...monthlyLog.taskExecutions[dateString][existingIndex],
          ...taskExecution,
          // 最終更新時刻を記録
          lastCommentUpdate: new Date().toISOString(),
        }
      } else {
        // 新規エントリを追加（タスク完了時）
        console.log("新規エントリを追加:", taskExecution.taskName)
        monthlyLog.taskExecutions[dateString].push(taskExecution)
      }

      // メタデータを更新
      monthlyLog.metadata.lastUpdated = new Date().toISOString()

      // アクティブ日数を計算
      const activeDays = Object.keys(monthlyLog.taskExecutions).length
      monthlyLog.metadata.activeDays = activeDays
      monthlyLog.metadata.totalDays = new Date(year, month, 0).getDate()

      // 日次サマリーを更新
      const todayTasks = monthlyLog.taskExecutions[dateString] || []
      const completedTasks = todayTasks.filter(
        (task) => task.isCompleted,
      ).length
      const totalFocusTime = todayTasks
        .filter((task) => task.isCompleted && task.duration)
        .reduce((sum, task) => sum + task.duration, 0)

      // 評価値のあるタスクのみで平均を計算
      const tasksWithFocus = todayTasks.filter((t) => t.focusLevel > 0)
      const tasksWithEnergy = todayTasks.filter(
        (t) => t.energyLevel > 0,
      )

      const avgFocus =
        tasksWithFocus.length > 0
          ? tasksWithFocus.reduce((sum, t) => sum + t.focusLevel, 0) /
            tasksWithFocus.length
          : 0

      const avgEnergy =
        tasksWithEnergy.length > 0
          ? tasksWithEnergy.reduce(
              (sum, t) => sum + t.energyLevel,
              0,
            ) / tasksWithEnergy.length
          : 0

      monthlyLog.dailySummary[dateString] = {
        totalTasks: todayTasks.length,
        completedTasks: completedTasks,
        totalFocusTime: totalFocusTime,
        productivityScore: avgFocus > 0 ? avgFocus / 5 : 0,
        averageFocus: avgFocus,
        averageEnergy: avgEnergy,
        tasksWithComments: todayTasks.filter(
          (t) => t.executionComment && t.executionComment.trim(),
        ).length,
        lastModified: new Date().toISOString(),
      }

      // JSONファイルに保存
      console.log("JSONファイル書き込み開始...")
      const jsonContent = JSON.stringify(monthlyLog, null, 2)
      console.log("JSON文字列生成完了、サイズ:", jsonContent.length)

      await this.app.vault.adapter.write(logFilePath, jsonContent)
      console.log("JSONファイル書き込み完了")

      // コメント機能からの呼び出しではDaily Note保存をスキップ
      // （stopInstance時に既に保存済みのため）

      // 成功メッセージ
      if (completionData && completionData.executionComment) {
        if (existingIndex !== -1) {
          new Notice(`「${inst.task.title}」のコメントを更新しました`)
        } else {
          new Notice(`「${inst.task.title}」のコメントを保存しました`)
        }
      } else {
        // 新規エントリの作成（タスク完了時）
        console.log("タスク完了データをJSONに保存完了")
      }

      // コメント機能では全タスク完了チェックやタスクリスト更新は行わない
      // （タスクの状態は変更していないため）
    } catch (error) {
      console.error("タスク完了データの保存に失敗:", error)
      new Notice("タスク記録の保存に失敗しました")

      // エラー時はJSONログのみ失敗
      // Daily Note保存は stopInstance で既に実行済み
    }
  }

  // 特定のインスタンスIDを持つログのみを削除する
  async deleteTaskLogsByInstanceId(taskPath, instanceId) {
    try {
      let totalDeletedLogs = 0
      const dataDir = this.plugin.pathManager.getLogDataPath()

      // dataディレクトリが存在しない場合は何もしない
      if (!(await this.app.vault.adapter.exists(dataDir))) {
        return
      }

      // dataディレクトリ内の実際のファイル一覧を取得
      const files = await this.app.vault.adapter.list(dataDir)

      // -tasks.jsonで終わるファイルのみを処理
      const taskJsonFiles = files.files.filter((file) =>
        file.endsWith("-tasks.json"),
      )

      for (const fileName of taskJsonFiles) {
        const baseFileName = fileName.split("/").pop()
        const logFilePath = `${dataDir}/${baseFileName}`

        try {
          // ファイルを読み込み
          const content = await this.app.vault.adapter.read(logFilePath)
          const monthlyLog = JSON.parse(content)

          // 該当taskIdとinstanceIdのログを削除
          let fileModified = false

          if (monthlyLog.taskExecutions) {
            for (const dateString in monthlyLog.taskExecutions) {
              const dayLogs = monthlyLog.taskExecutions[dateString]
              const originalLength = dayLogs.length

              // taskIdが一致し、かつinstanceIdも一致するログを除外
              monthlyLog.taskExecutions[dateString] = dayLogs.filter(
                (log) =>
                  !(log.taskId === taskPath && log.instanceId === instanceId),
              )

              const deletedCount =
                originalLength - monthlyLog.taskExecutions[dateString].length
              if (deletedCount > 0) {
                totalDeletedLogs += deletedCount
                fileModified = true
              }

              // 空になった日のエントリを削除
              if (monthlyLog.taskExecutions[dateString].length === 0) {
                delete monthlyLog.taskExecutions[dateString]
              }
            }
          }

          // ファイルが変更された場合のみ書き戻し
          if (fileModified) {
            // メタデータの更新
            if (monthlyLog.metadata) {
              monthlyLog.metadata.lastUpdated = new Date().toISOString()
            }

            // dailySummaryの再計算
            if (monthlyLog.dailySummary && monthlyLog.taskExecutions) {
              for (const dateString in monthlyLog.dailySummary) {
                if (monthlyLog.taskExecutions[dateString]) {
                  const dayTasks = monthlyLog.taskExecutions[dateString]
                  const completedTasks = dayTasks.filter(
                    (t) => t.isCompleted && t.isCompleted !== false,
                  ).length

                  monthlyLog.dailySummary[dateString].totalTasks =
                    dayTasks.length
                  monthlyLog.dailySummary[dateString].completedTasks =
                    completedTasks
                } else {
                  // その日のタスクが全て削除された場合
                  delete monthlyLog.dailySummary[dateString]
                }
              }
            }

            // ファイルに書き戻し
            await this.app.vault.adapter.write(
              logFilePath,
              JSON.stringify(monthlyLog, null, 2),
            )
            console.log(
              `[TaskChute] ${baseFileName}から${totalDeletedLogs}件のログを削除（instanceId: ${instanceId}）`,
            )
          }
        } catch (error) {
          console.error(
            `[TaskChute] ログファイル処理エラー (${fileName}):`,
            error,
          )
        }
      }

      if (totalDeletedLogs > 0) {
        console.log(
          `[TaskChute] 合計${totalDeletedLogs}件のタスクログを削除しました（instanceId: ${instanceId}）`,
        )
      }
    } catch (error) {
      console.error("[TaskChute] タスクログ削除処理でエラー:", error)
      throw error
    }
  }

  // タスク削除時にログファイルからも該当タスクを削除する
  async deleteTaskLogs(taskId) {
    try {
      let totalDeletedLogs = 0
      const dataDir = this.plugin.pathManager.getLogDataPath()

      // dataディレクトリが存在しない場合は何もしない
      if (!(await this.app.vault.adapter.exists(dataDir))) {
        return
      }

      // dataディレクトリ内の実際のファイル一覧を取得
      const files = await this.app.vault.adapter.list(dataDir)

      // -tasks.jsonで終わるファイルのみを処理
      const taskJsonFiles = files.files.filter((file) =>
        file.endsWith("-tasks.json"),
      )

      for (const fileName of taskJsonFiles) {
        // ファイル名のベース部分だけを使用してパスを構築
        const baseFileName = fileName.split("/").pop()
        const logFilePath = `${dataDir}/${baseFileName}`

        try {
          // ファイルを読み込み
          const content = await this.app.vault.adapter.read(logFilePath)
          const monthlyLog = JSON.parse(content)

          // 該当taskIdのログを削除
          let fileModified = false

          if (monthlyLog.taskExecutions) {
            for (const dateString in monthlyLog.taskExecutions) {
              const dayLogs = monthlyLog.taskExecutions[dateString]
              const originalLength = dayLogs.length

              // taskIdが一致するログを除外
              monthlyLog.taskExecutions[dateString] = dayLogs.filter(
                (log) => log.taskId !== taskId,
              )

              const deletedCount =
                originalLength - monthlyLog.taskExecutions[dateString].length
              if (deletedCount > 0) {
                totalDeletedLogs += deletedCount
                fileModified = true
              }

              // 空になった日のエントリを削除
              if (monthlyLog.taskExecutions[dateString].length === 0) {
                delete monthlyLog.taskExecutions[dateString]
              }
            }
          }

          // ファイルが変更された場合のみ書き戻し
          if (fileModified) {
            // メタデータの更新
            if (monthlyLog.metadata) {
              monthlyLog.metadata.lastUpdated = new Date().toISOString()
            }

            // dailySummaryの再計算
            if (monthlyLog.dailySummary && monthlyLog.taskExecutions) {
              for (const dateString in monthlyLog.dailySummary) {
                if (monthlyLog.taskExecutions[dateString]) {
                  const dayTasks = monthlyLog.taskExecutions[dateString]
                  const completedTasks = dayTasks.filter(
                    (t) => t.isCompleted && t.isCompleted !== false,
                  ).length

                  monthlyLog.dailySummary[dateString].totalTasks =
                    dayTasks.length
                  monthlyLog.dailySummary[dateString].completedTasks =
                    completedTasks
                } else {
                  // その日のタスクが全て削除された場合
                  delete monthlyLog.dailySummary[dateString]
                }
              }
            }

            // ファイルに書き戻し
            const jsonContent = JSON.stringify(monthlyLog, null, 2)
            await this.app.vault.adapter.write(logFilePath, jsonContent)
          }
        } catch (error) {
          console.warn(`ログファイル ${logFilePath} の処理中にエラー:`, error)
        }
      }

      if (totalDeletedLogs > 0) {
        console.log(
          `タスク "${taskId}" のログを ${totalDeletedLogs} 件削除しました`,
        )
        new Notice(`タスクログ ${totalDeletedLogs} 件を削除しました`)
      }
    } catch (error) {
      console.error("タスクログ削除中にエラー:", error)
      new Notice("タスクログの削除に失敗しました")
    }
  }

  async resetTaskToIdle(inst) {
    if (inst.state === "idle") return

    const originalState = inst.state

    // JSONからタスク記録を削除（完了タスクの場合）
    if (originalState === "done") {
      try {
        // ログファイルから該当タスクのエントリを完全に削除
        await this.deleteTaskLogs(inst.task.path)
      } catch (e) {
        console.error("JSON記録の削除に失敗:", e)
        new Notice("タスク記録の削除に失敗しました")
      }
    }

    // 状態をリセット
    inst.state = "idle"
    inst.startTime = null
    inst.stopTime = null

    if (originalState === "running") {
      await this.saveRunningTasksState() // 実行中タスクリストを更新
      this.manageTimers() // タイマー表示を更新
    }

    this.renderTaskList()
    new Notice(`「${inst.task.title}」を未実行に戻しました。`)
  }

  showRoutineEditModal(task, button) {
    // デバッグログ：タスクの現在の状態を確認
    console.log("[Routine Modal] Opening modal for task:", {
      title: task.title,
      routineType: task.routineType,
      weekday: task.weekday,
      weekdays: task.weekdays,
      scheduledTime: task.scheduledTime
    });

    // モーダルコンテナ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", { text: `「${task.title}」のルーチン編集` })

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // ルーチンタイプ選択（排他的チェックボックス方式）
    const typeGroup = form.createEl("div", { cls: "form-group" })
    typeGroup.createEl("label", { text: "ルーチンタイプ:", cls: "form-label" })

    const typeContainer = typeGroup.createEl("div", { cls: "checkbox-group" })

    // 毎日チェックボックス
    const dailyLabel = typeContainer.createEl("label", { cls: "checkbox-label" })
    const dailyCheckbox = dailyLabel.createEl("input", {
      type: "checkbox",
      id: "edit-routine-daily",
      value: "daily",
    })
    dailyLabel.createSpan({ text: "毎日" })

    // 曜日を選択チェックボックス
    const customLabel = typeContainer.createEl("label", { cls: "checkbox-label" })
    const customCheckbox = customLabel.createEl("input", {
      type: "checkbox",
      id: "edit-routine-custom",
      value: "custom",
    })
    customLabel.createSpan({ text: "曜日を選択" })

    // 曜日選択（複数選択チェックボックス）
    const weekdayGroup = form.createEl("div", {
      cls: "form-group",
      style: "display: none;", // 初期状態は非表示
    })
    weekdayGroup.id = "edit-weekday-group"
    weekdayGroup.createEl("label", { text: "曜日を選択:", cls: "form-label" })

    const weekdayContainer = weekdayGroup.createEl("div", { cls: "weekday-checkboxes" })
    
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"]
    const weekdayCheckboxes = []
    
    weekdays.forEach((day, index) => {
      const label = weekdayContainer.createEl("label", { cls: "weekday-checkbox-label" })
      const checkbox = label.createEl("input", {
        type: "checkbox",
        value: index.toString(),
        cls: "weekday-checkbox"
      })
      label.createSpan({ text: day })
      weekdayCheckboxes.push(checkbox)
    })

    // 初期状態の設定
    console.log("[Routine Modal] Setting initial state...");
    console.log("[Routine Modal] task.isRoutine:", task.isRoutine);
    
    if (task.isRoutine) {
      // 既存のルーチンタスクの場合
      if (task.routineType === "daily") {
        dailyCheckbox.checked = true
        customCheckbox.checked = false
      } else if (task.routineType === "weekly" || task.routineType === "custom") {
        // weekly は custom として扱う
        dailyCheckbox.checked = false
        customCheckbox.checked = true
        weekdayGroup.style.display = "block"
        
        // 曜日の初期選択を設定
        if (task.weekdays && Array.isArray(task.weekdays)) {
          console.log("[Routine Modal] Setting weekdays from array:", task.weekdays);
          task.weekdays.forEach(day => {
            if (weekdayCheckboxes[day]) {
              weekdayCheckboxes[day].checked = true
            }
          })
        } else if (task.weekday !== undefined && task.weekday !== null) {
          console.log("[Routine Modal] Setting weekday from single value:", task.weekday);
          if (weekdayCheckboxes[task.weekday]) {
            weekdayCheckboxes[task.weekday].checked = true
          }
        }
      } else {
        // ルーチンタイプが不明な場合はデフォルトで毎日
        dailyCheckbox.checked = true
        customCheckbox.checked = false
      }
    } else {
      // 新規ルーチン設定の場合は「毎日」をデフォルトに
      console.log("[Routine Modal] New routine - setting daily as default");
      dailyCheckbox.checked = true
      customCheckbox.checked = false
      weekdayGroup.style.display = "none"
    }

    // 開始時刻入力
    const timeGroup = form.createEl("div", { cls: "form-group" })
    timeGroup.createEl("label", { text: "開始予定時刻:", cls: "form-label" })
    const timeInput = timeGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: task.scheduledTime || "09:00",
    })

    // 説明
    const descGroup = form.createEl("div", { cls: "form-group" })
    const descText = descGroup.createEl("p", {
      cls: "form-description",
      text: `毎日この時刻にルーチンタスクとして実行予定です。`
    })

    // 説明文を更新する関数
    const updateDescription = () => {
      const selectedWeekdays = weekdayCheckboxes
        .map((cb, index) => cb.checked ? index : null)
        .filter(index => index !== null)
      
      if (customCheckbox.checked) {
        if (selectedWeekdays.length > 0) {
          const dayNames = selectedWeekdays.map(i => weekdays[i]).join("・")
          descText.textContent = `毎週 ${dayNames} の${timeInput.value}にルーチンタスクとして実行予定です。`
        } else {
          descText.textContent = "曜日を選択してください。"
        }
      } else {
        descText.textContent = "毎日この時刻にルーチンタスクとして実行予定です。"
      }
    }

    // ルーチンタイプ変更時の処理（排他制御）
    dailyCheckbox.addEventListener("change", () => {
      if (dailyCheckbox.checked) {
        customCheckbox.checked = false
        weekdayGroup.style.display = "none"
        updateDescription()
      } else if (!customCheckbox.checked) {
        // どちらも選択されていない場合は、チェックを維持
        dailyCheckbox.checked = true
      }
    })

    customCheckbox.addEventListener("change", () => {
      if (customCheckbox.checked) {
        dailyCheckbox.checked = false
        weekdayGroup.style.display = "block"
        updateDescription()
      } else if (!dailyCheckbox.checked) {
        // どちらも選択されていない場合は、チェックを維持
        customCheckbox.checked = true
      }
    })

    // 曜日チェックボックスの変更イベント
    weekdayCheckboxes.forEach(cb => {
      cb.addEventListener("change", updateDescription)
    })
    timeInput.addEventListener("input", updateDescription)
    
    // 初期表示の更新
    updateDescription()

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    })
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    })
    // 既存のルーチンタスクの場合のみ「ルーチンを外す」ボタンを表示
    let removeButton = null;
    if (task.isRoutine) {
      removeButton = buttonGroup.createEl("button", {
        type: "button",
        cls: "form-button cancel",
        text: "ルーチンを外す",
      })
    }

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })
    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })
    if (removeButton) {
      removeButton.addEventListener("click", async (e) => {
        e.preventDefault()
        e.stopPropagation()
        // submitイベントを一時的に無効化
        form.onsubmit = null
        await this.toggleRoutine(task, button)
        if (modal.parentNode) document.body.removeChild(modal)
      })
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault()
      const routineType = customCheckbox.checked ? "custom" : "daily"
      const scheduledTime = timeInput.value

      if (!scheduledTime) {
        new Notice("開始時刻を入力してください")
        return
      }

      let weekdaysArray = null
      let weekday = null // 後方互換性のため
      
      if (routineType === "custom") {
        const selectedWeekdays = weekdayCheckboxes
          .map((cb, index) => cb.checked ? index : null)
          .filter(index => index !== null)
        
        if (selectedWeekdays.length === 0) {
          new Notice("少なくとも1つの曜日を選択してください")
          return
        }
        
        weekdaysArray = selectedWeekdays
        // 後方互換性のため、単一曜日の場合はweekdayも設定
        if (selectedWeekdays.length === 1) {
          weekday = selectedWeekdays[0]
        }
      }

      console.log("[Routine Modal] Saving with:", {
        routineType,
        scheduledTime,
        weekdaysArray,
        weekday
      });

      await this.setRoutineTaskExtended(
        task,
        button,
        scheduledTime,
        routineType,
        weekday,
        weekdaysArray
      )
      document.body.removeChild(modal)
    })
    // モーダルを表示
    document.body.appendChild(modal)
    timeInput.focus()
  }

  moveTaskToSlot(taskId, newSlot) {
    // タスクを探してslotKeyを変更、scheduledTimeをリセット
    const task = this.tasks.find((t) => t.path === taskId)
    if (task) {
      task.slotKey = newSlot
      if (newSlot) {
        // 時間帯グループに移動した場合は開始時刻を空白に
        task.scheduledTime = null
        this.updateTaskFileScheduledTime(task)
      } else {
        // 時間指定なしグループに移動した場合はscheduledTimeを空白のまま
        task.scheduledTime = null
        this.updateTaskFileScheduledTime(task)
      }
      this.renderTaskList()
      // TODO: 並び順・slotKeyを永続化
    }
  }

  async updateTaskFileScheduledTime(task) {
    try {
      await this.ensureFrontMatter(task.file)
      // メタデータから開始時刻を削除
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          delete frontmatter.開始時刻
          return frontmatter
        },
      )
    } catch (e) {
      console.error("ファイルのscheduledTime削除に失敗:", e)
    }
  }

  // タスクのtarget_dateを更新するメソッド
  async updateTaskTargetDate(task, newDate) {
    try {
      await this.ensureFrontMatter(task.file)

      // 日付文字列を生成（YYYY-MM-DD形式）
      const year = newDate.getFullYear()
      const month = (newDate.getMonth() + 1).toString().padStart(2, "0")
      const day = newDate.getDate().toString().padStart(2, "0")
      const dateString = `${year}-${month}-${day}`

      // メタデータのtarget_dateを更新
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          frontmatter.target_date = dateString
          return frontmatter
        },
      )

      console.log(
        `[TaskChute] タスク "${task.title}" のtarget_dateを ${dateString} に更新しました`,
      )

      // タスクオブジェクト自体も更新（メモリ上）
      task.targetDate = dateString

      return true
    } catch (e) {
      console.error(`[TaskChute] target_date更新エラー: ${e}`)
      return false
    }
  }

  selectTask(task) {
    this.currentTask = task
  }
  
  // Keyboard selection methods
  selectTaskForKeyboard(instance, element) {
    this.clearTaskSelection()
    this.selectedTaskInstance = instance
    element.classList.add("keyboard-selected")
  }
  
  clearTaskSelection() {
    if (this.selectedTaskInstance) {
      if (this.taskList) {
        const selectedItems = this.taskList.querySelectorAll(".task-item.keyboard-selected")
        selectedItems.forEach(item => {
          item.classList.remove("keyboard-selected")
        })
      }
      this.selectedTaskInstance = null
    }
  }
  
  handleKeyboardShortcut(e) {
    // Don't handle shortcuts if typing in input fields
    const activeElement = document.activeElement
    if (
      activeElement &&
      activeElement !== document.body &&
      (activeElement.tagName === "INPUT" ||
        activeElement.tagName === "TEXTAREA" ||
        activeElement.contentEditable === "true")
    ) {
      return
    }

    // Don't handle shortcuts if modal is open
    if (document.querySelector(".modal")) {
      return
    }

    // Only handle if a task is selected
    if (!this.selectedTaskInstance) {
      return
    }

    // Handle shortcuts
    switch (e.key.toLowerCase()) {
      case "c":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          this.duplicateInstance(this.selectedTaskInstance)
          this.clearTaskSelection()
        }
        break
      case "d":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          this.deleteSelectedTask()
        }
        break
      case "u":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          if (this.selectedTaskInstance.state !== "idle") {
            this.resetTaskToIdle(this.selectedTaskInstance)
            this.clearTaskSelection()
          } else {
            new Notice("このタスクは既に未実行状態です")
          }
        }
        break
    }
  }
  
  async deleteSelectedTask() {
    if (!this.selectedTaskInstance) return
    
    const inst = this.selectedTaskInstance
    
    // 削除確認ダイアログを表示
    const confirmed = await this.showDeleteConfirmDialog(inst)
    if (confirmed) {
      // 統一された削除処理を使用（ツールチップと同じ処理）
      if (inst.task.isRoutine) {
        await this.deleteRoutineTask(inst)
      } else {
        await this.deleteNonRoutineTask(inst)
      }
    }
  }
  
  showDeleteConfirmDialog(inst) {
    return new Promise((resolve) => {
      const modal = document.createElement("div")
      modal.className = "task-modal-overlay"
      const modalContent = modal.createEl("div", { cls: "task-modal-content" })
      
      modalContent.createEl("h3", { text: "タスクの削除確認" })
      modalContent.createEl("p", { 
        text: `「${inst.task.title}」を削除してもよろしいですか？` 
      })
      
      const buttonContainer = modalContent.createEl("div", {
        cls: "modal-button-container",
      })
      
      const confirmButton = buttonContainer.createEl("button", {
        text: "削除",
        cls: "mod-cta",
      })
      
      const cancelButton = buttonContainer.createEl("button", {
        text: "キャンセル",
      })
      
      confirmButton.addEventListener("click", () => {
        modal.remove()
        resolve(true)
      })
      
      cancelButton.addEventListener("click", () => {
        modal.remove()
        resolve(false)
      })
      
      document.body.appendChild(modal)
    })
  }

  async showAddTaskModal() {
    // モーダルコンテナ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", { text: "新しいタスクを追加" })

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // タスク名入力
    const nameGroup = form.createEl("div", { cls: "form-group" })
    nameGroup.createEl("label", { text: "タスク名:", cls: "form-label" })
    const nameInput = nameGroup.createEl("input", {
      type: "text",
      cls: "form-input",
      placeholder: "タスク名を入力してください",
    })
    
    // 警告メッセージ要素の追加
    const warningMessage = nameGroup.createEl("div", {
      cls: "task-name-warning hidden",
      attr: { role: "alert", "aria-live": "polite" }
    })
    
    // TASK-008: TaskNameAutocompleteとの統合
    const autocomplete = new TaskNameAutocomplete(this.plugin, nameInput, nameGroup)
    await autocomplete.initialize()

    // タスク説明入力
    const descGroup = form.createEl("div", { cls: "form-group" })
    descGroup.createEl("label", { text: "説明:", cls: "form-label" })
    const descInput = descGroup.createEl("textarea", {
      cls: "form-textarea",
      placeholder: "タスクの詳細を入力してください（任意）",
    })

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    })
    const createButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "作成",
    })

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    form.addEventListener("submit", async (e) => {
      e.preventDefault()

      const taskName = nameInput.value.trim()
      const taskDesc = descInput.value.trim()

      if (!taskName) {
        new Notice("タスク名を入力してください")
        return
      }
      
      // 送信時に再度検証
      if (!this.validateTaskNameBeforeSubmit(nameInput)) {
        this.highlightWarning(warningMessage)
        return
      }

      await this.createNewTask(taskName, taskDesc)
      document.body.removeChild(modal)
    })

    // モーダルを表示
    document.body.appendChild(modal)

    // 入力検証の設定
    this.setupTaskNameValidation(nameInput, createButton, warningMessage)
    
    // Enterキー処理（自動補完との競合を防ぐ）
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        // 自動補完が選択されている場合は処理しない
        if (autocomplete.isVisible && autocomplete.selectedIndex >= 0) {
          return
        }
        // Enterキーのデフォルト動作を防ぐ（フォーム送信を防ぐ）
        e.preventDefault()
        // バリデーションチェックのみ行い、警告表示
        const validation = this.TaskNameValidator.validate(nameInput.value)
        if (!validation.isValid) {
          this.highlightWarning(warningMessage)
        }
        // フォーム送信はしない（タスク作成は作成ボタンのクリックのみ）
      }
    })
    
    // モーダルが閉じられる時に自動補完も非表示にする
    const cleanup = () => {
      autocomplete.hideSuggestions()
      clearTimeout(autocomplete.debounceTimer)
    }
    
    closeButton.addEventListener("click", cleanup)
    cancelButton.addEventListener("click", cleanup)
    
    // フォーカスを設定
    nameInput.focus()
  }
  
  // タスク名検証のセットアップ
  setupTaskNameValidation(inputElement, submitButton, warningElement) {
    // デバウンス用タイマー
    let validationTimer;
    
    inputElement.addEventListener("input", () => {
      clearTimeout(validationTimer);
      validationTimer = setTimeout(() => {
        const validation = this.TaskNameValidator.validate(inputElement.value);
        this.updateValidationUI(inputElement, submitButton, warningElement, validation);
      }, 50); // 50ms以内の検証要件に対応
    });
    
    // 初期状態の設定
    const initialValidation = this.TaskNameValidator.validate(inputElement.value);
    this.updateValidationUI(inputElement, submitButton, warningElement, initialValidation);
  }
  
  // 検証UIの更新
  updateValidationUI(input, button, warning, validation) {
    if (validation.isValid) {
      // 正常状態
      input.classList.remove("error");
      button.disabled = false;
      button.classList.remove("disabled");
      warning.classList.add("hidden");
      warning.textContent = "";
    } else {
      // エラー状態
      input.classList.add("error");
      button.disabled = true;
      button.classList.add("disabled");
      warning.classList.remove("hidden");
      warning.textContent = this.TaskNameValidator.getErrorMessage(validation.invalidChars);
    }
  }
  
  // 警告メッセージの強調表示
  highlightWarning(warningElement) {
    warningElement.classList.add("highlight");
    setTimeout(() => warningElement.classList.remove("highlight"), 300);
  }
  
  // 送信前の検証
  validateTaskNameBeforeSubmit(nameInput) {
    const validation = this.TaskNameValidator.validate(nameInput.value);
    return validation.isValid;
  }

  async createNewTask(taskName, taskDesc) {
    try {
      // ファイル名を生成（重複を避ける）
      let fileName = taskName
      let counter = 1
      const taskFolderPath = this.plugin.pathManager.getTaskFolderPath()
      while (
        this.app.vault.getAbstractFileByPath(`${taskFolderPath}/${fileName}.md`)
      ) {
        fileName = `${taskName} (${counter})`
        counter++
      }

      // 現在表示中の日付を取得
      const y = this.currentDate.getFullYear()
      const m = (this.currentDate.getMonth() + 1).toString().padStart(2, "0")
      const d = this.currentDate.getDate().toString().padStart(2, "0")
      const targetDateString = `${y}-${m}-${d}`

      // メタデータ付きのファイル内容を作成（対象日付を記録）
      let content = `---
routine: false
target_date: ${targetDateString}
---

# ${taskName}

#task

`
      if (taskDesc) {
        content += `${taskDesc}\n\n`
      }
      content += `## メモ

`

      // ファイルを作成（タスクフォルダ配下）
      const filePath = `${taskFolderPath}/${fileName}.md`
      const file = await this.app.vault.create(
        filePath,
        content,
      )

      // 削除済みリストから該当パスを削除
      // これにより、同じ名前のタスクを再作成した場合でも正しく表示される
      try {
        let deletedTasks = JSON.parse(
          localStorage.getItem("taskchute-deleted-tasks") || "[]",
        )
        if (deletedTasks.includes(filePath)) {
          deletedTasks = deletedTasks.filter(path => path !== filePath)
          localStorage.setItem(
            "taskchute-deleted-tasks",
            JSON.stringify(deletedTasks),
          )
          console.log(`[TaskChute] 削除済みリストから「${filePath}」を削除しました`)
        }
      } catch (e) {
        console.error("[TaskChute] 削除済みリストの更新に失敗:", e)
      }

      // タスク作成後は loadTasks を再実行して、適切なフィルタリングを適用
      // これにより、表示日付と作成対象日付の一貫性が保たれる
      await this.loadTasks()

      new Notice(`タスク「${taskName}」を作成しました`)
    } catch (error) {
      console.error("タスク作成に失敗しました:", error)
      
      // エラーメッセージの改善
      let errorMessage = "タスクの作成に失敗しました"
      if (error.message.includes("Invalid characters") || 
          this.TaskNameValidator.validate(taskName).isValid === false) {
        errorMessage = "タスクの作成に失敗しました: ファイル名に使用できない文字が含まれています"
      }
      
      new Notice(errorMessage)
    }
  }

  // 統合プロジェクトモーダルを表示
  async showUnifiedProjectModal(inst) {
    try {
      // モーダルコンテナ
      const modal = document.createElement("div")
      modal.className = "task-modal-overlay"

      const modalContent = modal.createEl("div", { cls: "task-modal-content" })

      // モーダルヘッダー
      const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
      modalHeader.createEl("h3", {
        text: `「${inst.task.title}」のプロジェクト設定`,
      })

      // 閉じるボタン
      const closeButton = modalHeader.createEl("button", {
        cls: "modal-close-button",
        text: "×",
        attr: { title: "閉じる" },
      })

      // フォーム
      const form = modalContent.createEl("form", { cls: "task-form" })

      // プロジェクトリストを取得
      let projectFiles = []
      try {
        projectFiles = await this.loadAvailableProjects()
      } catch (error) {
        console.error("プロジェクトリストの読み込みに失敗:", error)
        new Notice("プロジェクトリストの読み込みに失敗しました")
        modal.remove()
        return
      }

      if (projectFiles.length === 0) {
        // プロジェクトファイルがない場合
        const noProjectGroup = form.createEl("div", { cls: "form-group" })
        noProjectGroup.createEl("p", {
          text: "プロジェクトファイルが見つかりません。",
          cls: "form-description",
        })
        noProjectGroup.createEl("p", {
          text: "プロジェクトファイルに #project タグを追加してください。",
          cls: "form-description",
        })
      } else {
        // プロジェクト選択
        const projectGroup = form.createEl("div", { cls: "form-group" })
        projectGroup.createEl("label", {
          text: "プロジェクトを選択:",
          cls: "form-label",
        })

        const projectSelect = projectGroup.createEl("select", {
          cls: "form-input",
        })

        // プロジェクトが設定されている場合のみ「プロジェクトを外す」オプションを追加
        if (inst.task.projectPath) {
          const removeProjectOption = projectSelect.createEl("option", {
            value: "",
            text: "➖ プロジェクトを外す",
          })
        } else {
          // 未設定の場合は空のオプションを追加
          const emptyOption = projectSelect.createEl("option", {
            value: "",
            text: "",
          })
          emptyOption.selected = true
        }

        // プロジェクト一覧を追加
        projectFiles.forEach((project) => {
          const option = projectSelect.createEl("option", {
            value: project.path,
            text: project.basename,
          })

          // 現在のプロジェクトが設定されている場合は選択
          if (inst.task.projectPath === project.path) {
            option.selected = true
          }
        })

        // 説明
        const descGroup = form.createEl("div", { cls: "form-group" })

        if (inst.task.projectPath) {
          // プロジェクト設定済みの場合の説明
          descGroup.createEl("p", {
            text: "別のプロジェクトを選択するか、「プロジェクトを外す」を選択してプロジェクトを解除できます。",
            cls: "form-description",
          })
        } else {
          // プロジェクト未設定の場合の説明
          descGroup.createEl("p", {
            text: "選択したプロジェクトがタスクに紐づけられます。",
            cls: "form-description",
          })
        }
      }

      // ボタンエリア
      const buttonGroup = form.createEl("div", { cls: "form-button-group" })
      const cancelButton = buttonGroup.createEl("button", {
        type: "button",
        cls: "form-button cancel",
        text: "キャンセル",
      })
      const saveButton = buttonGroup.createEl("button", {
        type: "submit",
        cls: "form-button create",
        text: "保存",
      })

      // イベントリスナー
      closeButton.addEventListener("click", () => {
        document.body.removeChild(modal)
      })

      cancelButton.addEventListener("click", () => {
        document.body.removeChild(modal)
      })

      form.addEventListener("submit", async (e) => {
        e.preventDefault()

        try {
          if (projectFiles.length > 0) {
            const projectSelect = form.querySelector("select")
            const selectedProjectPath = projectSelect.value

            await this.setProjectForTask(inst.task, selectedProjectPath)
            // プロジェクト表示の更新
            this.updateProjectDisplay(inst)
          }

          document.body.removeChild(modal)
          this.renderTaskList()
        } catch (error) {
          console.error("プロジェクトの設定に失敗:", error)
          new Notice("プロジェクトの設定に失敗しました")
        }
      })

      // ESCキーで閉じる
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          modal.remove()
        }
      })

      // モーダルを表示
      document.body.appendChild(modal)
    } catch (error) {
      console.error("プロジェクトモーダルの表示に失敗:", error)
      new Notice("プロジェクト設定画面の表示に失敗しました")
    }
  }

  // プロジェクト選択モーダルを表示
  async showProjectSelectionModal(inst) {
    try {
      // モーダルコンテナ
      const modal = document.createElement("div")
      modal.className = "task-modal-overlay"

      const modalContent = modal.createEl("div", { cls: "task-modal-content" })

      // モーダルヘッダー
      const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
      modalHeader.createEl("h3", {
        text: `「${inst.task.title}」のプロジェクト設定`,
      })

      // 閉じるボタン
      const closeButton = modalHeader.createEl("button", {
        cls: "modal-close-button",
        text: "×",
        attr: { title: "閉じる" },
      })

      // フォーム
      const form = modalContent.createEl("form", { cls: "task-form" })

      // プロジェクトリストを取得
      let projectFiles = []
      try {
        projectFiles = await this.loadAvailableProjects()
      } catch (error) {
        console.error("プロジェクトリストの読み込みに失敗:", error)
        new Notice("プロジェクトリストの読み込みに失敗しました")
        modal.remove()
        return
      }

      if (projectFiles.length === 0) {
        // プロジェクトファイルがない場合
        const noProjectGroup = form.createEl("div", { cls: "form-group" })
        noProjectGroup.createEl("p", {
          text: "プロジェクトファイルが見つかりません。",
          cls: "form-description",
        })
        noProjectGroup.createEl("p", {
          text: "プロジェクトファイルに #project タグを追加してください。",
          cls: "form-description",
        })
      } else {
        // プロジェクト選択
        const projectGroup = form.createEl("div", { cls: "form-group" })
        projectGroup.createEl("label", {
          text: "プロジェクトを選択:",
          cls: "form-label",
        })

        const projectSelect = projectGroup.createEl("select", {
          cls: "form-input",
        })

        // プロジェクトが設定されている場合のみ「プロジェクトを外す」オプションを追加
        if (inst.task.projectPath) {
          const removeProjectOption = projectSelect.createEl("option", {
            value: "",
            text: "➖ プロジェクトを外す",
          })
        } else {
          // 未設定の場合は空のオプションを追加
          const emptyOption = projectSelect.createEl("option", {
            value: "",
            text: "",
          })
          emptyOption.selected = true
        }

        // プロジェクト一覧を追加
        projectFiles.forEach((project) => {
          const option = projectSelect.createEl("option", {
            value: project.path,
            text: project.basename,
          })

          // 現在のプロジェクトが設定されている場合は選択
          if (inst.task.projectPath === project.path) {
            option.selected = true
          }
        })

        // 説明
        const descGroup = form.createEl("div", { cls: "form-group" })
        descGroup.createEl("p", {
          text: "選択したプロジェクトがタスクに紐づけられます。",
          cls: "form-description",
        })
      }

      // ボタンエリア
      const buttonGroup = form.createEl("div", { cls: "form-button-group" })
      const cancelButton = buttonGroup.createEl("button", {
        type: "button",
        cls: "form-button cancel",
        text: "キャンセル",
      })
      const saveButton = buttonGroup.createEl("button", {
        type: "submit",
        cls: "form-button create",
        text: "保存",
      })

      // イベントリスナー
      closeButton.addEventListener("click", () => {
        document.body.removeChild(modal)
      })

      cancelButton.addEventListener("click", () => {
        document.body.removeChild(modal)
      })

      form.addEventListener("submit", async (e) => {
        e.preventDefault()

        try {
          if (projectFiles.length > 0) {
            const projectSelect = form.querySelector("select")
            const selectedProjectPath = projectSelect.value

            await this.setProjectForTask(inst.task, selectedProjectPath)
            // プロジェクトアイコンボタンの状態を更新
            this.updateProjectIconButton(inst)
          }

          document.body.removeChild(modal)
          this.renderTaskList()
        } catch (error) {
          console.error("プロジェクトの設定に失敗:", error)
          new Notice("プロジェクトの設定に失敗しました")
        }
      })

      // ESCキーで閉じる
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          modal.remove()
        }
      })

      // モーダルを表示
      document.body.appendChild(modal)
    } catch (error) {
      console.error("プロジェクト選択モーダルの表示に失敗:", error)
      new Notice("プロジェクト選択画面の表示に失敗しました")
    }
  }

  // 利用可能なプロジェクトを読み込む
  async loadAvailableProjects() {
    return await this.getProjectFiles()
  }

  // プロジェクト表示の更新
  updateProjectDisplay(inst) {
    // 該当するタスクアイテムを見つける
    const taskItem = this.taskList.querySelector(`[data-task-path="${inst.task.path}"]`)
    if (taskItem) {
      const projectDisplay = taskItem.querySelector('.taskchute-project-display')
      if (projectDisplay) {
        // 既存の表示をクリア
        projectDisplay.empty()
        
        if (inst.task.projectPath && inst.task.projectTitle) {
          // プロジェクト設定済みの場合
          const projectButton = projectDisplay.createEl("span", {
            cls: "taskchute-project-button",
            attr: { 
              title: `プロジェクト: ${inst.task.projectTitle}` 
            }
          })
          
          const folderIcon = projectButton.createEl("span", {
            cls: "taskchute-project-icon",
            text: "📁"
          })
          
          const projectName = projectButton.createEl("span", {
            cls: "taskchute-project-name",
            text: inst.task.projectTitle.replace(/^Project\s*-\s*/, '')
          })
          
          projectButton.addEventListener("click", async (e) => {
            e.stopPropagation()
            await this.showUnifiedProjectModal(inst)
          })
          
          const externalLinkIcon = projectDisplay.createEl("span", {
            cls: "taskchute-external-link",
            text: "🔗",
            attr: { title: "プロジェクトノートを開く" }
          })
          
          externalLinkIcon.addEventListener("click", async (e) => {
            e.stopPropagation()
            await this.openProjectInSplit(inst.task.projectPath)
          })
        } else {
          // プロジェクト未設定の場合（ホバーで表示）
          const projectPlaceholder = projectDisplay.createEl("span", {
            cls: "taskchute-project-placeholder",
            attr: { title: "クリックしてプロジェクトを設定" }
          })
          
          projectPlaceholder.addEventListener("click", async (e) => {
            e.stopPropagation()
            await this.showUnifiedProjectModal(inst)
          })
        }
      }
    }
  }

  // プロジェクトアイコンボタンの状態を更新（互換性のため残す）
  updateProjectIconButton(inst) {
    this.updateProjectDisplay(inst)
  }

  async showRoutineTasks() {
    try {
      // ルーチンタスクを取得
      const routineTasks = this.tasks.filter((task) => task.isRoutine)

      if (routineTasks.length === 0) {
        new Notice("ルーチンタスクがありません")
        return
      }

      // ルーチンタスクリストを表示
      const taskList = routineTasks.map((task) => `• ${task.title}`).join("\n")
      new Notice(
        `今日のルーチンタスク (${routineTasks.length}個):\n${taskList}`,
        8000,
      )
    } catch (error) {
      console.error("ルーチンタスクの表示に失敗しました:", error)
      new Notice("ルーチンタスクの表示に失敗しました")
    }
  }

  async toggleTask() {
    if (!this.currentInstance) return

    if (!this.isRunning) {
      // スタート
      await this.startInstance(this.currentInstance)
    } else {
      // ストップ
      await this.stopInstance(this.currentInstance)
    }
  }

  resetTask() {
    this.isRunning = false
    this.startTime = null
    this.stopTime = null
    this.currentInstance = null

    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
    }

    // 選択状態をリセット
    this.taskList.querySelectorAll(".task-item").forEach((item) => {
      item.classList.remove("selected")
    })
  }

  applyStyles() {
    // スタイルを動的に追加
    const style = document.createElement("style")
    style.textContent = `
            .taskchute-container {
                height: 100%;
                min-height: 0;
                display: flex;
                flex-direction: column;
            }
            
            /* TASK-012: タスク名自動補完のスタイル */
            .task-name-suggestions {
                position: absolute;
                z-index: 1000;
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                max-height: 200px;
                overflow-y: auto;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                margin-top: 2px;
            }
            
            .suggestion-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.1s;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .suggestion-item:hover,
            .suggestion-item-selected {
                background-color: var(--background-modifier-hover);
            }
            
            .suggestion-item-selected {
                background-color: var(--background-modifier-hover);
                font-weight: 500;
            }
            
            /* Main Container Layout */
            .main-container {
                display: flex;
                position: relative;
                flex: 1;
                min-height: 0;
            }
            
            /* Top Bar Container */
            .top-bar-container {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 10px;
                height: 30px; /* Fixed height matching date navigation */
            }
            
            /* Header Divider */
            .header-divider {
                width: 1px;
                height: 20px;
                background-color: var(--background-modifier-border);
                margin: 5px 0;
            }
            
            /* Header Action Section */
            .header-action-section {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            /* Drawer Toggle Button */
            .drawer-toggle {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                padding: 0 10px;
                cursor: pointer;
                font-size: 16px;
                transition: background-color 0.2s ease;
                height: 100%;
                display: flex;
                align-items: center;
            }
            
            .drawer-toggle:hover {
                background: var(--background-modifier-hover);
            }
            
            /* Navigation Overlay */
            .navigation-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.3);
                z-index: 999;
                transition: opacity 0.3s ease;
            }
            
            .navigation-overlay-hidden {
                opacity: 0;
                pointer-events: none;
            }
            
            .navigation-overlay-visible {
                opacity: 1;
                pointer-events: auto;
            }
            
            /* Navigation Panel */
            .navigation-panel {
                position: fixed;
                left: 0;
                top: 0;
                height: 100%;
                width: 250px;
                background: var(--background-primary);
                border-right: 1px solid var(--background-modifier-border);
                box-shadow: 2px 0 10px rgba(0, 0, 0, 0.1);
                z-index: 1000;
                transition: transform 0.3s ease;
                overflow-y: auto;
            }
            
            .navigation-panel-hidden {
                transform: translateX(-100%);
            }
            
            .navigation-panel-visible {
                transform: translateX(0);
            }
            
            /* Navigation Header - removed close button */
            .navigation-header {
                display: none;
            }
            
            /* Navigation Items */
            .navigation-nav {
                padding: 20px 0;
            }
            
            .navigation-nav-item {
                display: flex;
                align-items: center;
                padding: 10px 15px;
                cursor: pointer;
                transition: background-color 0.2s ease;
            }
            
            .navigation-nav-item:hover {
                background: var(--background-modifier-hover);
            }
            
            .navigation-nav-item.active {
                background: var(--background-modifier-active);
                font-weight: 500;
            }
            
            .navigation-nav-icon {
                margin-right: 10px;
                font-size: 16px;
            }
            
            .navigation-nav-label {
                font-size: 13px;
            }
            .task-list-container {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
            }
            
            .button-container {
                display: flex;
                gap: 10px;
                justify-content: center;
                margin: 15px 0;
            }
            
            .task-button {
                padding: 8px 16px;
                border: none;
                border-radius: 4px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                min-width: 70px;
            }
            
            .task-button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .task-button.start {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }
            
            .task-button.start:hover:not(:disabled) {
                background: var(--interactive-accent-hover);
            }
            
            .task-button.stop {
                background: #e74c3c;
                color: white;
            }
            
            .task-button.stop:hover {
                background: #c0392b;
            }
            
            .task-button.reset {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .task-button.reset:hover {
                background: var(--background-modifier-border-hover);
            }
            
            .future-task-button {
                background-color: var(--background-modifier-border) !important;
                color: var(--text-muted) !important;
                cursor: not-allowed !important;
            }

            
            .task-list-container {
                margin-top: 10px;
                flex: 1;
                display: flex;
                flex-direction: column;
                min-height: 0;
            }
            
            .task-list-container h5 {
                margin: 0 0 10px 0;
                color: var(--text-muted);
            }
            
            .task-list {
                flex: 1 1 auto;
                height: 100%;
                min-height: 0;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                padding-bottom: 50px;
                display: flex;
                flex-direction: column;
                overflow: auto;
            }
            
            .task-item {
                padding: 8px 12px;
                cursor: default;
                border-bottom: 1px solid var(--background-modifier-border);
                transition: background-color 0.2s ease;
            }
            
            .task-item:last-child {
                border-bottom: none;
            }
            
            .task-item:hover {
                background: var(--background-secondary);
            }
            
            .task-item.selected {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }
            
            .task-item.keyboard-selected {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                box-shadow: 0 0 0 2px var(--interactive-accent-hover);
            }
            
            .task-item.completed {
                cursor: default;
            }
            
            /* 完了済みタスクのドラッグハンドルは表示するが無効化 */
            .drag-handle.disabled {
                cursor: default;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.2s ease;
            }
            
            .task-item:hover .drag-handle.disabled {
                opacity: 0.3;
            }
            
            .task-item {
                display: grid;
                grid-template-columns: 20px 40px 1fr 220px 110px 50px 30px 30px 30px;
                gap: 8px;
                align-items: center;
                padding: 2px 10px 2px 15px;
                margin: 2px 0;
            }
            
            /* ドラッグハンドルのスタイル */
            .drag-handle {
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: var(--text-muted);
                opacity: 0;
                transition: opacity 0.2s ease, background-color 0.2s ease;
                border-radius: 4px;
            }
            
            .task-item:hover .drag-handle {
                opacity: 0.6;
            }
            
            .drag-handle:hover {
                opacity: 1 !important;
                color: var(--text-normal);
                background-color: var(--background-modifier-hover);
            }
            
            .drag-handle:active {
                cursor: grabbing;
            }
            
            .drag-handle svg {
                width: 10px;
                height: 16px;
            }
            
            .task-item.dragging {
                opacity: 0.5;
                background: var(--background-modifier-hover);
                transform: scale(0.98);
                transition: all 0.2s ease;
            }
            
            .task-item.dragover {
                border-top: 2px solid var(--interactive-accent);
                margin-top: -2px;
            }
            
            .task-item.dragover-invalid {
                border-top: 2px solid var(--text-error);
                margin-top: -2px;
                opacity: 0.7;
                cursor: not-allowed;
                background-color: rgba(255, 0, 0, 0.05);
                position: relative;
            }
            
            .task-item.dragover-invalid::after {
                content: "❌ ここには配置できません";
                position: absolute;
                top: -25px;
                left: 50%;
                transform: translateX(-50%);
                background-color: var(--text-error);
                color: white;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                white-space: nowrap;
                z-index: 1000;
                pointer-events: none;
            }
            
            .task-name {
                cursor: pointer;
                font-weight: 500;
                font-size: 13px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                margin-right: -4px; /* プロジェクトとの間隔を狭める */
            }
            
            .task-time-range {
                font-size: 12px;
                color: var(--text-muted);
                font-family: monospace;
                white-space: nowrap;
                text-align: center;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            .task-duration,
            .task-timer-display {
                font-size: 12px;
                color: var(--text-muted);
                text-align: center;
                font-family: monospace;
            }

            .task-timer-display {
                color: var(--interactive-accent);
                font-weight: bold;
            }
            
            .time-slot-header {
                background: var(--background-secondary);
                color: var(--text-muted);
                font-size: 12px;
                font-weight: 600;
                padding: 6px 12px;
                margin: 8px 0 4px 0;
                border-radius: 4px;
                border-left: 3px solid var(--interactive-accent);
            }
            
            .time-slot-header.other {
                border-left-color: var(--background-modifier-border);
            }
            
            .time-slot-header.dragover {
                background: var(--background-modifier-hover);
                border-left-width: 5px;
                transition: all 0.2s ease;
            }
            
            .routine-button {
                background: none;
                border: none;
                font-size: 14px;
                cursor: pointer;
                padding: 2px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .routine-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
            }
            
            .routine-button.active {
                opacity: 1;
                color: var(--interactive-accent);
            }
            
            /* コメントボタンスタイル */
            .comment-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0;
                width: 100%;
                text-align: center;
            }
            
            .task-item:hover .comment-button {
                opacity: 0.6;
            }
            
            .comment-button:hover {
                opacity: 1 !important;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .comment-button.active {
                opacity: 0.6;
                color: var(--interactive-accent);
            }
            
            .task-item:hover .comment-button.active {
                opacity: 1;
            }
            
            /* プロジェクト表示コンポーネント全体 */
            .taskchute-project-display {
                display: flex;
                align-items: center;
                gap: 4px;
                justify-content: flex-start;
                margin-right: 32px; /* 時間との間隔を広げる */
            }
            
            /* プロジェクトボタン（フォルダアイコン + プロジェクト名） */
            .taskchute-project-button {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s ease;
                background: var(--background-secondary);
                border: 1px solid var(--background-modifier-border);
                color: var(--text-normal);
                font-size: 13px;
                max-width: 100%;
            }
            
            .taskchute-project-button:hover {
                background: var(--background-modifier-hover);
                border-color: var(--interactive-accent);
            }
            
            /* プロジェクト未設定の場合 */
            .taskchute-project-button.empty {
                color: var(--text-muted);
                border-style: dashed;
            }
            
            /* フォルダアイコン */
            .taskchute-project-icon {
                font-size: 14px;
                flex-shrink: 0;
            }
            
            /* プロジェクト名 */
            .taskchute-project-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            
            /* External Linkアイコン */
            .taskchute-external-link {
                font-size: 14px;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 4px;
                transition: all 0.2s ease;
                color: var(--text-muted);
            }
            
            .taskchute-external-link:hover {
                background: var(--background-modifier-hover);
                color: var(--interactive-accent);
            }
            
            /* プロジェクト未設定時のプレースホルダー */
            .taskchute-project-placeholder {
                display: inline-flex;
                align-items: center;
                padding: 2px 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s ease;
                opacity: 0;
                border: 1px dashed var(--background-modifier-border);
                color: var(--text-muted);
                font-size: 13px;
                min-width: 100px;
            }
            
            .taskchute-project-placeholder::before {
                content: "📁 プロジェクトを設定";
                font-size: 13px;
            }
            
            .task-item:hover .taskchute-project-placeholder {
                opacity: 0.6;
            }
            
            /* ホバー時の明るくなる効果を削除 */
            .taskchute-project-placeholder:hover {
                /* opacity: 1 !important; 削除 */
                /* background: var(--background-modifier-hover); 削除 */
                /* border-color: var(--interactive-accent); 削除 */
                /* color: var(--text-normal); 削除 */
            }
            
            /* プロジェクトボタンスタイル */
            .project-button,
            .project-placeholder {
                margin-left: 15px;
                margin-right: 4px;
                font-size: 14px;
                border: none;
                background: none;
                padding: 2px 6px;
                border-radius: 4px;
                transition: all 0.2s ease;
                min-width: 26px; /* 一定の幅を確保 */
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }
            
            .project-button {
                cursor: pointer;
                color: var(--text-muted);
                opacity: 0.7;
            }
            
            .project-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .project-placeholder {
                /* 透明でスペースのみ確保 */
                opacity: 0;
                pointer-events: none;
            }
            
            .task-list-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
                gap: 8px;
            }
            
            .header-left-section {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .header-left-section h5 {
                margin: 0;
                color: var(--text-muted);
            }
            
            .header-right-section {
                display: flex;
                align-items: center;
            }
            
            /* Grayed out effect for task list */
            .task-list-container.grayed-out {
                opacity: 0.6;
                pointer-events: none;
            }
            
            .add-task-button {
                margin-left: 0;
                margin-right: 15px;
            }
            
            .add-task-button.repositioned {
                margin-left: 0;
                margin-right: 0;
            }
            
            .robot-terminal-button {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                padding: 4px 8px;
                cursor: pointer;
                font-size: 16px;
                transition: background-color 0.2s ease;
                margin-right: 15px;
            }
            
            .robot-terminal-button:hover {
                background: var(--background-modifier-hover);
            }
            
            /* モーダルスタイル */
            .task-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            }
            
            .task-modal-content {
                background: var(--background-primary);
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                width: 90%;
                max-width: 500px;
                max-height: 80vh;
                overflow-y: auto;
            }
            
            .modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 20px 20px 0 20px;
                border-bottom: 1px solid var(--background-modifier-border);
            }
            
            .modal-header h3 {
                margin: 0;
                color: var(--text-normal);
            }
            
            .modal-close-button {
                background: none;
                border: none;
                font-size: 24px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 4px;
                transition: all 0.2s ease;
            }
            
            .modal-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .task-form {
                padding: 20px;
            }
            
            .form-group {
                margin-bottom: 15px;
            }
            
            .form-label {
                display: block;
                margin-bottom: 5px;
                font-weight: 500;
                color: var(--text-normal);
            }
            
            .form-input,
            .form-textarea {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            /* セレクトボックスの高さ調整 */
            select.form-input {
                min-height: 36px;
                line-height: 1.5;
                padding: 8px 12px;
            }
            
            .form-input:focus,
            .form-textarea:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            .form-textarea {
                min-height: 80px;
                resize: vertical;
            }
            
            .form-button-group {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
                margin-top: 20px;
            }
            
            .form-button {
                padding: 8px 16px;
                border: none;
                border-radius: 4px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                min-width: 80px;
            }
            
            .form-button.cancel {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .form-button.cancel:hover {
                background: var(--background-modifier-border-hover);
            }
            
            .form-button.create {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }
            
            .form-button.create:hover {
                background: var(--interactive-accent-hover);
            }
            
            .form-description {
                margin: 0;
                color: var(--text-muted);
                font-size: 13px;
                line-height: 1.4;
            }
            
            .task-name.wikilink {
                color: var(--link-color);
                text-decoration: none;
                cursor: pointer;
                font-weight: 500;
                border-radius: 3px;
                padding: 2px 4px;
                transition: background 0.15s;
            }
            .task-name.wikilink:hover {
                background: var(--background-modifier-hover);
                color: var(--link-color-hover);
            }
            .play-stop-button {
                font-size: 18px;
                border: none;
                background: none;
                cursor: pointer;
                transition: color 0.2s;
                color: #3498db;
                padding: 2px;
                border-radius: 4px;
                width: 100%;
                text-align: center;
            }
            .play-stop-button.stop {
                color: #e74c3c;
                font-weight: bold;
                background: var(--background-modifier-border);
            }
            .task-item.selected {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                font-weight: bold;
            }
            .delete-task-button {
                margin-left: 8px;
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: #e74c3c;
                padding: 2px 6px;
                border-radius: 4px;
                transition: background 0.2s;
            }
            .delete-task-button:hover {
                background: var(--background-modifier-border);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* 完了演出スタイル */
            .celebration-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                animation: fadeIn 0.5s ease-in;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .celebration-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                animation: bounceIn 0.8s ease-out;
                position: relative;
                overflow: hidden;
            }

            @keyframes bounceIn {
                0% {
                    transform: scale(0.3);
                    opacity: 0;
                }
                50% {
                    transform: scale(1.05);
                }
                70% {
                    transform: scale(0.9);
                }
                100% {
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .celebration-title {
                font-size: 32px;
                font-weight: bold;
                color: white;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }

            .celebration-message {
                font-size: 18px;
                color: white;
                margin-bottom: 30px;
                opacity: 0.9;
            }

            .fireworks-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .firework {
                position: absolute;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                animation: fireworkExplosion 2s ease-out forwards;
            }

            @keyframes fireworkExplosion {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1);
                    opacity: 1;
                }
                100% {
                    transform: scale(0);
                    opacity: 0;
                }
            }

            .celebration-close-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid white;
                color: white;
                padding: 12px 24px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                margin-top: 20px;
            }

            .celebration-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            /* 花火の追加エフェクト */
            .firework::before,
            .firework::after {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: inherit;
                animation: fireworkSparkle 2s ease-out forwards;
            }

            .firework::before {
                animation-delay: 0.1s;
            }

            .firework::after {
                animation-delay: 0.2s;
            }

            @keyframes fireworkSparkle {
                0% {
                    transform: scale(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: scale(2) rotate(360deg);
                    opacity: 0;
                }
            }

            /* パーティクル効果 */
            .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                animation: particleExplosion 1.5s ease-out forwards;
            }

            @keyframes particleExplosion {
                0% {
                    transform: scale(0) translateX(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1) translateX(50px);
                    opacity: 1;
                }
                100% {
                    transform: scale(0) translateX(100px);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                animation: glowPulse 3s ease-in-out infinite;
            }

            @keyframes glowPulse {
                0%, 100% { opacity: 0.3; }
                50% { opacity: 0.8; }
            }

            /* 統計表示スタイル */
            .celebration-stats {
                display: flex;
                justify-content: space-around;
                margin: 20px 0;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            .stat-number {
                display: block;
                font-size: 24px;
                font-weight: bold;
                color: white;
                margin-bottom: 5px;
            }

            .stat-label {
                display: block;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.8);
            }

            /* 紙吹雪エフェクト */
            .confetti-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
            }

            .confetti {
                position: absolute;
                top: -10px;
                border-radius: 2px;
                animation: confettiFall 3s linear forwards;
            }

            @keyframes confettiFall {
                0% {
                    transform: translateY(-10px) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 2s ease-in-out infinite;
            }

            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* 完了演出スタイル */
            .celebration-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                animation: fadeIn 0.5s ease-in;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .celebration-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                animation: bounceIn 0.8s ease-out;
                position: relative;
                overflow: hidden;
            }

            @keyframes bounceIn {
                0% {
                    transform: scale(0.3);
                    opacity: 0;
                }
                50% {
                    transform: scale(1.05);
                }
                70% {
                    transform: scale(0.9);
                }
                100% {
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .celebration-title {
                font-size: 32px;
                font-weight: bold;
                color: white;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }

            .celebration-message {
                font-size: 18px;
                color: white;
                margin-bottom: 30px;
                opacity: 0.9;
            }

            .fireworks-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .firework {
                position: absolute;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                animation: fireworkExplosion 2s ease-out forwards;
            }

            @keyframes fireworkExplosion {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1);
                    opacity: 1;
                }
                100% {
                    transform: scale(0);
                    opacity: 0;
                }
            }

            .celebration-close-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid white;
                color: white;
                padding: 12px 24px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                margin-top: 20px;
            }

            .celebration-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            /* 花火の追加エフェクト */
            .firework::before,
            .firework::after {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: inherit;
                animation: fireworkSparkle 2s ease-out forwards;
            }

            .firework::before {
                animation-delay: 0.1s;
            }

            .firework::after {
                animation-delay: 0.2s;
            }

            @keyframes fireworkSparkle {
                0% {
                    transform: scale(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: scale(2) rotate(360deg);
                    opacity: 0;
                }
            }

            /* パーティクル効果 */
            .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                animation: particleExplosion 1.5s ease-out forwards;
            }

            @keyframes particleExplosion {
                0% {
                    transform: scale(0) translateX(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1) translateX(50px);
                    opacity: 1;
                }
                100% {
                    transform: scale(0) translateX(100px);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                animation: glowPulse 3s ease-in-out infinite;
            }

            @keyframes glowPulse {
                0%, 100% { opacity: 0.3; }
                50% { opacity: 0.8; }
            }

            /* 統計表示スタイル */
            .celebration-stats {
                display: flex;
                justify-content: space-around;
                margin: 20px 0;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            .stat-number {
                display: block;
                font-size: 24px;
                font-weight: bold;
                color: white;
                margin-bottom: 5px;
            }

            .stat-label {
                display: block;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.8);
            }

            /* 紙吹雪エフェクト */
            .confetti-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
            }

            .confetti {
                position: absolute;
                top: -10px;
                border-radius: 2px;
                animation: confettiFall 3s linear forwards;
            }

            @keyframes confettiFall {
                0% {
                    transform: translateY(-10px) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 2s ease-in-out infinite;
            }

            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* 完了演出スタイル */
            .celebration-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                animation: fadeIn 0.5s ease-in;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .celebration-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                animation: bounceIn 0.8s ease-out;
                position: relative;
                overflow: hidden;
            }

            @keyframes bounceIn {
                0% {
                    transform: scale(0.3);
                    opacity: 0;
                }
                50% {
                    transform: scale(1.05);
                }
                70% {
                    transform: scale(0.9);
                }
                100% {
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .celebration-title {
                font-size: 32px;
                font-weight: bold;
                color: white;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }

            .celebration-message {
                font-size: 18px;
                color: white;
                margin-bottom: 30px;
                opacity: 0.9;
            }

            .fireworks-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .firework {
                position: absolute;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                animation: fireworkExplosion 2s ease-out forwards;
            }

            @keyframes fireworkExplosion {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1);
                    opacity: 1;
                }
                100% {
                    transform: scale(0);
                    opacity: 0;
                }
            }

            .celebration-close-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid white;
                color: white;
                padding: 12px 24px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                margin-top: 20px;
            }

            .celebration-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            /* 花火の追加エフェクト */
            .firework::before,
            .firework::after {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: inherit;
                animation: fireworkSparkle 2s ease-out forwards;
            }

            .firework::before {
                animation-delay: 0.1s;
            }

            .firework::after {
                animation-delay: 0.2s;
            }

            @keyframes fireworkSparkle {
                0% {
                    transform: scale(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: scale(2) rotate(360deg);
                    opacity: 0;
                }
            }

            /* パーティクル効果 */
            .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                animation: particleExplosion 1.5s ease-out forwards;
            }

            @keyframes particleExplosion {
                0% {
                    transform: scale(0) translateX(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1) translateX(50px);
                    opacity: 1;
                }
                100% {
                    transform: scale(0) translateX(100px);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                animation: glowPulse 3s ease-in-out infinite;
            }

            @keyframes glowPulse {
                0%, 100% { opacity: 0.3; }
                50% { opacity: 0.8; }
            }

            /* 統計表示スタイル */
            .celebration-stats {
                display: flex;
                justify-content: space-around;
                margin: 20px 0;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            .stat-number {
                display: block;
                font-size: 24px;
                font-weight: bold;
                color: white;
                margin-bottom: 5px;
            }

            .stat-label {
                display: block;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.8);
            }

            /* 紙吹雪エフェクト */
            .confetti-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
            }

            .confetti {
                position: absolute;
                top: -10px;
                border-radius: 2px;
                animation: confettiFall 3s linear forwards;
            }

            @keyframes confettiFall {
                0% {
                    transform: translateY(-10px) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 2s ease-in-out infinite;
            }

            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* 完了演出スタイル */
            .celebration-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                animation: fadeIn 0.5s ease-in;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .celebration-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                animation: bounceIn 0.8s ease-out;
                position: relative;
                overflow: hidden;
            }

            @keyframes bounceIn {
                0% {
                    transform: scale(0.3);
                    opacity: 0;
                }
                50% {
                    transform: scale(1.05);
                }
                70% {
                    transform: scale(0.9);
                }
                100% {
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .celebration-title {
                font-size: 32px;
                font-weight: bold;
                color: white;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }

            .celebration-message {
                font-size: 18px;
                color: white;
                margin-bottom: 30px;
                opacity: 0.9;
            }

            .fireworks-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .firework {
                position: absolute;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                animation: fireworkExplosion 2s ease-out forwards;
            }

            @keyframes fireworkExplosion {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1);
                    opacity: 1;
                }
                100% {
                    transform: scale(0);
                    opacity: 0;
                }
            }

            .celebration-close-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid white;
                color: white;
                padding: 12px 24px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                margin-top: 20px;
            }

            .celebration-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            /* 花火の追加エフェクト */
            .firework::before,
            .firework::after {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: inherit;
                animation: fireworkSparkle 2s ease-out forwards;
            }

            .firework::before {
                animation-delay: 0.1s;
            }

            .firework::after {
                animation-delay: 0.2s;
            }

            @keyframes fireworkSparkle {
                0% {
                    transform: scale(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: scale(2) rotate(360deg);
                    opacity: 0;
                }
            }

            /* パーティクル効果 */
            .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                animation: particleExplosion 1.5s ease-out forwards;
            }

            @keyframes particleExplosion {
                0% {
                    transform: scale(0) translateX(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1) translateX(50px);
                    opacity: 1;
                }
                100% {
                    transform: scale(0) translateX(100px);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                animation: glowPulse 3s ease-in-out infinite;
            }

            @keyframes glowPulse {
                0%, 100% { opacity: 0.3; }
                50% { opacity: 0.8; }
            }

            /* 統計表示スタイル */
            .celebration-stats {
                display: flex;
                justify-content: space-around;
                margin: 20px 0;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            .stat-number {
                display: block;
                font-size: 24px;
                font-weight: bold;
                color: white;
                margin-bottom: 5px;
            }

            .stat-label {
                display: block;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.8);
            }

            /* 紙吹雪エフェクト */
            .confetti-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
            }

            .confetti {
                position: absolute;
                top: -10px;
                border-radius: 2px;
                animation: confettiFall 3s linear forwards;
            }

            @keyframes confettiFall {
                0% {
                    transform: translateY(-10px) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 2s ease-in-out infinite;
            }

            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* 完了演出スタイル */
            .celebration-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                animation: fadeIn 0.5s ease-in;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .celebration-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                animation: bounceIn 0.8s ease-out;
                position: relative;
                overflow: hidden;
            }

            @keyframes bounceIn {
                0% {
                    transform: scale(0.3);
                    opacity: 0;
                }
                50% {
                    transform: scale(1.05);
                }
                70% {
                    transform: scale(0.9);
                }
                100% {
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .celebration-title {
                font-size: 32px;
                font-weight: bold;
                color: white;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }

            .celebration-message {
                font-size: 18px;
                color: white;
                margin-bottom: 30px;
                opacity: 0.9;
            }

            .fireworks-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .firework {
                position: absolute;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                animation: fireworkExplosion 2s ease-out forwards;
            }

            @keyframes fireworkExplosion {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1);
                    opacity: 1;
                }
                100% {
                    transform: scale(0);
                    opacity: 0;
                }
            }

            .celebration-close-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid white;
                color: white;
                padding: 12px 24px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                margin-top: 20px;
            }

            .celebration-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            /* 花火の追加エフェクト */
            .firework::before,
            .firework::after {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: inherit;
                animation: fireworkSparkle 2s ease-out forwards;
            }

            .firework::before {
                animation-delay: 0.1s;
            }

            .firework::after {
                animation-delay: 0.2s;
            }

            @keyframes fireworkSparkle {
                0% {
                    transform: scale(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: scale(2) rotate(360deg);
                    opacity: 0;
                }
            }

            /* パーティクル効果 */
            .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                animation: particleExplosion 1.5s ease-out forwards;
            }

            @keyframes particleExplosion {
                0% {
                    transform: scale(0) translateX(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1) translateX(50px);
                    opacity: 1;
                }
                100% {
                    transform: scale(0) translateX(100px);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                animation: glowPulse 3s ease-in-out infinite;
            }

            @keyframes glowPulse {
                0%, 100% { opacity: 0.3; }
                50% { opacity: 0.8; }
            }

            /* 統計表示スタイル */
            .celebration-stats {
                display: flex;
                justify-content: space-around;
                margin: 20px 0;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            .stat-number {
                display: block;
                font-size: 24px;
                font-weight: bold;
                color: white;
                margin-bottom: 5px;
            }

            .stat-label {
                display: block;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.8);
            }

            /* 紙吹雪エフェクト */
            .confetti-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
            }

            .confetti {
                position: absolute;
                top: -10px;
                border-radius: 2px;
                animation: confettiFall 3s linear forwards;
            }

            @keyframes confettiFall {
                0% {
                    transform: translateY(-10px) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 2s ease-in-out infinite;
            }

            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* 完了演出スタイル */
            .celebration-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 2000;
                animation: fadeIn 0.5s ease-in;
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .celebration-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border-radius: 20px;
                padding: 40px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
                animation: bounceIn 0.8s ease-out;
                position: relative;
                overflow: hidden;
            }

            @keyframes bounceIn {
                0% {
                    transform: scale(0.3);
                    opacity: 0;
                }
                50% {
                    transform: scale(1.05);
                }
                70% {
                    transform: scale(0.9);
                }
                100% {
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .celebration-title {
                font-size: 32px;
                font-weight: bold;
                color: white;
                margin-bottom: 20px;
                text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
                animation: pulse 2s infinite;
            }

            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }

            .celebration-message {
                font-size: 18px;
                color: white;
                margin-bottom: 30px;
                opacity: 0.9;
            }

            .fireworks-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .firework {
                position: absolute;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                animation: fireworkExplosion 2s ease-out forwards;
            }

            @keyframes fireworkExplosion {
                0% {
                    transform: scale(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1);
                    opacity: 1;
                }
                100% {
                    transform: scale(0);
                    opacity: 0;
                }
            }

            .celebration-close-btn {
                background: rgba(255, 255, 255, 0.2);
                border: 2px solid white;
                color: white;
                padding: 12px 24px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                margin-top: 20px;
            }

            .celebration-close-btn:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.05);
            }

            /* 花火の追加エフェクト */
            .firework::before,
            .firework::after {
                content: '';
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                background: inherit;
                animation: fireworkSparkle 2s ease-out forwards;
            }

            .firework::before {
                animation-delay: 0.1s;
            }

            .firework::after {
                animation-delay: 0.2s;
            }

            @keyframes fireworkSparkle {
                0% {
                    transform: scale(0) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: scale(2) rotate(360deg);
                    opacity: 0;
                }
            }

            /* パーティクル効果 */
            .particle {
                position: absolute;
                width: 4px;
                height: 4px;
                border-radius: 50%;
                animation: particleExplosion 1.5s ease-out forwards;
            }

            @keyframes particleExplosion {
                0% {
                    transform: scale(0) translateX(0);
                    opacity: 1;
                }
                50% {
                    transform: scale(1) translateX(50px);
                    opacity: 1;
                }
                100% {
                    transform: scale(0) translateX(100px);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                animation: glowPulse 3s ease-in-out infinite;
            }

            @keyframes glowPulse {
                0%, 100% { opacity: 0.3; }
                50% { opacity: 0.8; }
            }

            /* 統計表示スタイル */
            .celebration-stats {
                display: flex;
                justify-content: space-around;
                margin: 20px 0;
                gap: 20px;
            }

            .stat-item {
                text-align: center;
                background: rgba(255, 255, 255, 0.1);
                padding: 15px;
                border-radius: 10px;
                backdrop-filter: blur(10px);
            }

            .stat-number {
                display: block;
                font-size: 24px;
                font-weight: bold;
                color: white;
                margin-bottom: 5px;
            }

            .stat-label {
                display: block;
                font-size: 14px;
                color: rgba(255, 255, 255, 0.8);
            }

            /* 紙吹雪エフェクト */
            .confetti-container {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                overflow: hidden;
            }

            .confetti {
                position: absolute;
                top: -10px;
                border-radius: 2px;
                animation: confettiFall 3s linear forwards;
            }

            @keyframes confettiFall {
                0% {
                    transform: translateY(-10px) rotate(0deg);
                    opacity: 1;
                }
                100% {
                    transform: translateY(100vh) rotate(720deg);
                    opacity: 0;
                }
            }

            /* 追加の演出効果 */
            .celebration-content::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 2s ease-in-out infinite;
            }

            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }

            /* チェックボックススタイル */
            .form-checkbox {
                margin-left: 10px;
                width: 16px;
                height: 16px;
                accent-color: var(--interactive-accent);
            }

            .form-checkbox:checked {
                background-color: var(--interactive-accent);
                border-color: var(--interactive-accent);
            }

            /* ラジオボタングループスタイル */
            .radio-group {
                display: flex;
                gap: 20px;
                margin-top: 8px;
            }

            .radio-group input[type="radio"] {
                margin-right: 8px;
                accent-color: var(--interactive-accent);
            }

            .radio-group label {
                display: flex;
                align-items: center;
                cursor: pointer;
                font-size: 14px;
                color: var(--text-normal);
            }

            /* セレクトボックススタイル */
            .form-input[type="time"],
            .form-input[type="select"] {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .form-input[type="time"]:focus,
            .form-input[type="select"]:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            /* 設定ボタンスタイル */
            .settings-task-button {
                font-size: 15px;
                border: none;
                background: none;
                cursor: pointer;
                color: var(--text-muted);
                padding: 2px;
                margin-right: 10px;
                border-radius: 4px;
                transition: all 0.2s ease;
                opacity: 0.6;
                width: 100%;
                text-align: center;
            }
            
            .settings-task-button:hover {
                opacity: 1;
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            /* ツールチップスタイル */
            .task-settings-tooltip {
                background: var(--background-primary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                padding: 4px 0;
                min-width: 140px;
                font-size: 13px;
                z-index: 1000;
            }
            
            .tooltip-header {
                display: flex;
                justify-content: flex-end;
                padding: 4px 8px 0 8px;
                margin-bottom: 4px;
            }
            
            .tooltip-close-button {
                background: none;
                border: none;
                font-size: 16px;
                color: var(--text-muted);
                cursor: pointer;
                padding: 0;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                transition: all 0.2s ease;
            }
            
            .tooltip-close-button:hover {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .tooltip-item {
                padding: 8px 12px;
                cursor: pointer;
                transition: background-color 0.2s ease;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .tooltip-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.delete-item {
                color: #e74c3c;
            }
            
            .tooltip-item.delete-item:hover {
                background: rgba(231, 76, 60, 0.1);
            }
            
            .tooltip-item.project-item {
                color: var(--text-normal);
            }
            
            .tooltip-item.project-item:hover {
                background: var(--background-secondary);
            }
            
            .tooltip-item.disabled {
                opacity: 0.5;
                color: var(--text-muted);
                cursor: not-allowed;
            }
            
            .tooltip-item.disabled:hover {
                background: none;
            }
            
            .date-nav-container {
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 8px;
                gap: 2px;
                height: 36px;
            }
            
            .date-nav-container.compact {
                flex: 1; /* Take remaining space in top-bar-container */
                margin-bottom: 0; /* Remove bottom margin */
                gap: 1px;
                height: 100%; /* Match parent height */
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .date-nav-arrow {
                background: none;
                border: none;
                font-size: 28px;
                color: #888;
                cursor: pointer;
                padding: 0 8px;
                transition: color 0.2s;
            }
            
            .date-nav-container.compact .date-nav-arrow {
                font-size: 20px;
                padding: 0 4px;
            }
            
            .date-nav-arrow:hover {
                color: #1976d2;
            }
            
            .date-nav-label {
                font-size: 15px;
                font-weight: bold;
                color: #1976d2;
                min-width: 90px;
                text-align: center;
                letter-spacing: 0.5px;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 28px;
                margin-right: 3px;
            }
            
            .date-nav-container.compact .date-nav-label {
                font-size: 15px;
                min-width: 90px;
                letter-spacing: 0.5px;
                height: 24px;
            }
            .calendar-btn {
                background: none;
                border: none;
                font-size: 16px;
                padding: 2px 2px;
                margin: 0 1px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 24px;
                width: 24px;
                border-radius: 6px;
                transition: background 0.2s;
            }
            .calendar-btn:hover {
                background: var(--background-modifier-border);
            }
            .date-wikilink {
                color: #1976d2 !important;
                font-weight: bold;
                text-decoration: none;
                display: inline-block;
                text-align: center;
                min-width: 60px;
                padding: 0 1px;
            }

            /* タスク完了コメントモーダルのスタイル */
            .completion-modal {
                max-width: 500px;
                max-height: 80vh;
                overflow-y: auto;
            }

            .completion-form {
                display: flex;
                flex-direction: column;
                gap: 16px;
            }

            .completion-time-info {
                background: var(--background-secondary);
                padding: 12px;
                border-radius: 6px;
                border: 1px solid var(--background-modifier-border);
            }

            .completion-time-info p {
                margin: 4px 0;
                font-size: 14px;
                color: var(--text-normal);
            }

            .completion-rating-section {
                background: var(--background-secondary);
                padding: 16px;
                border-radius: 6px;
                border: 1px solid var(--background-modifier-border);
            }

            .completion-rating-section h4 {
                margin: 0 0 16px 0;
                font-size: 16px;
                color: var(--text-normal);
            }

            .rating-group {
                margin-bottom: 16px;
            }

            .rating-label {
                display: block;
                margin-bottom: 8px;
                font-size: 14px;
                font-weight: 500;
                color: var(--text-normal);
            }

            .star-rating {
                display: flex;
                gap: 4px;
                margin-bottom: 8px;
            }

            .star-rating .star {
                font-size: 20px;
                cursor: pointer;
                transition: all 0.2s ease;
                user-select: none;
                opacity: 0.3;
            }

            .star-rating .star:hover {
                transform: scale(1.2);
            }

            .energy-select {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                box-sizing: border-box;
            }

            .energy-select:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }
            
            .completion-comment {
                width: 100%;
                min-height: 100px;
                padding: 12px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                background: var(--background-primary);
                color: var(--text-normal);
                font-family: inherit;
                font-size: 14px;
                resize: vertical;
                box-sizing: border-box;
            }

            /* 入力時のテキスト色を明るくする */
            .completion-comment:not(:placeholder-shown) {
                color: rgba(255, 255, 255, 0.9);
            }

            .completion-comment:focus {
                outline: none;
                border-color: var(--interactive-accent);
                box-shadow: 0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2);
            }

            .completion-comment::placeholder {
                color: var(--text-faint);
                opacity: 0.6;
                font-style: italic;
            }

            .tag-selection {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 8px;
            }

            .tag-option {
                padding: 6px 12px;
                background: var(--background-modifier-border);
                color: var(--text-muted);
                border-radius: 16px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s ease;
                user-select: none;
            }

            .tag-option:hover {
                background: var(--background-modifier-border-hover);
                color: var(--text-normal);
            }

            .tag-option.selected {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }

            .form-button-group {
                display: flex;
                gap: 12px;
                justify-content: flex-end;
                margin-top: 8px;
            }

            .form-button {
                padding: 10px 20px;
                border: none;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                min-width: 80px;
            }

            .form-button.primary {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
            }

            .form-button.primary:hover {
                background: var(--interactive-accent-hover);
            }

            .form-button.secondary {
                background: var(--background-modifier-border);
                color: var(--text-normal);
            }
            
            .form-button.secondary:hover {
                background: var(--background-modifier-border-hover);
            }
            
            /* レスポンシブ対応 - コンテナベースの調整 */
            /* 中間の幅（800px以下相当） */
            .taskchute-narrow .task-item {
                /* グリッドレイアウトを調整 - プロジェクトと時間を縮小 */
                grid-template-columns: 20px 40px minmax(150px, 1fr) 120px 80px 40px 30px 30px 30px;
                gap: 4px;
            }
            
            .taskchute-narrow .task-name {
                min-width: 150px;
            }
            
            .taskchute-narrow .taskchute-project-display {
                max-width: 120px;
                margin-right: 4px;
            }
            
            .taskchute-narrow .taskchute-project-name {
                max-width: 100px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            
            .taskchute-narrow .task-time-range {
                font-size: 11px;
            }
            
            .taskchute-narrow .routine-button,
            .taskchute-narrow .comment-button {
                font-size: 13px;
            }
            
            /* さらに狭い幅（600px以下相当） */
            .taskchute-very-narrow .task-item {
                /* タスク名を最優先にし、必要なボタンのみ表示 */
                grid-template-columns: 20px 40px 1fr 30px 30px;
                gap: 2px;
            }
            
            /* 表示する要素を限定 */
            .taskchute-very-narrow .task-item > *:nth-child(n+6) {
                display: none;
            }
            
            /* プロジェクト、時間表示、実行時間を非表示 */
            .taskchute-very-narrow .taskchute-project-display,
            .taskchute-very-narrow .task-time-range,
            .taskchute-very-narrow .task-duration {
                display: none;
            }
            
            /* タスク名を最大限表示 */
            .taskchute-very-narrow .task-name {
                min-width: 80px;
            }
            
            /* ルーチンボタンと設定ボタンのみ表示 */
            .taskchute-very-narrow .task-item > *:nth-child(7),  /* ルーチンボタン */
            .taskchute-very-narrow .task-item > *:nth-child(9) {  /* 設定ボタン */
                display: flex;
            }
            
            /* ルーチン設定モーダルの新しいスタイル */
            .checkbox-group {
                display: flex;
                gap: 20px;
                margin-bottom: 10px;
            }
            
            .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                user-select: none;
            }
            
            .checkbox-label input[type="checkbox"] {
                cursor: pointer;
                margin: 0;
            }
            
            .weekday-checkboxes {
                display: flex;
                gap: 15px;
                flex-wrap: wrap;
                padding: 10px 0;
            }
            
            .weekday-checkbox-label {
                display: flex;
                align-items: center;
                gap: 5px;
                cursor: pointer;
                user-select: none;
                padding: 5px 10px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                transition: all 0.2s ease;
            }
            
            .weekday-checkbox-label:hover {
                background-color: var(--background-modifier-hover);
            }
            
            .weekday-checkbox-label input[type="checkbox"] {
                cursor: pointer;
                margin: 0;
            }
            
            .weekday-checkbox-label input[type="checkbox"]:checked + span {
                font-weight: bold;
                color: var(--text-accent);
            }
            
            /* 曜日選択グループ全体のスタイル */
            #edit-weekday-group {
                transition: all 0.3s ease;
                overflow: hidden;
            }
            
            #edit-weekday-group[style*="display: none"] {
                max-height: 0;
                opacity: 0;
            }
            
            #edit-weekday-group[style*="display: block"] {
                max-height: 200px;
                opacity: 1;
            }
            
            /* タスク名検証スタイル */
            .form-input.error {
                border-color: #e74c3c;
                background-color: #fee;
            }
            
            .task-name-warning {
                color: #e74c3c;
                font-size: 12px;
                margin-top: 4px;
                padding: 4px 8px;
                background-color: #fee;
                border-radius: 4px;
            }
            
            .task-name-warning.hidden {
                display: none;
            }
            
            .task-name-warning.highlight {
                animation: flash 0.3s ease-in-out;
            }
            
            @keyframes flash {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            
            .form-button.disabled {
                background-color: #ccc;
                cursor: not-allowed;
                opacity: 0.6;
            }
            
            /* Phase 1: 最下部へのドロップインジケーター */
            .task-item.dragover-bottom {
                border-bottom: 2px solid var(--interactive-accent);
                margin-bottom: -2px;
            }
            
            .task-list.dragover-bottom::after {
                content: '';
                display: block;
                height: 2px;
                background-color: var(--interactive-accent);
                margin-top: 4px;
            }
        `
    document.head.appendChild(style)
  }

  // YAMLフロントマターが無ければ自動で追加
  async ensureFrontMatter(file) {
    const content = await this.app.vault.read(file)
    if (!content.startsWith("---")) {
      const newContent = `---\nroutine: false\n---\n` + content
      await this.app.vault.modify(file, newContent)
    }
  }

  // 週1回ルーチン判定用ヘルパー関数
  isTargetWeekday(date, weekday) {
    return date.getDay() === weekday
  }

  // 週1回ルーチンの表示判定（カスタム複数曜日対応版）
  shouldShowWeeklyRoutine(task, currentDate) {
    // weeklyタイプの場合（後方互換性）
    if (task.routineType === "weekly") {
      if (task.weekday === undefined || task.weekday === null) return false
      return this.isTargetWeekday(currentDate, task.weekday)
    }

    // customタイプの場合（新形式）
    if (task.routineType === "custom") {
      // weekdays配列がある場合
      if (task.weekdays && Array.isArray(task.weekdays)) {
        const currentWeekday = currentDate.getDay()
        return task.weekdays.includes(currentWeekday)
      }
      // weekdays配列がないがweekdayがある場合（移行期の互換性）
      if (task.weekday !== undefined && task.weekday !== null) {
        return this.isTargetWeekday(currentDate, task.weekday)
      }
    }

    return false
  }

  // 曜日名を取得
  getWeekdayName(weekday) {
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"]
    return weekdays[weekday] || ""
  }

  // 曜日番号を取得
  getWeekdayNumber(weekdayName) {
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"]
    return weekdays.indexOf(weekdayName)
  }

  // ペインの幅に応じてレスポンシブクラスを適用
  applyResponsiveClasses() {
    const container = this.containerEl
    if (!container) return

    // コンテナの実際の幅を取得
    const width = container.offsetWidth

    // 既存のレスポンシブクラスを削除
    container.classList.remove('taskchute-narrow', 'taskchute-very-narrow')

    // 幅に応じてクラスを追加
    if (width <= 600) {
      container.classList.add('taskchute-very-narrow')
    } else if (width <= 800) {
      container.classList.add('taskchute-narrow')
    }
  }

  // リサイズ監視の設定
  setupResizeObserver() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.applyResponsiveClasses()
    })

    if (this.containerEl) {
      this.resizeObserver.observe(this.containerEl)
    }
  }

  // タスク設定ツールチップを表示
  showTaskSettingsTooltip(inst, button) {
    // 既存のツールチップを削除
    const existingTooltip = document.querySelector(".task-settings-tooltip")
    if (existingTooltip) {
      existingTooltip.remove()
    }

    // ツールチップコンテナを作成
    const tooltip = document.createElement("div")
    tooltip.className = "task-settings-tooltip"

    // ヘッダー部分（バツボタン用）
    const tooltipHeader = tooltip.createEl("div", {
      cls: "tooltip-header",
    })

    // バツボタンを追加
    const closeButton = tooltipHeader.createEl("button", {
      cls: "tooltip-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })
    closeButton.addEventListener("click", (e) => {
      e.stopPropagation()
      tooltip.remove()
    })


    // 「未実行に戻す」項目を追加
    const resetItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: "↩️ 未実行に戻す",
    })
    if (inst.state === "idle") {
      resetItem.classList.add("disabled")
      resetItem.setAttribute("title", "このタスクは未実行です")
    } else {
      resetItem.setAttribute("title", "タスクを実行前の状態に戻します")
    }
    resetItem.addEventListener("click", async (e) => {
      e.stopPropagation()
      tooltip.remove()
      if (inst.state !== "idle") {
        await this.resetTaskToIdle(inst)
      }
    })

    // 「タスクを移動」項目を追加
    const moveItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: "📅 タスクを移動",
    })
    moveItem.setAttribute("title", "タスクを別の日付に移動します")
    moveItem.addEventListener("click", (e) => {
      e.stopPropagation()
      tooltip.remove()
      this.showTaskMoveDatePicker(inst, button)
    })

    // 「タスクを複製」項目を追加
    const duplicateItem = tooltip.createEl("div", {
      cls: "tooltip-item",
      text: "📄 タスクを複製",
    })
    duplicateItem.setAttribute("title", "同じタスクをすぐ下に追加します")
    duplicateItem.addEventListener("click", (e) => {
      e.stopPropagation()
      tooltip.remove()
      this.duplicateInstance(inst)
    })

    // 削除項目を追加
    const deleteItem = tooltip.createEl("div", {
      cls: "tooltip-item delete-item",
      text: "🗑️ タスクを削除",
    })
    deleteItem.addEventListener("click", async (e) => {
      e.stopPropagation()
      tooltip.remove()
      
      // 統一された削除処理を使用
      if (inst.task.isRoutine) {
        await this.deleteRoutineTask(inst)
      } else {
        await this.deleteNonRoutineTask(inst)
      }
    })

    // ボタンの位置を取得してツールチップを配置
    const buttonRect = button.getBoundingClientRect()
    const windowHeight = window.innerHeight
    const tooltipHeight = 200 // 推定されるツールチップの高さ

    tooltip.style.position = "absolute"
    tooltip.style.zIndex = "1000"

    // 画面下部に近い場合は上向きに表示
    if (buttonRect.bottom + tooltipHeight > windowHeight) {
      tooltip.style.top = `${buttonRect.top - tooltipHeight + 10}px`
    } else {
      tooltip.style.top = `${buttonRect.top - 5}px`
    }

    // 左右の位置も画面端を考慮
    const tooltipWidth = 140 // ツールチップの幅
    if (buttonRect.left - tooltipWidth < 0) {
      // 左端に近い場合は右側に表示
      tooltip.style.left = `${buttonRect.right + 10}px`
    } else {
      tooltip.style.left = `${buttonRect.left - tooltipWidth}px`
    }

    // ドキュメントに追加
    document.body.appendChild(tooltip)

    // 外部クリックでツールチップを閉じる
    const closeTooltip = (e) => {
      if (!tooltip.contains(e.target) && e.target !== button) {
        tooltip.remove()
        document.removeEventListener("click", closeTooltip)
      }
    }

    // 少し遅延してからイベントリスナーを追加（即座に閉じるのを防ぐ）
    setTimeout(() => {
      document.addEventListener("click", closeTooltip)
    }, 100)
  }

  // プロジェクト設定モーダルを表示
  async showProjectSettingsModal(inst, tooltip) {
    // 既存のツールチップを削除
    if (tooltip) {
      tooltip.remove()
    }

    // モーダルコンテナ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", {
      text: `「${inst.task.title}」のプロジェクト設定`,
    })

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // プロジェクト一覧を取得
    const projectFiles = await this.getProjectFiles()

    if (projectFiles.length === 0) {
      // プロジェクトファイルがない場合
      const noProjectGroup = form.createEl("div", { cls: "form-group" })
      noProjectGroup.createEl("p", {
        text: "プロジェクトファイルが見つかりません。",
        cls: "form-description",
      })
      noProjectGroup.createEl("p", {
        text: "プロジェクトファイルに #project タグを追加してください。",
        cls: "form-description",
      })
    } else {
      // プロジェクト選択
      const projectGroup = form.createEl("div", { cls: "form-group" })
      projectGroup.createEl("label", {
        text: "プロジェクトを選択:",
        cls: "form-label",
      })

      const projectSelect = projectGroup.createEl("select", {
        cls: "form-input",
      })

      // プロジェクトが設定されている場合のみ「プロジェクトを外す」オプションを追加
      if (inst.task.projectPath) {
        const removeProjectOption = projectSelect.createEl("option", {
          value: "",
          text: "➖ プロジェクトを外す",
        })
      } else {
        // 未設定の場合は空のオプションを追加
        const emptyOption = projectSelect.createEl("option", {
          value: "",
          text: "",
        })
        emptyOption.selected = true
      }

      // プロジェクト一覧を追加
      projectFiles.forEach((project) => {
        const option = projectSelect.createEl("option", {
          value: project.path,
          text: project.basename,
        })

        // 現在のプロジェクトが設定されている場合は選択
        if (inst.task.projectPath === project.path) {
          option.selected = true
        }
      })

      // 説明
      const descGroup = form.createEl("div", { cls: "form-group" })
      descGroup.createEl("p", {
        text: "選択したプロジェクトがタスクに紐づけられます。",
        cls: "form-description",
      })
    }

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    })
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    })

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    form.addEventListener("submit", async (e) => {
      e.preventDefault()

      if (projectFiles.length > 0) {
        const projectSelect = form.querySelector("select")
        const selectedProjectPath = projectSelect.value

        await this.setProjectForTask(inst.task, selectedProjectPath)
      }

      document.body.removeChild(modal)
      this.renderTaskList()
    })

    // モーダルを表示
    document.body.appendChild(modal)
  }

  // プロジェクトを分割表示で開く
  async openProjectInSplit(projectPath) {
    try {
      const projectFile = this.app.vault.getAbstractFileByPath(projectPath)
      if (!projectFile) {
        new Notice("プロジェクトファイルが見つかりません")
        return
      }

      // 現在のTaskChuteViewのleafを保持
      const currentLeaf = this.leaf

      // 右側に分割してプロジェクトを開く
      const rightLeaf = this.app.workspace.splitActiveLeaf("vertical")
      await rightLeaf.openFile(projectFile)

      // TaskChuteViewをアクティブに保つ
      this.app.workspace.setActiveLeaf(currentLeaf)
    } catch (error) {
      console.error("プロジェクト分割表示エラー:", error)
      new Notice("プロジェクトの表示に失敗しました")
    }
  }

  // プロジェクトファイルを取得
  async getProjectFiles() {
    const files = this.app.vault.getMarkdownFiles()
    const projectFiles = []
    const projectFolderPath = this.plugin.pathManager.getProjectFolderPath()

    for (const file of files) {
      // プロジェクトフォルダ内の「Project - 」で始まるファイルを取得
      if (file.path.startsWith(projectFolderPath + '/') && file.basename.startsWith('Project - ')) {
        projectFiles.push(file)
        console.log(`[TaskChute] プロジェクトファイル発見: ${file.path}`)
        continue
      }
      
      // 互換性のため、「Project - 」で始まるファイルも他のフォルダから検索
      if (file.basename.startsWith('Project - ')) {
        projectFiles.push(file)
        console.log(`[TaskChute] プロジェクトファイル発見（Project - ）: ${file.path}`)
        continue
      }

      // 既存の #project タグによる判定も残す
      const content = await this.app.vault.read(file)
      let isProject = false

      // frontmatterのtagsをチェック
      const frontmatterMatch = content.match(/^---([\s\S]*?)---/)
      if (frontmatterMatch) {
        try {
          const yaml = frontmatterMatch[1]
          // tags: [project] または tags: project
          const tagsMatch = yaml.match(/tags:\s*(\[.*?\]|.+)/)
          if (tagsMatch) {
            let tags = tagsMatch[1].trim()
            if (tags.startsWith("[") && tags.endsWith("]")) {
              // 配列形式
              tags = tags
                .slice(1, -1)
                .split(",")
                .map((t) => t.replace(/['"]/g, "").trim())
            } else {
              // 単一 or スペース区切り
              tags = tags
                .split(/[,\s]+/)
                .map((t) => t.replace(/['"]/g, "").trim())
            }
            if (tags.includes("project")) {
              isProject = true
            }
          }
        } catch (e) {}
      }

      // 本文中の #project も後方互換でチェック
      if (!isProject) {
        const projectTagRegex = /(^|\s)#project(\s|$)/g
        if (projectTagRegex.test(content)) {
          isProject = true
        }
      }

      if (isProject && file.basename.startsWith('Project - ')) {
        projectFiles.push(file)
        console.log(`[TaskChute] プロジェクトファイル発見: ${file.basename}`)
      }
    }

    console.log(`[TaskChute] プロジェクトファイル数: ${projectFiles.length}`)
    return projectFiles
  }

  // タスクにプロジェクトを設定
  async setProjectForTask(task, projectPath) {
    try {
      await this.ensureFrontMatter(task.file)

      // メタデータを更新
      await this.app.fileManager.processFrontMatter(
        task.file,
        (frontmatter) => {
          if (projectPath) {
            // プロジェクトが選択された場合
            const projectFile =
              this.app.vault.getAbstractFileByPath(projectPath)
            if (projectFile) {
              frontmatter.project = `[[${projectFile.basename}]]`
              // frontmatter.project_path は保存しない
            }
          } else {
            // プロジェクトなしの場合
            delete frontmatter.project
            // frontmatter.project_path も削除（後方互換）
            delete frontmatter.project_path
          }
          return frontmatter
        },
      )

      // タスクオブジェクトを更新
      if (projectPath) {
        const projectFile = this.app.vault.getAbstractFileByPath(projectPath)
        if (projectFile) {
          task.projectPath = projectPath
          task.projectTitle = projectFile.basename
        }
      } else {
        task.projectPath = null
        task.projectTitle = null
      }

      new Notice(`プロジェクト設定を保存しました`)
    } catch (error) {
      console.error("プロジェクト設定に失敗しました:", error)
      new Notice("プロジェクト設定に失敗しました")
    }
  }

  // UI上のタイマーを一元管理して更新
  manageTimers() {
    if (this.globalTimerInterval) {
      clearInterval(this.globalTimerInterval)
    }

    const runningInstances = this.taskInstances
      .filter((inst) => inst.state === "running")
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime()) // 開始時間でソート

    if (runningInstances.length === 0) {
      // 実行中タスクがなければタイマーを停止
      clearInterval(this.globalTimerInterval)
      this.globalTimerInterval = null
      return
    }

    this.globalTimerInterval = setInterval(() => {
      // 実行中タスクのタイマー表示更新のみ（slotKeyは変更しない）
      const runningInstances = this.taskInstances.filter(
        (i) => i.state === "running",
      )

      // タスクリスト内のタイマー表示を更新
      runningInstances.forEach((runningInst) => {
        // タスクアイテムのタイマー表示を更新
        const taskItems = this.taskList.querySelectorAll(".task-item")
        taskItems.forEach((item) => {
          const taskName = item.querySelector(".task-name")
          if (taskName && taskName.textContent === runningInst.task.title) {
            const timerDisplay = item.querySelector(".task-timer-display")
            if (timerDisplay) {
              const elapsed = new Date() - runningInst.startTime
              const hours = Math.floor(elapsed / 3600000)
              const minutes = Math.floor((elapsed % 3600000) / 60000)
              const seconds = Math.floor((elapsed % 60000) / 1000)
              const timerStr = `${hours.toString().padStart(2, "0")}:${minutes
                .toString()
                .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
              timerDisplay.textContent = timerStr
            }
          }
        })
      })
    }, 1000)
  }

  // --- ▼ ここから追加: 時刻編集モーダルと更新処理 ---
  showTimeEditModal(inst) {
    // モーダルオーバーレイ
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // ヘッダー
    const header = modalContent.createEl("div", { cls: "modal-header" })
    header.createEl("h3", { text: `「${inst.task.title}」の時刻を編集` })
    const closeBtn = header.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })
    closeBtn.addEventListener("click", () => modal.remove())

    const form = modalContent.createEl("form", { cls: "task-form" })

    // 開始時刻入力
    const startGroup = form.createEl("div", { cls: "form-group" })
    startGroup.createEl("label", { text: "開始時刻:", cls: "form-label" })
    const startInput = startGroup.createEl("input", {
      type: "time",
      cls: "form-input",
      value: inst.startTime
        .toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
        .padStart(5, "0"),
    })

    // 開始時刻クリアボタン
    const startClearBtn = startGroup.createEl("button", {
      type: "button",
      cls: "form-button secondary",
      text: "クリア",
      style: "margin-left: 8px; padding: 4px 12px; font-size: 12px;",
    })
    startClearBtn.addEventListener("click", () => {
      startInput.value = ""
    })

    // 終了時刻入力（完了タスクの場合のみ表示）
    let stopInput = null
    let stopClearBtn = null
    if (inst.state === "done" && inst.stopTime) {
      const stopGroup = form.createEl("div", { cls: "form-group" })
      stopGroup.createEl("label", { text: "終了時刻:", cls: "form-label" })
      stopInput = stopGroup.createEl("input", {
        type: "time",
        cls: "form-input",
        value: inst.stopTime
          .toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
          .padStart(5, "0"),
      })

      // 終了時刻クリアボタン
      stopClearBtn = stopGroup.createEl("button", {
        type: "button",
        cls: "form-button secondary",
        text: "クリア",
        style: "margin-left: 8px; padding: 4px 12px; font-size: 12px;",
      })
      stopClearBtn.addEventListener("click", () => {
        stopInput.value = ""
      })
    }

    // 説明文を追加
    const descGroup = form.createEl("div", { cls: "form-group" })
    const descText = descGroup.createEl("p", {
      cls: "form-description",
      style: "margin-top: 12px; font-size: 12px; color: var(--text-muted);",
    })

    if (inst.state === "running") {
      descText.textContent =
        "開始時刻を削除すると、タスクは未実行状態に戻ります。"
    } else if (inst.state === "done") {
      descText.innerHTML =
        "終了時刻のみ削除：実行中に戻ります<br>両方削除：未実行に戻ります"
    }

    // ボタン
    const btnGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelBtn = btnGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    })
    const saveBtn = btnGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    })

    cancelBtn.addEventListener("click", () => modal.remove())

    form.addEventListener("submit", async (e) => {
      e.preventDefault()
      const newStart = startInput.value
      const newStop = stopInput ? stopInput.value : null

      // 状態遷移の判定
      if (inst.state === "running") {
        if (!newStart) {
          // 実行中タスクの開始時刻を削除 → 未実行に戻す
          await this.transitionToIdle(inst)
          modal.remove()
          return
        }
        // 開始時刻のみ更新
        await this.updateRunningInstanceStartTime(inst, newStart)
      } else if (inst.state === "done") {
        if (!newStart && !newStop) {
          // 両方削除 → 未実行に戻す
          await this.transitionToIdle(inst)
          modal.remove()
          return
        } else if (!newStop && newStart) {
          // 終了時刻のみ削除 → 実行中に戻す
          await this.transitionToRunning(inst, newStart)
          modal.remove()
          return
        } else if (newStart && newStop) {
          // 両方の時刻を更新
          if (newStart >= newStop) {
            new Notice("開始時刻は終了時刻より前である必要があります")
            return
          }
          await this.updateInstanceTimes(inst, newStart, newStop)
        } else {
          // 開始時刻のみ削除は無効
          new Notice("開始時刻は必須です")
          return
        }
      }

      modal.remove()
    })

    document.body.appendChild(modal)
    startInput.focus()
  }

  async updateInstanceTimes(inst, startStr, stopStr) {
    // 同日の日付オブジェクトを生成
    const baseDate = new Date(inst.startTime)
    const [sh, sm] = startStr.split(":").map(Number)
    const [eh, em] = stopStr.split(":").map(Number)

    const oldSlotKey = inst.slotKey

    inst.startTime = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      sh,
      sm,
      0,
    )
    inst.stopTime = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      eh,
      em,
      0,
    )

    // 新しい開始時刻に基づいてslotKeyを更新
    const newSlotKey = this.getSlotFromTime(startStr)
    if (newSlotKey !== oldSlotKey) {
      inst.slotKey = newSlotKey
      // localStorageも更新
      localStorage.setItem(`taskchute-slotkey-${inst.task.path}`, newSlotKey)
      console.log(
        `[TaskChute] 時刻変更により時間帯移動: "${inst.task.title}" ${oldSlotKey} → ${newSlotKey}`,
      )
    }

    try {
      // JSONファイルのデータを更新
      await this.saveTaskCompletion(inst, null)
    } catch (e) {
      console.error("時刻更新時のJSON保存に失敗:", e)
    }

    // UI 更新
    this.renderTaskList()
    new Notice(`「${inst.task.title}」の時刻を更新しました`)
  }

  async updateRunningInstanceStartTime(inst, startStr) {
    // 実行中タスクの開始時刻のみ更新
    const baseDate = new Date(inst.startTime)
    const [sh, sm] = startStr.split(":").map(Number)

    const oldSlotKey = inst.slotKey

    inst.startTime = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      sh,
      sm,
      0,
    )

    // 新しい開始時刻に基づいてslotKeyを更新
    const newSlotKey = this.getSlotFromTime(startStr)
    if (newSlotKey !== oldSlotKey) {
      inst.slotKey = newSlotKey
      // localStorageも更新
      localStorage.setItem(`taskchute-slotkey-${inst.task.path}`, newSlotKey)
      console.log(
        `[TaskChute] 実行中タスクの時刻変更により時間帯移動: "${inst.task.title}" ${oldSlotKey} → ${newSlotKey}`,
      )
    }

    // 実行中タスクの状態を保存（JSON更新）
    await this.saveRunningTasksState()

    // UI更新
    this.renderTaskList()
    new Notice(`「${inst.task.title}」の開始時刻を更新しました`)
  }

  // タスクを未実行状態に遷移
  async transitionToIdle(inst) {
    const originalState = inst.state

    // 状態をリセット
    inst.state = "idle"
    inst.startTime = null
    inst.stopTime = null

    if (originalState === "running") {
      // 実行中タスクリストから削除
      await this.saveRunningTasksState()
      this.manageTimers()
    } else if (originalState === "done") {
      // JSONログを更新（完了フラグをfalseに）
      try {
        await this.saveTaskCompletion(inst, { isCompleted: false })
      } catch (e) {
        console.error("タスク状態の更新に失敗:", e)
      }
    }

    this.renderTaskList()
    new Notice(`「${inst.task.title}」を未実行に戻しました`)
  }

  // 完了タスクを実行中状態に遷移
  async transitionToRunning(inst, startTimeStr) {
    if (inst.state !== "done") return

    // 開始時刻を設定（元の日付を保持）
    const baseDate = new Date(inst.startTime)
    const [sh, sm] = startTimeStr.split(":").map(Number)

    inst.state = "running"
    inst.startTime = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      sh,
      sm,
      0,
    )
    inst.stopTime = null

    // 実行中タスクとして保存
    await this.saveRunningTasksState()
    this.manageTimers()

    // JSONログを更新（完了フラグをfalseに）
    try {
      await this.saveTaskCompletion(inst, { isCompleted: false })
    } catch (e) {
      console.error("タスク状態の更新に失敗:", e)
    }

    this.renderTaskList()
    new Notice(`「${inst.task.title}」を実行中に戻しました`)
  }

  // タスクを移動する日付ピッカーを表示
  showTaskMoveDatePicker(inst, button) {
    // 日付入力要素を作成
    const input = document.createElement("input")
    input.type = "date"
    input.style.position = "absolute"
    input.style.zIndex = "1000"

    // 現在の日付を初期値として設定
    const currentYear = this.currentDate.getFullYear()
    const currentMonth = (this.currentDate.getMonth() + 1)
      .toString()
      .padStart(2, "0")
    const currentDay = this.currentDate.getDate().toString().padStart(2, "0")
    input.value = `${currentYear}-${currentMonth}-${currentDay}`

    // ボタンの位置に基づいて配置（歯車メニューと同じロジック）
    const rect = button.getBoundingClientRect()
    const windowHeight = window.innerHeight
    const inputHeight = 40 // 日付ピッカーの推定高さ

    // 画面下部に近い場合は上向きに表示
    if (rect.bottom + inputHeight > windowHeight) {
      input.style.top = `${rect.top - inputHeight}px`
    } else {
      input.style.top = `${rect.top}px`
    }

    // 左側に表示（歯車メニューと同じ位置）
    const inputWidth = 140 // 日付ピッカーの幅
    if (rect.left - inputWidth < 0) {
      // 左端に近い場合は右側に表示
      input.style.left = `${rect.right + 10}px`
    } else {
      input.style.left = `${rect.left - inputWidth}px`
    }

    // 日付選択時の処理
    input.addEventListener("change", async () => {
      if (input.value) {
        await this.moveTaskToDate(inst, input.value)
      }
      input.remove()
    })

    // フォーカスが外れたら削除
    input.addEventListener("blur", () => {
      setTimeout(() => input.remove(), 200)
    })

    // DOMに追加してフォーカス
    document.body.appendChild(input)

    // カレンダーを確実に開くための処理
    setTimeout(() => {
      try {
        input.focus()
        input.click()

        // clickイベントが効かない場合の代替手段
        // 一部のブラウザではshowPickerメソッドが使える
        if (input.showPicker && typeof input.showPicker === "function") {
          input.showPicker()
        } else {
          // mousedownイベントをシミュレート
          const mouseEvent = new MouseEvent("mousedown", {
            view: window,
            bubbles: true,
            cancelable: true,
          })
          input.dispatchEvent(mouseEvent)
        }
      } catch (e) {
        // エラーを無視（テスト環境など）
        console.log("Date picker auto-open failed:", e.message)
      }
    }, 50) // 少し遅延させて確実にDOMに追加された後に実行
  }

  // タスクを指定日付に移動
  async moveTaskToDate(inst, targetDate) {
    try {
      // ルーチンタスクの移動を防ぐ
      if (inst.task.isRoutine) {
        new Notice("ルーチンタスクは移動できません")
        return
      }

      // 実行中タスクの移動を防ぐ
      if (inst.state === "running") {
        new Notice("実行中のタスクは移動できません")
        return
      }

      // タスクファイルのメタデータを更新
      await this.updateTaskMetadata(inst.task.path, { target_date: targetDate })

      // タスクリストを再読み込み
      await this.loadTasks()

      // 成功通知
      new Notice(`「${inst.task.title}」を${targetDate}に移動しました`)
    } catch (error) {
      console.error("タスクの移動に失敗しました:", error)
      new Notice("タスクの移動に失敗しました")
    }
  }

  // タスクファイルのメタデータを更新
  async updateTaskMetadata(taskPath, metadata) {
    try {
      const file = this.app.vault.getAbstractFileByPath(taskPath)
      if (!file || !(file instanceof TFile)) {
        throw new Error("タスクファイルが見つかりません")
      }

      // ファイルの内容を読み込み
      let content = await this.app.vault.read(file)

      // frontmatterの存在をチェック
      const frontmatterRegex = /^---\n([\s\S]*?)\n---/
      const match = content.match(frontmatterRegex)

      if (match) {
        // 既存のfrontmatterを更新
        let frontmatter = match[1]

        // target_dateフィールドを更新または追加
        const targetDateRegex = /^target_date:\s*.*/m
        if (targetDateRegex.test(frontmatter)) {
          frontmatter = frontmatter.replace(
            targetDateRegex,
            `target_date: "${metadata.target_date}"`,
          )
        } else {
          frontmatter += `\ntarget_date: "${metadata.target_date}"`
        }

        // 更新されたfrontmatterでコンテンツを置換
        content = content.replace(frontmatterRegex, `---\n${frontmatter}\n---`)
      } else {
        // frontmatterがない場合は新規作成
        const newFrontmatter = `---\ntarget_date: "${metadata.target_date}"\n---\n`
        content = newFrontmatter + content
      }

      // ファイルを更新
      await this.app.vault.modify(file, content)
    } catch (error) {
      console.error("メタデータの更新に失敗しました:", error)
      throw error
    }
  }
}

function sortTaskInstances(taskInstances, timeSlotKeys) {
  // 時間帯ごとにグループ化
  const timeSlotGroups = {}
  timeSlotKeys.forEach((slot) => {
    timeSlotGroups[slot] = []
  })
  timeSlotGroups["none"] = []

  // インスタンスを時間帯ごとに分類
  taskInstances.forEach((inst) => {
    const slotKey = inst.slotKey || "none"
    if (timeSlotGroups[slotKey]) {
      timeSlotGroups[slotKey].push(inst)
    }
  })

  // 各時間帯グループ内でソート
  Object.keys(timeSlotGroups).forEach((slotKey) => {
    const instances = timeSlotGroups[slotKey]
    if (instances.length > 1) {
      // 状態優先でソート（完了済み・実行中が先、アイドルが後）
      instances.sort((a, b) => {
        // 1. 状態による優先順位
        const stateOrder = { done: 0, running: 1, idle: 2 }
        const stateA = stateOrder[a.state] ?? 3
        const stateB = stateOrder[b.state] ?? 3

        if (stateA !== stateB) {
          return stateA - stateB
        }

        // 2. 同じ状態内でのソート
        if (a.state === "done" || a.state === "running") {
          // 完了済み・実行中は時系列順
          const timeA = a.startTime ? a.startTime.getTime() : Infinity
          const timeB = b.startTime ? b.startTime.getTime() : Infinity
          return timeA - timeB
        }

        if (a.state === "idle") {
          // 手動配置タスクかどうかをチェック（フィールドが存在しない場合はfalse）
          const isManualA = a.manuallyPositioned === true
          const isManualB = b.manuallyPositioned === true

          // 両方が手動配置タスクの場合、元の順序を維持
          if (isManualA && isManualB) {
            return 0
          }

          // 片方だけが手動配置タスクの場合
          if (isManualA !== isManualB) {
            // 手動配置タスクは元の位置を保持（時刻順ソートから除外）
            // ただし、自動配置タスクとの相対位置は配列内の順序に従う
            return 0
          }

          // 両方が自動配置タスクの場合のみ時刻順でソート
          if (!isManualA && !isManualB) {
            const timeA = a.task.scheduledTime
            const timeB = b.task.scheduledTime
            if (!timeA && !timeB) return 0
            if (!timeA) return 1
            if (!timeB) return -1
            const [hourA, minuteA] = timeA.split(":").map(Number)
            const [hourB, minuteB] = timeB.split(":").map(Number)
            return hourA * 60 + minuteA - (hourB * 60 + minuteB)
          }

          return 0
        }

        // その他の場合は元の順序を維持
        return 0
      })

      timeSlotGroups[slotKey] = instances
    }
  })

  // ソート結果をtaskInstancesに反映
  let sortedInstances = []
  // 意図した順序でグループを結合する
  const slotOrder = ["none", ...timeSlotKeys]
  slotOrder.forEach((slotKey) => {
    if (timeSlotGroups[slotKey]) {
      sortedInstances.push(...timeSlotGroups[slotKey])
    }
  })
  return sortedInstances
}

// 新しいorderベースのソート関数（フェーズ2）
function sortTaskInstancesByOrder(taskInstances, timeSlotKeys) {
  console.log("[TaskChute] orderベースのソート関数を使用")

  // 時間帯ごとにグループ化
  const timeSlotGroups = {}
  timeSlotKeys.forEach((slot) => {
    timeSlotGroups[slot] = []
  })
  timeSlotGroups["none"] = []

  // インスタンスを時間帯ごとに分類
  taskInstances.forEach((inst) => {
    const slotKey = inst.slotKey || "none"
    if (timeSlotGroups[slotKey]) {
      timeSlotGroups[slotKey].push(inst)
    }
  })

  // 各時間帯グループ内でソート（超シンプル）
  Object.keys(timeSlotGroups).forEach((slotKey) => {
    const instances = timeSlotGroups[slotKey]
    if (instances.length > 1) {
      instances.sort((a, b) => {
        // 1. 状態優先: done → running → idle
        const stateOrder = { done: 0, running: 1, idle: 2 }
        if (a.state !== b.state) {
          return stateOrder[a.state] - stateOrder[b.state]
        }

        // 2. 同じ状態内では順序番号で並び替え
        const orderA = a.order ?? 999999
        const orderB = b.order ?? 999999
        return orderA - orderB
      })

      timeSlotGroups[slotKey] = instances
    }
  })

  // ソート結果をtaskInstancesに反映
  let sortedInstances = []
  const slotOrder = ["none", ...timeSlotKeys]
  slotOrder.forEach((slotKey) => {
    if (timeSlotGroups[slotKey]) {
      sortedInstances.push(...timeSlotGroups[slotKey])
    }
  })

  return sortedInstances
}

class TaskChutePlusPlugin extends Plugin {
  async onload() {
    console.log("TaskChute Plus Plugin loaded")

    // 設定を読み込み
    this.settings = (await this.loadData()) || {
      enableCelebration: true,
      enableSound: true,
      enableFireworks: true,
      enableConfetti: true,
      // パス設定
      taskFolderPath: "",
      projectFolderPath: "",
      logDataPath: ""
    }
    
    // PathManagerの初期化
    this.pathManager = new PathManager(this)
    
    // 初回起動時のフォルダ作成
    await this.ensureRequiredFolders()

    // 設定タブを追加（TaskChuteSettingTabが定義されている場合のみ）
    if (TaskChuteSettingTab) {
      this.addSettingTab(new TaskChuteSettingTab(this.app, this))
    }

    // ビュータイプを登録
    this.registerView(VIEW_TYPE_TASKCHUTE, (leaf) => new TaskChuteView(leaf, this))

    // リボンアイコンを追加
    this.addRibbonIcon("checkmark", "TaskChuteを開く", () => {
      this.activateTaskChuteView()
    })

    // コマンドを追加
    this.addCommand({
      id: "open-taskchute-view",
      name: "TaskChuteを開く",
      callback: () => {
        this.activateTaskChuteView()
      },
    })

    // 設定コマンドを追加
    this.addCommand({
      id: "taskchute-settings",
      name: "TaskChute設定",
      callback: () => {
        this.showSettingsModal()
      },
    })
    
    // Keyboard shortcut commands
    this.addCommand({
      id: "duplicate-selected-task",
      name: "選択されたタスクを複製",
      hotkeys: [{ modifiers: ["Ctrl"], key: "c" }],
      callback: () => {
        const view = this.getTaskChuteView()
        if (view && view.selectedTaskInstance) {
          view.duplicateInstance(view.selectedTaskInstance)
          view.clearTaskSelection()
        } else {
          new Notice("タスクが選択されていません")
        }
      },
    })
    
    this.addCommand({
      id: "delete-selected-task",
      name: "選択されたタスクを削除",
      hotkeys: [{ modifiers: ["Ctrl"], key: "d" }],
      callback: () => {
        const view = this.getTaskChuteView()
        if (view && view.selectedTaskInstance) {
          view.deleteSelectedTask()
        } else {
          new Notice("タスクが選択されていません")
        }
      },
    })
    
    this.addCommand({
      id: "reset-selected-task",
      name: "選択されたタスクを未実行に戻す",
      hotkeys: [{ modifiers: ["Ctrl"], key: "u" }],
      callback: () => {
        const view = this.getTaskChuteView()
        if (view && view.selectedTaskInstance) {
          if (view.selectedTaskInstance.state !== "idle") {
            view.resetTaskToIdle(view.selectedTaskInstance)
            view.clearTaskSelection()
          } else {
            new Notice("このタスクは既に未実行状態です")
          }
        } else {
          new Notice("タスクが選択されていません")
        }
      },
    })
    
    // 今日のタスクを表示するコマンド
    this.addCommand({
      id: 'show-today-tasks',
      name: '今日のタスクを表示',
      description: 'Show today\'s tasks',
      hotkeys: [{
        modifiers: ['Alt'],
        key: 't'
      }],
      callback: () => {
        this.showTodayTasks();
      }
    })

    // Obsidian起動時にTaskChuteビューを自動で開き、currentDateを今日にリセット
    this.app.workspace.onLayoutReady(async () => {
      // 既存のTaskChuteViewがあれば取得、なければ開く
      let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)[0]
      if (!leaf) {
        leaf = this.app.workspace.getRightLeaf(false)
        await leaf.setViewState({ type: VIEW_TYPE_TASKCHUTE, active: true })
      }
      // currentDateを今日にリセット
      if (leaf && leaf.view && leaf.view.currentDate) {
        const today = new Date()
        leaf.view.currentDate = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
        )
        if (leaf.view.updateDateLabel && leaf.view.taskList) {
          leaf.view.updateDateLabel(leaf.view.taskList)
        }
        if (leaf.view.loadTasks) {
          await leaf.view.loadTasks()
        }
      }
    })
  }

  async onunload() {
    console.log("TaskChute Plus Plugin unloaded")

    // 実行中タスクの状態を保存する処理を削除
    // 理由：onunloadでの非同期ファイル書き込みは信頼性が低く、
    // Obsidian終了前に処理が完了しないため。
    // 状態の保存はstartInstance/stopInstance時に同期的に行う方針に変更。
  }
  
  async ensureRequiredFolders() {
    try {
      await this.pathManager.ensureFolderExists(this.pathManager.getTaskFolderPath())
      await this.pathManager.ensureFolderExists(this.pathManager.getProjectFolderPath())
      await this.pathManager.ensureFolderExists(this.pathManager.getLogDataPath())
    } catch (error) {
      new Notice("必要なフォルダの作成に失敗しました")
    }
  }
  
  async saveSettings() {
    await this.saveData(this.settings)
  }
  
  getTaskChuteView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE)[0]
    if (leaf && leaf.view instanceof TaskChuteView) {
      return leaf.view
    }
    return null
  }

  async activateTaskChuteView() {
    const { workspace } = this.app

    // 既存のTaskChuteViewをすべて閉じる
    await workspace.detachLeavesOfType(VIEW_TYPE_TASKCHUTE)

    // メインペインの新規タブで開く
    const leaf = workspace.getLeaf(true)
    await leaf.setViewState({
      type: VIEW_TYPE_TASKCHUTE,
      active: true,
    })
    workspace.revealLeaf(leaf)
  }
  
  // 今日のタスクを表示
  async showTodayTasks() {
    try {
      // TaskChuteビューを取得または作成
      const leaf = await this.getOrCreateTaskChuteView();
      
      if (leaf && leaf.view && leaf.view.setSelectedDate) {
        // 今日の日付を設定
        const today = moment().format('YYYY-MM-DD');
        leaf.view.setSelectedDate(today);
        
        // ビューを更新
        if (leaf.view.refresh) {
          await leaf.view.refresh();
        }
        
        // ビューにフォーカスを移す
        this.app.workspace.revealLeaf(leaf);
      } else {
        console.error('TaskChuteView not found or setSelectedDate method missing');
        new Notice('TaskChuteビューの初期化に失敗しました');
      }
    } catch (error) {
      console.error('Failed to show today tasks:', error);
      new Notice('今日のタスクの表示に失敗しました');
    }
  }
  
  // TaskChuteビューを取得または作成するヘルパーメソッド
  async getOrCreateTaskChuteView() {
    // 既存のTaskChuteビューを探す
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASKCHUTE);
    
    if (leaves.length > 0) {
      // 既存のビューを使用
      return leaves[0];
    }
    
    // 新しいビューを作成
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_TASKCHUTE,
      active: true
    });
    
    return leaf;
  }

  // 設定モーダルを表示
  showSettingsModal() {
    const modal = document.createElement("div")
    modal.className = "task-modal-overlay"

    const modalContent = modal.createEl("div", { cls: "task-modal-content" })

    // モーダルヘッダー
    const modalHeader = modalContent.createEl("div", { cls: "modal-header" })
    modalHeader.createEl("h3", { text: "TaskChute設定" })

    // 閉じるボタン
    const closeButton = modalHeader.createEl("button", {
      cls: "modal-close-button",
      text: "×",
      attr: { title: "閉じる" },
    })

    // フォーム
    const form = modalContent.createEl("form", { cls: "task-form" })

    // 演出設定
    const celebrationGroup = form.createEl("div", { cls: "form-group" })
    celebrationGroup.createEl("label", {
      text: "完了演出を有効にする",
      cls: "form-label",
    })
    const celebrationCheckbox = celebrationGroup.createEl("input", {
      type: "checkbox",
      cls: "form-checkbox",
      checked: this.settings.enableCelebration,
    })

    // 音効果設定
    const soundGroup = form.createEl("div", { cls: "form-group" })
    soundGroup.createEl("label", {
      text: "音効果を有効にする",
      cls: "form-label",
    })
    const soundCheckbox = soundGroup.createEl("input", {
      type: "checkbox",
      cls: "form-checkbox",
      checked: this.settings.enableSound,
    })

    // 花火設定
    const fireworksGroup = form.createEl("div", { cls: "form-group" })
    fireworksGroup.createEl("label", {
      text: "花火エフェクトを有効にする",
      cls: "form-label",
    })
    const fireworksCheckbox = fireworksGroup.createEl("input", {
      type: "checkbox",
      cls: "form-checkbox",
      checked: this.settings.enableFireworks,
    })

    // 紙吹雪設定
    const confettiGroup = form.createEl("div", { cls: "form-group" })
    confettiGroup.createEl("label", {
      text: "紙吹雪エフェクトを有効にする",
      cls: "form-label",
    })
    const confettiCheckbox = confettiGroup.createEl("input", {
      type: "checkbox",
      cls: "form-checkbox",
      checked: this.settings.enableConfetti,
    })

    // ボタンエリア
    const buttonGroup = form.createEl("div", { cls: "form-button-group" })
    const cancelButton = buttonGroup.createEl("button", {
      type: "button",
      cls: "form-button cancel",
      text: "キャンセル",
    })
    const saveButton = buttonGroup.createEl("button", {
      type: "submit",
      cls: "form-button create",
      text: "保存",
    })

    // イベントリスナー
    closeButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    cancelButton.addEventListener("click", () => {
      document.body.removeChild(modal)
    })

    form.addEventListener("submit", async (e) => {
      e.preventDefault()

      // 設定を保存
      this.settings.enableCelebration = celebrationCheckbox.checked
      this.settings.enableSound = soundCheckbox.checked
      this.settings.enableFireworks = fireworksCheckbox.checked
      this.settings.enableConfetti = confettiCheckbox.checked

      await this.saveData(this.settings)
      new Notice("設定を保存しました")
      document.body.removeChild(modal)
    })

    // モーダルを表示
    document.body.appendChild(modal)
  }
}

// PluginSettingTabが存在する場合のみ定義
const TaskChuteSettingTab = PluginSettingTab ? class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this

    containerEl.empty()

    containerEl.createEl("h2", { text: "TaskChute Plus 設定" })
    containerEl.createEl("h3", { text: "完了エフェクト" })

    new Setting(containerEl)
      .setName("完了時のお祝いエフェクト")
      .setDesc("タスク完了時にお祝いのエフェクトを表示します")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableCelebration)
          .onChange(async (value) => {
            try {
              this.plugin.settings.enableCelebration = value
              await this.plugin.saveData(this.plugin.settings)
            } catch (error) {
              console.error("Failed to save enableCelebration setting:", error)
            }
          })
      )

    new Setting(containerEl)
      .setName("完了時のサウンド")
      .setDesc("タスク完了時に効果音を再生します")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSound)
          .onChange(async (value) => {
            try {
              this.plugin.settings.enableSound = value
              await this.plugin.saveData(this.plugin.settings)
            } catch (error) {
              console.error("Failed to save enableSound setting:", error)
            }
          })
      )

    new Setting(containerEl)
      .setName("花火エフェクト")
      .setDesc("お祝いエフェクト時に花火を表示します（お祝いエフェクトがオンの時のみ有効）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableFireworks)
          .onChange(async (value) => {
            try {
              this.plugin.settings.enableFireworks = value
              await this.plugin.saveData(this.plugin.settings)
            } catch (error) {
              console.error("Failed to save enableFireworks setting:", error)
            }
          })
      )

    new Setting(containerEl)
      .setName("紙吹雪エフェクト")
      .setDesc("お祝いエフェクト時に紙吹雪を表示します（お祝いエフェクトがオンの時のみ有効）")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableConfetti)
          .onChange(async (value) => {
            try {
              this.plugin.settings.enableConfetti = value
              await this.plugin.saveData(this.plugin.settings)
            } catch (error) {
              console.error("Failed to save enableConfetti setting:", error)
            }
          })
      )
    
    // パス設定セクション
    containerEl.createEl("h3", { text: "パス設定" })
    
    new Setting(containerEl)
      .setName("タスクフォルダパス")
      .setDesc("タスクファイルを保存するフォルダのパス")
      .addText(text => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.taskFolder)
          .setValue(this.plugin.settings.taskFolderPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value)
            if (validation.valid || value === "") {
              this.plugin.settings.taskFolderPath = value
              await this.plugin.saveSettings()
            } else {
              new Notice(validation.error)
              text.setValue(this.plugin.settings.taskFolderPath || "")
            }
          })
        
        // フォーカスが外れた時にフォルダを作成
        text.inputEl.addEventListener('blur', async () => {
          if (this.plugin.settings.taskFolderPath || !this.plugin.settings.taskFolderPath) {
            try {
              await this.plugin.pathManager.ensureFolderExists(
                this.plugin.pathManager.getTaskFolderPath()
              )
            } catch (error) {
              console.error("Failed to create task folder:", error)
            }
          }
        })
      })
    
    new Setting(containerEl)
      .setName("プロジェクトフォルダパス")
      .setDesc("プロジェクトファイルを保存するフォルダのパス")
      .addText(text => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.projectFolder)
          .setValue(this.plugin.settings.projectFolderPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value)
            if (validation.valid || value === "") {
              this.plugin.settings.projectFolderPath = value
              await this.plugin.saveSettings()
            } else {
              new Notice(validation.error)
              text.setValue(this.plugin.settings.projectFolderPath || "")
            }
          })
        
        // フォーカスが外れた時にフォルダを作成
        text.inputEl.addEventListener('blur', async () => {
          if (this.plugin.settings.projectFolderPath || !this.plugin.settings.projectFolderPath) {
            try {
              await this.plugin.pathManager.ensureFolderExists(
                this.plugin.pathManager.getProjectFolderPath()
              )
            } catch (error) {
              console.error("Failed to create project folder:", error)
            }
          }
        })
      })
    
    new Setting(containerEl)
      .setName("ログデータパス")
      .setDesc("タスクの実行ログを保存するフォルダのパス")
      .addText(text => {
        text
          .setPlaceholder(PathManager.DEFAULT_PATHS.logData)
          .setValue(this.plugin.settings.logDataPath || "")
          .onChange(async (value) => {
            const validation = this.plugin.pathManager.validatePath(value)
            if (validation.valid || value === "") {
              this.plugin.settings.logDataPath = value
              await this.plugin.saveSettings()
            } else {
              new Notice(validation.error)
              text.setValue(this.plugin.settings.logDataPath || "")
            }
          })
        
        // フォーカスが外れた時にフォルダを作成
        text.inputEl.addEventListener('blur', async () => {
          if (this.plugin.settings.logDataPath || !this.plugin.settings.logDataPath) {
            try {
              await this.plugin.pathManager.ensureFolderExists(
                this.plugin.pathManager.getLogDataPath()
              )
            } catch (error) {
              console.error("Failed to create log data folder:", error)
            }
          }
        })
      })
  }
} : null

module.exports = TaskChutePlusPlugin
module.exports.TaskChutePlugin = TaskChutePlusPlugin
module.exports.TaskChuteView = TaskChuteView
module.exports.sortTaskInstances = sortTaskInstances
module.exports.NavigationState = NavigationState
