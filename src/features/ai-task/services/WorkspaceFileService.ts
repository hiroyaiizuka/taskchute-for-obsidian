/** One directly browsable entry below a workspace directory. */
export interface WorkspaceEntry {
  name: string
  type: 'file' | 'folder'
  /** Path relative to the canonical workspace root. */
  relativePath: string
  /** Absolute lexical path, already checked against the real root. */
  absolutePath: string
}

/** Result of one lazy directory expansion. */
export interface WorkspaceDirectoryListing {
  /** Canonical realpath of the workspace root. */
  rootPath: string
  /** Canonical target directory relative to root (empty at root). */
  directoryPath: string
  entries: WorkspaceEntry[]
}

/** Maximum UTF-8 payload accepted by the workspace editor (2 MiB). */
export const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024

/** Optimistic-lock token captured with file content. */
export interface WorkspaceFileVersion {
  mtimeMs: number
  size: number
}

/** One canonical, validated text file below a workspace root. */
export interface WorkspaceFileDocument {
  /** Canonical realpath of the workspace root. */
  rootPath: string
  /** Canonical file path relative to root. */
  relativePath: string
  /** Canonical absolute file path. */
  absolutePath: string
  content: string
  version: WorkspaceFileVersion
}

/** Node-boundary contract; DOM/UI code depends only on this narrow surface. */
export interface WorkspaceFileGateway {
  listWorkspaceDirectory(
    rootPath: string,
    directoryPath?: string,
  ): Promise<WorkspaceDirectoryListing>
  readWorkspaceFile(
    rootPath: string,
    filePath: string,
  ): Promise<WorkspaceFileDocument>
  writeWorkspaceFile(
    rootPath: string,
    filePath: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
  ): Promise<WorkspaceFileDocument>
}

/** A save was based on content older than the current file on disk. */
export class WorkspaceFileVersionConflictError extends Error {
  constructor() {
    super('Workspace file changed on disk; reload it before saving')
    this.name = 'WorkspaceFileVersionConflictError'
  }
}

/**
 * Lazy workspace browser used by the AI run pane Files UI.
 *
 * Filesystem access remains behind WorkspaceFileGateway, keeping this module
 * importable in tests and non-Node render paths. Each call lists one level;
 * callers expand folders by passing an entry's relativePath back in.
 */
export class WorkspaceFileService {
  constructor(private readonly gateway: WorkspaceFileGateway) {}

  async listDirectory(
    rootPath: string,
    directoryPath = '',
  ): Promise<WorkspaceDirectoryListing> {
    validatePathInput(rootPath, 'Workspace root')
    validatePathInput(directoryPath, 'Workspace directory', true)
    return await this.gateway.listWorkspaceDirectory(rootPath, directoryPath)
  }

  async readFile(
    rootPath: string,
    filePath: string,
  ): Promise<WorkspaceFileDocument> {
    validatePathInput(rootPath, 'Workspace root')
    validatePathInput(filePath, 'Workspace file')
    return await this.gateway.readWorkspaceFile(rootPath, filePath)
  }

  async writeFile(
    rootPath: string,
    filePath: string,
    content: string,
    expectedVersion: WorkspaceFileVersion,
  ): Promise<WorkspaceFileDocument> {
    validatePathInput(rootPath, 'Workspace root')
    validatePathInput(filePath, 'Workspace file')
    if (content.includes('\0')) {
      throw new Error('Workspace file content must not contain NUL')
    }
    return await this.gateway.writeWorkspaceFile(
      rootPath,
      filePath,
      content,
      expectedVersion,
    )
  }
}

function validatePathInput(
  path: string,
  label: string,
  allowEmpty = false,
): void {
  if (path.includes('\0')) {
    throw new Error(`${label} must not contain NUL`)
  }
  if (!allowEmpty && path.trim().length === 0) {
    throw new Error(`${label} must not be empty`)
  }
}
