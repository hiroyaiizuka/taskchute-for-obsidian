const TaskChutePlusPlugin = require("../main.js")
const NavigationState = TaskChutePlusPlugin.NavigationState

// Mock Obsidian
jest.mock("obsidian", () => ({
  Plugin: jest.fn(),
  ItemView: jest.fn(),
  WorkspaceLeaf: jest.fn(),
  TFile: jest.fn(),
  Notice: jest.fn(),
}))

describe("NavigationState", () => {
  it("should initialize with default values", () => {
    const state = new NavigationState()
    expect(state.isVisible).toBe(false)
    expect(state.activeSection).toBe(null)
  })

  it("should toggle visibility", () => {
    const state = new NavigationState()
    expect(state.isVisible).toBe(false)
    
    state.toggle()
    expect(state.isVisible).toBe(true)
    
    state.toggle()
    expect(state.isVisible).toBe(false)
  })

  it("should set active section", () => {
    const state = new NavigationState()
    
    state.setActiveSection("routine")
    expect(state.activeSection).toBe("routine")
    
    state.setActiveSection("review")
    expect(state.activeSection).toBe("review")
    
    state.setActiveSection("project")
    expect(state.activeSection).toBe("project")
  })
})

describe("Drawer Navigation Feature", () => {
  it("NavigationState class should be exported", () => {
    expect(NavigationState).toBeDefined()
    expect(typeof NavigationState).toBe("function")
  })
  
  it("should create NavigationState instance correctly", () => {
    const navigationState = new NavigationState()
    expect(navigationState).toBeInstanceOf(NavigationState)
    expect(navigationState.isVisible).toBe(false)
    expect(navigationState.activeSection).toBe(null)
  })
})

