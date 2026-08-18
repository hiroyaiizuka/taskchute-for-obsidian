import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { NodeProcessGateway } from '../../../src/features/ai-task/services/NodeProcessGateway'
import {
  MAX_WORKSPACE_FILE_BYTES,
  WorkspaceFileVersionConflictError,
  WorkspaceFileService,
  type WorkspaceEntry,
} from '../../../src/features/ai-task/services/WorkspaceFileService'

describe('WorkspaceFileService', () => {
  let sandbox: string
  let root: string
  let outside: string
  let service: WorkspaceFileService

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'taskchute-workspace-files-'))
    root = path.join(sandbox, 'workspace')
    outside = path.join(sandbox, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    service = new WorkspaceFileService(new NodeProcessGateway())
  })

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true })
  })

  test('lists folders first and then files by name while excluding heavy internals', async () => {
    fs.mkdirSync(path.join(root, 'z-folder'))
    fs.mkdirSync(path.join(root, 'a-folder'))
    fs.mkdirSync(path.join(root, '.git'))
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.writeFileSync(path.join(root, 'z.txt'), '')
    fs.writeFileSync(path.join(root, 'a.txt'), '')

    const listing = await service.listDirectory(root)

    expect(listing.rootPath).toBe(fs.realpathSync(root))
    expect(listing.directoryPath).toBe('')
    expect(listing.entries.map(pickEntry)).toEqual([
      { name: 'a-folder', relativePath: 'a-folder', type: 'folder' },
      { name: 'z-folder', relativePath: 'z-folder', type: 'folder' },
      { name: 'a.txt', relativePath: 'a.txt', type: 'file' },
      { name: 'z.txt', relativePath: 'z.txt', type: 'file' },
    ])
  })

  test('supports a relative directoryPath for lazy folder expansion', async () => {
    fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), '')

    const listing = await service.listDirectory(root, 'src')

    expect(listing.directoryPath).toBe('src')
    expect(listing.entries.map(pickEntry)).toEqual([
      { name: 'nested', relativePath: path.join('src', 'nested'), type: 'folder' },
      { name: 'index.ts', relativePath: path.join('src', 'index.ts'), type: 'file' },
    ])
  })

  test('keeps legal dot-dot-prefixed names inside the workspace', async () => {
    fs.mkdirSync(path.join(root, '..cache'))
    fs.writeFileSync(path.join(root, '..config'), '')

    const listing = await service.listDirectory(root)

    expect(listing.entries.map(pickEntry)).toEqual([
      { name: '..cache', relativePath: '..cache', type: 'folder' },
      { name: '..config', relativePath: '..config', type: 'file' },
    ])
    await expect(service.listDirectory(root, '..cache')).resolves.toMatchObject({
      directoryPath: '..cache',
    })
  })

  test('canonicalizes a symlinked workspace root before applying the boundary', async () => {
    const rootLink = path.join(sandbox, 'workspace-link')
    fs.symlinkSync(root, rootLink, 'dir')
    fs.writeFileSync(path.join(root, 'inside.md'), '')

    const listing = await service.listDirectory(rootLink)

    expect(listing.rootPath).toBe(fs.realpathSync(root))
    expect(listing.entries[0]?.absolutePath).toBe(path.join(fs.realpathSync(root), 'inside.md'))
  })

  test('rejects lexical traversal outside the workspace root', async () => {
    await expect(service.listDirectory(root, '../outside')).rejects.toThrow(
      'outside the workspace root',
    )
  })

  test('rejects a directory symlink whose real target escapes the workspace root', async () => {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir')

    await expect(service.listDirectory(root, 'escape')).rejects.toThrow(
      'outside the workspace root',
    )
  })

  test('omits child symlinks whose real targets escape the workspace root', async () => {
    fs.writeFileSync(path.join(root, 'inside.md'), '')
    fs.writeFileSync(path.join(outside, 'secret.md'), '')
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'secret-link.md'))

    const listing = await service.listDirectory(root)

    expect(listing.entries.map((entry) => entry.name)).toEqual(['inside.md'])
  })

  test('keeps child symlinks whose real targets remain inside the workspace root', async () => {
    fs.mkdirSync(path.join(root, 'actual'))
    fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'alias'), 'dir')

    const listing = await service.listDirectory(root)

    expect(listing.entries.map(pickEntry)).toEqual([
      { name: 'actual', relativePath: 'actual', type: 'folder' },
      { name: 'alias', relativePath: 'alias', type: 'folder' },
    ])
  })

  test('rejects NUL in either the root or directory input', async () => {
    await expect(service.listDirectory(`${root}\0hidden`)).rejects.toThrow('NUL')
    await expect(service.listDirectory(root, 'src\0hidden')).rejects.toThrow('NUL')
  })

  describe('safe text reads', () => {
    test('reads root-relative and root-contained absolute paths with a version', async () => {
      const filePath = path.join(root, '日本語 file.md')
      fs.writeFileSync(filePath, '# Hello\nこんにちは\n')

      const relative = await service.readFile(root, '日本語 file.md')
      const absolute = await service.readFile(root, filePath)

      expect(relative).toEqual(absolute)
      expect(relative).toMatchObject({
        rootPath: fs.realpathSync(root),
        relativePath: '日本語 file.md',
        absolutePath: fs.realpathSync(filePath),
        content: '# Hello\nこんにちは\n',
        version: { size: Buffer.byteLength('# Hello\nこんにちは\n') },
      })
      expect(relative.version.mtimeMs).toEqual(expect.any(Number))
    })

    test.each([
      ['traversal', '../outside/secret.md'],
      ['outside absolute', () => path.join(outside, 'secret.md')],
    ])('rejects %s paths', async (_label, candidate) => {
      fs.writeFileSync(path.join(outside, 'secret.md'), 'secret')
      const filePath = typeof candidate === 'function' ? candidate() : candidate

      await expect(service.readFile(root, filePath)).rejects.toThrow(
        'outside the workspace root',
      )
    })

    test('rejects a file symlink whose real target escapes the workspace', async () => {
      fs.writeFileSync(path.join(outside, 'secret.md'), 'secret')
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'escape.md'))

      await expect(service.readFile(root, 'escape.md')).rejects.toThrow(
        'outside the workspace root',
      )
    })

    test('canonicalizes a file symlink whose target remains inside the workspace', async () => {
      fs.writeFileSync(path.join(root, 'actual.md'), 'inside')
      fs.symlinkSync(path.join(root, 'actual.md'), path.join(root, 'alias.md'))

      await expect(service.readFile(root, 'alias.md')).resolves.toMatchObject({
        relativePath: 'actual.md',
        absolutePath: fs.realpathSync(path.join(root, 'actual.md')),
        content: 'inside',
      })
    })

    test('rejects a directory and NUL-bearing file input', async () => {
      fs.mkdirSync(path.join(root, 'folder'))

      await expect(service.readFile(root, 'folder')).rejects.toThrow('not a file')
      await expect(service.readFile(root, 'bad\0.md')).rejects.toThrow('NUL')
    })

    test('rejects files over 2 MiB', async () => {
      fs.writeFileSync(path.join(root, 'large.txt'), 'a'.repeat(MAX_WORKSPACE_FILE_BYTES + 1))

      await expect(service.readFile(root, 'large.txt')).rejects.toThrow('2 MiB')
    })

    test.each([
      ['NUL-bearing binary', Buffer.from([0x61, 0x00, 0x62])],
      ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
      ['binary control bytes', Buffer.from([0x61, 0x01, 0x62])],
    ])('rejects %s content', async (_label, bytes) => {
      fs.writeFileSync(path.join(root, 'binary.dat'), bytes)

      await expect(service.readFile(root, 'binary.dat')).rejects.toThrow('text')
    })
  })

  describe('safe optimistic writes', () => {
    test('overwrites an existing file and returns the saved content and new version', async () => {
      const filePath = path.join(root, 'note.md')
      fs.writeFileSync(filePath, 'old content that is longer')
      const opened = await service.readFile(root, 'note.md')

      const saved = await service.writeFile(
        root,
        'note.md',
        'new',
        opened.version,
      )

      expect(fs.readFileSync(filePath, 'utf8')).toBe('new')
      expect(saved.content).toBe('new')
      expect(saved.version.size).toBe(3)
      expect(saved.absolutePath).toBe(fs.realpathSync(filePath))
    })

    test('rejects a stale save after an external same-size change', async () => {
      const filePath = path.join(root, 'note.md')
      fs.writeFileSync(filePath, 'first')
      const opened = await service.readFile(root, 'note.md')
      fs.writeFileSync(filePath, 'other')
      const changedTime = new Date(opened.version.mtimeMs + 2000)
      fs.utimesSync(filePath, changedTime, changedTime)

      await expect(
        service.writeFile(root, 'note.md', 'mine!', opened.version),
      ).rejects.toBeInstanceOf(WorkspaceFileVersionConflictError)
      expect(fs.readFileSync(filePath, 'utf8')).toBe('other')
    })

    test('rejects creation, directory writes, outside paths, and symlink escape', async () => {
      fs.mkdirSync(path.join(root, 'folder'))
      fs.writeFileSync(path.join(outside, 'secret.md'), 'secret')
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'escape.md'))
      const version = { mtimeMs: 0, size: 0 }

      await expect(service.writeFile(root, 'new.md', 'new', version)).rejects.toThrow()
      await expect(service.writeFile(root, 'folder', 'new', version)).rejects.toThrow(
        'not a file',
      )
      await expect(
        service.writeFile(root, path.join(outside, 'secret.md'), 'new', version),
      ).rejects.toThrow('outside the workspace root')
      await expect(service.writeFile(root, 'escape.md', 'new', version)).rejects.toThrow(
        'outside the workspace root',
      )
      expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe('secret')
    })

    test('rejects NUL and over-limit save content without modifying the file', async () => {
      const filePath = path.join(root, 'note.md')
      fs.writeFileSync(filePath, 'original')
      const opened = await service.readFile(root, 'note.md')

      await expect(
        service.writeFile(root, 'note.md', 'bad\0content', opened.version),
      ).rejects.toThrow('NUL')
      await expect(
        service.writeFile(
          root,
          'note.md',
          'a'.repeat(MAX_WORKSPACE_FILE_BYTES + 1),
          opened.version,
        ),
      ).rejects.toThrow('2 MiB')
      expect(fs.readFileSync(filePath, 'utf8')).toBe('original')
    })
  })
})

function pickEntry(entry: WorkspaceEntry): Pick<WorkspaceEntry, 'name' | 'relativePath' | 'type'> {
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    type: entry.type,
  }
}
