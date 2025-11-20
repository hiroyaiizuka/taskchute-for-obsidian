import { TFile, TFolder } from 'obsidian'
import type { TaskChutePluginLike } from '../../src/types'
import { LOG_INBOX_FOLDER } from '../../src/features/log/constants'

export interface PluginStub {
  plugin: TaskChutePluginLike
  store: Map<string, string>
  deltaStore: Map<string, string>
  abstractStore: Map<string, TFolder | TFile>
}

function createTFile(path: string) {
  const file = new TFile()
  file.path = path
  const filename = path.split('/').pop() ?? path
  const parts = filename.split('.')
  const extension = parts.length > 1 ? parts.pop() ?? '' : ''
  file.extension = extension
  file.basename = extension ? filename.slice(0, -(extension.length + 1)) : filename
  Object.setPrototypeOf(file, TFile.prototype)
  return file
}

function createTFolder(path: string): TFolder {
  const folder = new TFolder()
  folder.path = path
  folder.name = path.split('/').pop() ?? path
  folder.children = []
  Object.setPrototypeOf(folder, TFolder.prototype)
  return folder
}

function attachChild(parent: TFolder, child: TFolder | TFile, store: Map<string, TFolder | TFile>) {
  parent.children.push(child)
  const mutableChild = child as TFile & { parent?: TFolder }
  mutableChild.parent = parent
  store.set(child.path, child)
}

export function seedVaultFile(
  store: Map<string, string>,
  abstractStore: Map<string, TFolder | TFile>,
  path: string,
  contents: string,
): void {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) {
    return
  }
  segments.pop()
  let currentPath = segments.shift()!
  let parent = abstractStore.get(currentPath)
  if (!(parent instanceof TFolder)) {
    parent = createTFolder(currentPath)
    abstractStore.set(currentPath, parent)
  }
  for (const segment of segments) {
    currentPath = `${currentPath}/${segment}`
    let folder = abstractStore.get(currentPath)
    if (!(folder instanceof TFolder)) {
      folder = createTFolder(currentPath)
      attachChild(parent, folder, abstractStore)
    }
    parent = folder
  }
  let file = abstractStore.get(path)
  if (!(file instanceof TFile)) {
    file = createTFile(path)
    abstractStore.set(path, file)
    if (parent instanceof TFolder) {
      attachChild(parent, file, abstractStore)
    }
  }
  store.set(path, contents)
}

export function createPluginStub(): PluginStub {
  const store = new Map<string, string>()
  const deltaStore = new Map<string, string>()
  const abstractStore = new Map<string, TFolder | TFile>()

  const logRoot = createTFolder('LOGS')
  abstractStore.set('LOGS', logRoot)
  const inbox = createTFolder(`LOGS/${LOG_INBOX_FOLDER}`)
  attachChild(logRoot, inbox, abstractStore)

  const vault = {
    adapter: {
      read: jest.fn(async (path: string) => deltaStore.get(path) ?? ''),
      write: jest.fn(async (path: string, data: string) => {
        deltaStore.set(path, data)
      }),
    },
    getAbstractFileByPath: jest.fn((path: string) => abstractStore.get(path) ?? null),
    read: jest.fn(async (file: TFile) => store.get(file.path) ?? ''),
    modify: jest.fn(async (file: TFile, content: string) => {
      store.set(file.path, content)
    }),
    create: jest.fn(async (path: string, content: string) => {
      const file = createTFile(path)
      store.set(path, content)
      const root = abstractStore.get('LOGS')
      if (root instanceof TFolder) {
        attachChild(root, file, abstractStore)
      }
      return file
    }),
  }

  const pathManager = {
    getLogDataPath: () => 'LOGS',
    ensureFolderExists: jest.fn().mockResolvedValue(undefined),
    getLogYearPath: jest.fn(),
    ensureYearFolder: jest.fn(),
  }

  const plugin: TaskChutePluginLike = {
    app: { vault } as TaskChutePluginLike['app'],
    pathManager,
    settings: {
      useOrderBasedSort: true,
      slotKeys: {},
    },
    saveSettings: jest.fn(),
    routineAliasService: {
      loadAliases: jest.fn(),
    },
    dayStateService: {
      loadDay: jest.fn(),
      saveDay: jest.fn(),
      mergeDayState: jest.fn(),
      clearCache: jest.fn(),
      getDateFromKey: jest.fn(),
    },
  }

  return { plugin, store, deltaStore, abstractStore }
}

export function seedDeltaFile(
  abstractStore: Map<string, TFolder | TFile>,
  deltaStore: Map<string, string>,
  deviceId: string,
  monthKey: string,
  records: unknown[],
): void {
  let inbox = abstractStore.get(`LOGS/${LOG_INBOX_FOLDER}`)
  if (!(inbox instanceof TFolder)) {
    inbox = createTFolder(`LOGS/${LOG_INBOX_FOLDER}`)
    const root = abstractStore.get('LOGS')
    if (root instanceof TFolder) {
      attachChild(root, inbox, abstractStore)
    } else {
      throw new Error('LOGS folder missing')
    }
  }
  const devicePath = `LOGS/${LOG_INBOX_FOLDER}/${deviceId}`
  let deviceFolder = abstractStore.get(devicePath)
  if (!(deviceFolder instanceof TFolder)) {
    deviceFolder = createTFolder(devicePath)
    attachChild(inbox, deviceFolder, abstractStore)
  }
  const deltaPath = `${devicePath}/${monthKey}.jsonl`
  let deltaFile = abstractStore.get(deltaPath) as TFile | undefined
  if (!deltaFile) {
    deltaFile = createTFile(deltaPath)
    attachChild(deviceFolder, deltaFile, abstractStore)
  }
  deltaStore.set(deltaPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

export function seedSnapshot(
  store: Map<string, string>,
  abstractStore: Map<string, TFolder | TFile>,
  monthKey: string,
  snapshot: unknown,
): void {
  const path = `LOGS/${monthKey}-tasks.json`
  seedVaultFile(store, abstractStore, path, JSON.stringify(snapshot))
}