describe("Keyboard Shortcuts Feature", () => {
  let view
  let container
  let taskList
  
  beforeEach(() => {
    // Mock DOM elements
    container = document.createElement("div")
    taskList = document.createElement("div")
    taskList.className = "task-list"
    container.appendChild(taskList)
    document.body.appendChild(container)
    
    // querySelectorAllを削除してデフォルトの動作に任せる
    
    // activeElementのモック - 最初はbodyに設定
    let currentActiveElement = document.body
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get() {
        return currentActiveElement
      },
      set(element) {
        currentActiveElement = element
      }
    })
    
    // Create mock view
    view = {
      containerEl: { children: [null, container] },
      taskList: taskList,
      tasks: [],
      taskInstances: [],
      selectedTaskInstance: null,
      currentDate: new Date(),
      app: {
        workspace: {
          openLinkText: jest.fn()
        },
        vault: {
          getMarkdownFiles: jest.fn(() => []),
          read: jest.fn(),
          adapter: {
            exists: jest.fn(() => false)
          }
        },
        fileManager: {
          processFrontMatter: jest.fn()
        }
      },
      registerDomEvent: jest.fn(),
      registerEvent: jest.fn(),
      
      selectTaskForKeyboard: function(instance, element) {
        // Clear previous selection
        if (this.selectedElement) {
          this.selectedElement.className = this.selectedElement.className.replace(/\s*keyboard-selected/g, '')
        }
        this.selectedTaskInstance = instance
        this.selectedElement = element
        element.className = element.className.trim() + " keyboard-selected"
      },
      clearTaskSelection: function() {
        if (this.selectedElement) {
          this.selectedElement.className = this.selectedElement.className.replace(/\s*keyboard-selected/g, '')
          this.selectedElement = null
        }
        this.selectedTaskInstance = null
      },
      selectedElement: null,
      handleKeyboardShortcut: function(e) {
        // Simple mock implementation
        const activeElement = document.activeElement
        // Check if activeElement is an input field
        if (
          activeElement &&
          activeElement !== document.body &&
          (activeElement.tagName === "INPUT" ||
            activeElement.tagName === "TEXTAREA" ||
            activeElement.contentEditable === "true")
        ) {
          return
        }
        
        if (document.querySelector(".modal")) {
          return
        }
        
        if (!this.selectedTaskInstance) {
          return
        }
        
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
              this.resetTaskToIdle(this.selectedTaskInstance)
              this.clearTaskSelection()
            }
            break
        }
      },
      duplicateInstance: jest.fn(),
      deleteSelectedTask: jest.fn(),
      resetTaskToIdle: jest.fn(),
      showDeleteConfirmDialog: jest.fn(() => Promise.resolve(true))
    }
  })
  
  afterEach(() => {
    document.body.innerHTML = ""
  })
  
  describe("Task Selection", () => {
    it("should select task when drag handle is clicked", () => {
      const taskItem = document.createElement("div")
      taskItem.className = "task-item"
      const dragHandle = document.createElement("div")
      dragHandle.className = "drag-handle"
      taskItem.appendChild(dragHandle)
      taskList.appendChild(taskItem)
      
      const instance = { task: { title: "Test Task", path: "test.md" }, state: "idle" }
      
      view.selectTaskForKeyboard(instance, taskItem)
      
      expect(view.selectedTaskInstance).toBe(instance)
      expect(taskItem.className).toContain("keyboard-selected")
    })
    
    it("should clear previous selection when new task is selected", () => {
      const taskItem1 = document.createElement("div")
      taskItem1.className = "task-item"
      const taskItem2 = document.createElement("div")
      taskItem2.className = "task-item"
      taskList.appendChild(taskItem1)
      taskList.appendChild(taskItem2)
      
      const instance1 = { task: { title: "Task 1", path: "task1.md" }, state: "idle" }
      const instance2 = { task: { title: "Task 2", path: "task2.md" }, state: "idle" }
      
      view.selectTaskForKeyboard(instance1, taskItem1)
      expect(taskItem1.className).toContain("keyboard-selected")
      
      view.selectTaskForKeyboard(instance2, taskItem2)
      
      expect(view.selectedTaskInstance).toBe(instance2)
      expect(taskItem1.className).toBe("task-item")
      expect(taskItem2.className).toBe("task-item keyboard-selected")
    })
    
    it("should clear selection when clearTaskSelection is called", () => {
      const taskItem = document.createElement("div")
      taskItem.className = "task-item"
      taskList.appendChild(taskItem)
      
      const instance = { task: { title: "Test Task", path: "test.md" }, state: "idle" }
      
      view.selectTaskForKeyboard(instance, taskItem)
      expect(taskItem.className).toContain("keyboard-selected")
      
      view.clearTaskSelection()
      
      expect(view.selectedTaskInstance).toBe(null)
      expect(taskItem.className).toBe("task-item")
    })
  })
  
  describe("Keyboard Shortcuts", () => {
    let instance
    let taskItem
    
    beforeEach(() => {
      instance = { task: { title: "Test Task", path: "test.md" }, state: "idle" }
      taskItem = document.createElement("div")
      taskItem.className = "task-item"
      taskList.appendChild(taskItem)
      view.selectTaskForKeyboard(instance, taskItem)
    })
    
    it("should duplicate task when 'c' key is pressed", () => {
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).toHaveBeenCalled()
      expect(view.duplicateInstance).toHaveBeenCalledWith(instance)
    })
    
    it("should call delete function when 'd' key is pressed", () => {
      const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).toHaveBeenCalled()
      expect(view.deleteSelectedTask).toHaveBeenCalled()
    })
    
    it("should reset task to idle when 'u' key is pressed", () => {
      instance.state = "running"
      const event = new KeyboardEvent("keydown", { key: "u", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).toHaveBeenCalled()
      expect(view.resetTaskToIdle).toHaveBeenCalledWith(instance)
    })
    
    it("should not handle shortcuts when text input is focused", () => {
      const input = document.createElement("input")
      input.tagName = "INPUT" // jsdomで設定されない場合のために明示的に設定
      document.body.appendChild(input)
      
      // activeElementを設定
      document.activeElement = input
      expect(document.activeElement).toBe(input) // 確認
      expect(document.activeElement.tagName).toBe("INPUT") // 確認
      
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(view.duplicateInstance).not.toHaveBeenCalled()
      
      // Clean up
      document.activeElement = document.body
    })
    
    it("should not handle shortcuts when modal is open", () => {
      const modal = document.createElement("div")
      modal.className = "modal"
      document.body.appendChild(modal)
      
      // document.querySelector をモック
      const originalQuerySelector = document.querySelector
      document.querySelector = jest.fn((selector) => {
        if (selector === ".modal") {
          return modal
        }
        return originalQuerySelector.call(document, selector)
      })
      
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(view.duplicateInstance).not.toHaveBeenCalled()
      
      // Clean up
      document.querySelector = originalQuerySelector
      document.body.removeChild(modal)
    })
    
    it("should not handle shortcuts when no task is selected", () => {
      view.clearTaskSelection()
      
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(view.duplicateInstance).not.toHaveBeenCalled()
    })
    
    it("should handle uppercase keys correctly", () => {
      const event = new KeyboardEvent("keydown", { key: "C", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).toHaveBeenCalled()
      expect(view.duplicateInstance).toHaveBeenCalledWith(instance)
    })
  })
  
  describe("Context Validation", () => {
    let instance
    let taskItem
    
    beforeEach(() => {
      instance = { task: { title: "Test Task", path: "test.md" }, state: "idle" }
      taskItem = document.createElement("div")
      taskItem.className = "task-item"
      taskList.appendChild(taskItem)
      view.selectTaskForKeyboard(instance, taskItem)
    })
    
    it("should ignore shortcuts when textarea is focused", () => {
      const textarea = document.createElement("textarea")
      textarea.tagName = "TEXTAREA" // jsdomで設定されない場合のために明示的に設定
      document.body.appendChild(textarea)
      document.activeElement = textarea
      
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).not.toHaveBeenCalled()
      
      // Clean up
      document.activeElement = document.body
    })
    
    it("should ignore shortcuts when contentEditable element is focused", () => {
      const div = document.createElement("div")
      div.contentEditable = "true"
      document.body.appendChild(div)
      document.activeElement = div
      
      const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true })
      event.preventDefault = jest.fn()
      
      view.handleKeyboardShortcut.call(view, event)
      
      expect(event.preventDefault).not.toHaveBeenCalled()
      
      // Clean up
      document.activeElement = document.body
    })
  })
})