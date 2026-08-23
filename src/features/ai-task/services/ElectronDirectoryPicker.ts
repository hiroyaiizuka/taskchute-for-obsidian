/**
 * Narrow Electron boundary for choosing an AI task working directory.
 *
 * Obsidian does not expose a public arbitrary-filesystem directory picker.
 * Its desktop renderer does expose @electron/remote/electron.remote, so only
 * the single native-dialog operation needed by the UI is wrapped here. The
 * adapter degrades to `null` outside that capability boundary.
 */

// Electron is a runtime external in the Obsidian renderer. Keeping the loader
// injectable makes Jest and future capability fallbacks deterministic.
declare function require(moduleId: string): unknown

export type ElectronModuleLoader = (moduleId: string) => unknown

interface OpenDialogResultLike {
  canceled?: boolean
  filePaths?: unknown
}

interface ElectronRemoteLike {
  app?: {
    getPath?: (name: string) => unknown
  }
  dialog?: {
    showOpenDialog?: (options: {
      properties: string[]
      defaultPath?: string
      title: string
    }) => unknown
  }
}

interface ElectronModuleLike {
  remote?: unknown
}

function asRemote(value: unknown): ElectronRemoteLike | null {
  if (!value || typeof value !== 'object') return null
  const remote = value as ElectronRemoteLike
  return typeof remote.dialog?.showOpenDialog === 'function' ? remote : null
}

function defaultModuleLoader(moduleId: string): unknown {
  return require(moduleId)
}

export class ElectronDirectoryPicker {
  constructor(
    private readonly loadModule: ElectronModuleLoader = defaultModuleLoader,
  ) {}

  async selectDirectory(defaultPath?: string): Promise<string | null> {
    return this.open(
      ['openDirectory', 'createDirectory'],
      'ワーキングディレクトリを選択',
      defaultPath,
    )
  }

  async selectFile(options?: {
    defaultPath?: string
    title?: string
  }): Promise<string | null> {
    return this.open(
      ['openFile'],
      options?.title ?? 'ファイルを選択',
      options?.defaultPath,
    )
  }

  private async open(
    properties: string[],
    title: string,
    defaultPath?: string,
  ): Promise<string | null> {
    const remote = this.resolveRemote()
    if (!remote?.dialog?.showOpenDialog) return null

    const requestedPath = defaultPath?.trim() ?? ''
    let homePath = ''
    if (!requestedPath && typeof remote.app?.getPath === 'function') {
      try {
        const candidate = remote.app.getPath('home')
        if (typeof candidate === 'string') homePath = candidate.trim()
      } catch {
        // Electron capability is partial; the dialog can still choose its cwd.
      }
    }

    try {
      const result = (await remote.dialog.showOpenDialog({
        properties,
        ...(requestedPath || homePath
          ? { defaultPath: requestedPath || homePath }
          : {}),
        title,
      })) as OpenDialogResultLike | null

      if (!result || result.canceled === true || !Array.isArray(result.filePaths)) {
        return null
      }
      const firstPath = (result.filePaths as unknown[])[0]
      return typeof firstPath === 'string' && firstPath.trim().length > 0
        ? firstPath
        : null
    } catch {
      // Native-dialog failures are a non-fatal capability miss.
      return null
    }
  }

  private resolveRemote(): ElectronRemoteLike | null {
    try {
      const remotePackage = asRemote(this.loadModule('@electron/remote'))
      if (remotePackage) return remotePackage
    } catch {
      // Fall through to the bridge Obsidian exposes on `electron`.
    }

    try {
      const electron = this.loadModule('electron') as ElectronModuleLike | null
      return asRemote(electron?.remote)
    } catch {
      return null
    }
  }
}
