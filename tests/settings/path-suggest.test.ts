import { AbstractInputSuggest, Setting, TFile } from 'obsidian'

import { FilePathSuggest } from '../../src/settings/filePathSuggest'
import { TaskChuteSettingTab } from '../../src/settings/SettingsTab'

type FolderStub = {
  path: string
  children: unknown[]
}

type TextComponentStub = {
  inputEl: HTMLInputElement
  setValue(value: string): TextComponentStub
  __triggerEvent(type: string): Promise<void>
}

type SettingInstanceStub = {
  __textComponents?: TextComponentStub[]
}

type SettingMockWithInstances = jest.Mock & {
  __instances: SettingInstanceStub[]
}

class TestableFilePathSuggest extends FilePathSuggest {
  suggestions(query: string): TFile[] {
    return this.getSuggestions(query)
  }
}

function file(path: string): TFile {
  const result = new TFile()
  result.path = path
  result.basename = path.split('/').pop()?.replace(/\.[^.]+$/u, '') ?? path
  result.extension = path.split('.').pop() ?? ''
  return result
}

function folder(path: string, children: unknown[] = []): FolderStub {
  return { path, children }
}

function createApp(root: FolderStub) {
  const folders = new Map<string, FolderStub>()
  const index = (entry: FolderStub): void => {
    folders.set(entry.path, entry)
    entry.children.forEach((child) => {
      if (isFolderStub(child)) {
        index(child)
      }
    })
  }
  index(root)

  return {
    vault: {
      getRoot: jest.fn(() => root),
      getAbstractFileByPath: jest.fn((path: string) => folders.get(path) ?? null),
    },
  }
}

function isFolderStub(value: unknown): value is FolderStub {
  return !!value && typeof value === 'object' && Array.isArray((value as FolderStub).children)
}

// Intersecting the class itself would collapse to `never`: `renderStorageSection`
// is private on TaskChuteSettingTab, so it exists in both constituents with
// incompatible declarations. Omit strips the private members and keeps the
// public surface the test actually touches.
type MutableSettingTab = Omit<
  TaskChuteSettingTab,
  'app' | 'plugin' | 'renderStorageSection'
> & {
  app: ReturnType<typeof createApp>
  plugin: {
    settings: {
      locationMode: 'specifiedFolder'
      specifiedFolder?: string
    }
    pathManager: {
      validatePath(path: string): { valid: boolean }
    }
    saveSettings(): Promise<void>
  }
  renderStorageSection(container: HTMLElement): void
}

function createSettingTab(
  app: ReturnType<typeof createApp>,
): MutableSettingTab {
  const tab = Object.create(
    TaskChuteSettingTab.prototype,
  ) as MutableSettingTab

  tab.app = app
  tab.plugin = {
    settings: {
      locationMode: 'specifiedFolder',
      specifiedFolder: '',
    },
    pathManager: {
      validatePath: jest.fn(() => ({ valid: true })),
    },
    saveSettings: jest.fn().mockResolvedValue(undefined),
  }

  return tab
}

describe('settings path suggestions', () => {
  const SettingMock = Setting as unknown as SettingMockWithInstances
  const abstractInputSuggestPrototype = AbstractInputSuggest.prototype as unknown as {
    open: () => void
  }
  const originalOpen = abstractInputSuggestPrototype.open

  afterEach(() => {
    abstractInputSuggestPrototype.open = originalOpen
    SettingMock.__instances.length = 0
    jest.clearAllMocks()
  })

  test('file path suggestions include markdown files directly under vault root', () => {
    const template = file('Template.md')
    const nestedTemplate = file('Templates/Nested.md')
    const root = folder('/', [
      template,
      file('Template.txt'),
      folder('Templates', [nestedTemplate]),
    ])
    const suggest = new TestableFilePathSuggest(
      createApp(root) as never,
      document.createElement('input'),
      jest.fn(),
    )

    expect(suggest.suggestions('Temp').map((candidate) => candidate.path)).toEqual(['Template.md'])
  })

  test('specified folder suggestions include folders directly under vault root', async () => {
    const root = folder('/', [
      folder('TaskChute', [folder('TaskChute/Task')]),
      folder('Archive'),
    ])
    const capturedSuggestions: string[][] = []
    abstractInputSuggestPrototype.open = function openWithCapture(this: {
      getSuggestions(query: string): Array<{ path: string }>
      inputEl: HTMLInputElement
    }): void {
      capturedSuggestions.push(
        this.getSuggestions(this.inputEl.value).map((candidate) => candidate.path),
      )
    }

    const tab = createSettingTab(createApp(root))
    tab.renderStorageSection(document.createElement('div'))
    const text = SettingMock.__instances.flatMap((instance) => instance.__textComponents ?? [])[0]

    text.setValue('Task')
    await text.__triggerEvent('focus')

    expect(capturedSuggestions).toEqual([['TaskChute']])
  })
})
