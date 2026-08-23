import { normalizePath, TFile, TFolder } from 'obsidian'

export interface ListFilesInFolderOptions {
  markdownOnly?: boolean
  extensions?: string[]
  suffix?: string | string[]
  recursive?: boolean
}

type VaultLike = {
  getAbstractFileByPath(path: string): unknown
  getRoot?(): unknown
}

type AppLike = {
  vault: VaultLike
}

type FolderLike = {
  path?: string
  children?: unknown[]
}

export interface VaultFolderEntry {
  path: string
}

const VAULT_ROOT_PATH = '/'

function normalizeFolderPath(folderPath: string | null | undefined): string | null {
  const trimmed = (folderPath ?? '').trim()
  if (!trimmed) return null
  const normalized = normalizePath(trimmed)
  const safePath = typeof normalized === 'string' ? normalized : trimmed.replace(/\\/gu, '/').replace(/\/+/gu, '/')
  const withoutTrailingSlash = safePath.replace(/\/+$/u, '')
  if (withoutTrailingSlash.length === 0 && safePath.startsWith(VAULT_ROOT_PATH)) {
    return VAULT_ROOT_PATH
  }
  return withoutTrailingSlash
}

function isFolderLike(candidate: unknown): candidate is FolderLike {
  if (candidate instanceof TFolder) return true
  return !!candidate && typeof candidate === 'object' && Array.isArray((candidate as FolderLike).children)
}

function isFileLike(candidate: unknown): candidate is TFile {
  if (candidate instanceof TFile) return true
  if (!candidate || typeof candidate !== 'object') return false
  const maybe = candidate as { path?: unknown; children?: unknown }
  return typeof maybe.path === 'string' && !Array.isArray(maybe.children)
}

function isUnderFolder(path: string, folderPath: string): boolean {
  if (folderPath === VAULT_ROOT_PATH) return true
  return path.startsWith(`${folderPath}/`)
}

function getFolderByPath(app: AppLike, folderPath: string): unknown {
  if (folderPath !== VAULT_ROOT_PATH) {
    return app.vault.getAbstractFileByPath(folderPath)
  }

  const root = app.vault.getRoot?.()
  if (isFolderLike(root)) return root

  const slashRoot = app.vault.getAbstractFileByPath(VAULT_ROOT_PATH)
  if (isFolderLike(slashRoot)) return slashRoot

  return app.vault.getAbstractFileByPath('')
}

function getFileExtension(file: TFile): string {
  const explicit = (file as { extension?: unknown }).extension
  if (typeof explicit === 'string' && explicit.length > 0) {
    return explicit
  }

  const fileName = file.path.split('/').pop() ?? file.path
  const extensionIndex = fileName.lastIndexOf('.')
  if (extensionIndex < 0) return ''
  return fileName.slice(extensionIndex + 1)
}

function matchesOptions(file: TFile, folderPath: string, options: ListFilesInFolderOptions): boolean {
  if (!isUnderFolder(file.path, folderPath)) return false

  const extension = getFileExtension(file)

  if (options.markdownOnly && extension !== 'md') {
    return false
  }

  if (options.extensions && options.extensions.length > 0 && !options.extensions.includes(extension)) {
    return false
  }

  if (options.suffix) {
    const suffixes = Array.isArray(options.suffix) ? options.suffix : [options.suffix]
    if (!suffixes.some((suffix) => file.path.endsWith(suffix))) {
      return false
    }
  }

  return true
}

export function listFilesInFolder(
  app: AppLike,
  folderPath: string | null | undefined,
  options: ListFilesInFolderOptions = {},
): TFile[] {
  const normalizedFolderPath = normalizeFolderPath(folderPath)
  if (!normalizedFolderPath) return []

  const root = getFolderByPath(app, normalizedFolderPath)
  if (!isFolderLike(root)) return []

  const recursive = options.recursive !== false
  const files: TFile[] = []

  const visit = (folder: FolderLike): void => {
    for (const child of folder.children ?? []) {
      if (isFileLike(child)) {
        if (matchesOptions(child, normalizedFolderPath, options)) {
          files.push(child)
        }
        continue
      }

      if (recursive && isFolderLike(child)) {
        visit(child)
      }
    }
  }

  visit(root)
  return files
}

export function listFoldersInFolder(
  app: AppLike,
  folderPath: string | null | undefined,
  options: { recursive?: boolean } = {},
): VaultFolderEntry[] {
  const normalizedFolderPath = normalizeFolderPath(folderPath)
  if (!normalizedFolderPath) return []

  const root = getFolderByPath(app, normalizedFolderPath)
  if (!isFolderLike(root)) return []

  const recursive = options.recursive !== false
  const folders: VaultFolderEntry[] = []

  const visit = (folder: FolderLike): void => {
    for (const child of folder.children ?? []) {
      if (!isFolderLike(child)) continue
      if (typeof child.path === 'string') {
        folders.push({ path: child.path })
      }
      if (recursive) {
        visit(child)
      }
    }
  }

  visit(root)
  return folders
}
