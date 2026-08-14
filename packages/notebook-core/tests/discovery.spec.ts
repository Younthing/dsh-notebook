import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { discoverNotebookFiles } from '../src/discovery.ts'

const DIRECTORY_VERSION = FsVersion('directory')

interface DirectoryEntryInput {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly key?: string
  readonly size?: number
  readonly outside?: boolean
}

class DiscoveryFileSystem extends FileSystem {
  readonly directories = new Map<string, readonly DirectoryEntryInput[]>()
  readonly unreadable = new Set<string>()
  readCalls = 0

  constructor() {
    super(new Context())
    this.directories.set('', [])
  }

  setDirectory(path: string, entries: readonly DirectoryEntryInput[]): void {
    this.directories.set(path, entries)
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    opts?.signal?.throwIfAborted()
    const normalized = path === '.' ? '' : path.replaceAll('\\', '/')
    return Promise.resolve(this.target(normalized, `workspace:${normalized}`))
  }

  override processPath(target: FsTarget): string {
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return `file:${target.displayPath}`
  }

  override contains(_parent: FsTarget, child: FsTarget): boolean {
    return String(child.targetKey).startsWith('workspace:')
  }

  override stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    signal?.throwIfAborted()
    return Promise.resolve(this.directories.has(target.displayPath)
      ? { type: 'directory', version: DIRECTORY_VERSION }
      : undefined)
  }

  override lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    return this.resolve(path, { ...opts, ...signal === undefined ? {} : { signal } })
      .then(target => this.stat(target, signal))
  }

  override readText(_target: FsTarget): Promise<string> {
    this.readCalls += 1
    return Promise.reject(new Error('discovery must not read content'))
  }

  override streamText(_target: FsTarget): Promise<AsyncIterable<string>> {
    this.readCalls += 1
    return Promise.reject(new Error('discovery must not read content'))
  }

  override readBytes(_target: FsTarget): Promise<Uint8Array> {
    this.readCalls += 1
    return Promise.reject(new Error('discovery must not read content'))
  }

  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    signal?.throwIfAborted()
    if (this.unreadable.has(target.displayPath)) {
      return Promise.reject(new FsError('permission denied', 'FS_PERMISSION_DENIED'))
    }
    const entries = this.directories.get(target.displayPath)
    if (entries === undefined) return Promise.reject(new FsError('missing directory', 'FS_NOT_FOUND'))
    return Promise.resolve(entries.map((entry): FsDirEntry => {
      const path = target.displayPath.length === 0 ? entry.name : `${target.displayPath}/${entry.name}`
      return {
        name: entry.name,
        type: entry.type,
        target: this.target(
          path,
          entry.outside === true ? `outside:${entry.key ?? path}` : `workspace:${entry.key ?? path}`,
        ),
        ...(entry.size === undefined ? {} : { size: entry.size }),
      }
    }))
  }

  override writeText(
    _target: FsTarget,
    _content: string,
    _expected?: FsWriteIntent,
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return Promise.reject(new Error('not implemented'))
  }

  override editText(
    _target: FsTarget,
    _edit: FsEditRequest,
    _expected?: { version: ReturnType<typeof FsVersion> },
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return Promise.reject(new Error('not implemented'))
  }

  private target(path: string, key: string): FsTarget {
    return { targetKey: FsTargetKey(key), displayPath: path }
  }
}

const CONFIG = {
  pageSize: 2,
  maxEntries: 500,
  maxDepth: 12,
  excludeDirectoryNames: new Set(['.git', 'node_modules']),
}

describe('workspace notebook discovery', () => {
  it('sorts, prunes, contains, and canonically deduplicates without content reads', async () => {
    const fs = new DiscoveryFileSystem()
    fs.setDirectory('', [
      { name: 'z.ipynb', type: 'file', key: 'same', size: 9 },
      { name: 'src', type: 'directory' },
      { name: 'outside', type: 'directory', outside: true },
      { name: 'alias.ipynb', type: 'file', key: 'same', size: 9 },
      { name: '.GIT', type: 'directory' },
    ])
    fs.setDirectory('src', [
      { name: 'notes.txt', type: 'file' },
      { name: 'Plot.IPYNB', type: 'file', size: 17 },
    ])

    const page = await discoverNotebookFiles(fs, undefined, { ...CONFIG, pageSize: 50 })

    expect(page).toEqual({
      items: [
        { path: 'alias.ipynb', size: 9 },
        { path: 'src/Plot.IPYNB', size: 17 },
      ],
      partial: false,
    })
    expect(fs.readCalls).toBe(0)
  })

  it('uses exact path cursors and rejects stale continuations', async () => {
    const fs = new DiscoveryFileSystem()
    fs.setDirectory('', [
      { name: 'c.ipynb', type: 'file' },
      { name: 'a.ipynb', type: 'file' },
      { name: 'b.ipynb', type: 'file' },
    ])

    const first = await discoverNotebookFiles(fs, undefined, CONFIG)
    expect(first).toEqual({
      items: [{ path: 'a.ipynb' }, { path: 'b.ipynb' }],
      nextAfter: 'b.ipynb',
      partial: false,
    })
    await expect(discoverNotebookFiles(fs, undefined, CONFIG, { after: 'missing.ipynb' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_CURSOR_STALE' })
    await expect(discoverNotebookFiles(fs, undefined, CONFIG, { after: 'b.ipynb' }))
      .resolves.toEqual({ items: [{ path: 'c.ipynb' }], partial: false })
  })

  it('marks depth, file, and unreadable-subtree omissions as partial', async () => {
    const fs = new DiscoveryFileSystem()
    fs.setDirectory('', [
      { name: 'deep', type: 'directory' },
      { name: 'private', type: 'directory' },
      { name: 'one.ipynb', type: 'file' },
      { name: 'two.ipynb', type: 'file' },
    ])
    fs.setDirectory('deep', [{ name: 'hidden.ipynb', type: 'file' }])
    fs.setDirectory('private', [{ name: 'secret.ipynb', type: 'file' }])
    fs.unreadable.add('private')

    await expect(discoverNotebookFiles(fs, undefined, {
      ...CONFIG,
      pageSize: 50,
      maxDepth: 0,
    })).resolves.toMatchObject({ partial: true })
    await expect(discoverNotebookFiles(fs, undefined, {
      ...CONFIG,
      pageSize: 50,
    })).resolves.toMatchObject({ partial: true })
    await expect(discoverNotebookFiles(fs, undefined, {
      ...CONFIG,
      pageSize: 50,
      maxEntries: 3,
    })).resolves.toMatchObject({ partial: true })
  })

  it('propagates aborts and translates an unreadable root', async () => {
    const aborted = new DiscoveryFileSystem()
    const controller = new AbortController()
    controller.abort(new Error('cancel discovery'))
    await expect(discoverNotebookFiles(aborted, undefined, CONFIG, { signal: controller.signal }))
      .rejects.toThrow('cancel discovery')

    const unavailable = new DiscoveryFileSystem()
    unavailable.unreadable.add('')
    await expect(discoverNotebookFiles(unavailable, undefined, CONFIG))
      .rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' })
  })

  it('rejects missing roots and unexpected provider failures with stable errors', async () => {
    const missing = new DiscoveryFileSystem()
    Object.defineProperty(missing, 'stat', { value: () => Promise.resolve(undefined) })
    await expect(discoverNotebookFiles(missing, 'workspace', CONFIG, {
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' })

    const resolveFailure = new DiscoveryFileSystem()
    Object.defineProperty(resolveFailure, 'resolve', {
      value: () => Promise.reject(new Error('offline')),
    })
    const resolution = discoverNotebookFiles(resolveFailure, undefined, CONFIG)
    await expect(resolution)
      .rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' })
    await expect(resolution).rejects.toThrow('offline')

    const nestedFailure = new DiscoveryFileSystem()
    nestedFailure.setDirectory('', [{ name: 'nested', type: 'directory' }])
    nestedFailure.setDirectory('nested', [])
    const listDir = nestedFailure.listDir.bind(nestedFailure)
    Object.defineProperty(nestedFailure, 'listDir', {
      value: (target: FsTarget, signal?: AbortSignal) => target.displayPath === 'nested'
        ? Promise.reject(new Error('provider failed'))
        : listDir(target, signal),
    })
    await expect(discoverNotebookFiles(nestedFailure, undefined, CONFIG))
      .rejects.toMatchObject({ code: 'DISCOVERY_UNAVAILABLE' })
  })

  it('skips invalid segments and canonical directory cycles while stopping a parent traversal', async () => {
    const fs = new DiscoveryFileSystem()
    fs.setDirectory('', [
      { name: 'nested', type: 'directory' },
      { name: 'bad/name', type: 'file' },
      { name: 'z-later.ipynb', type: 'file' },
    ])
    fs.setDirectory('nested', [
      { name: '0cycle', type: 'directory', key: '' },
      { name: 'a.ipynb', type: 'file' },
      { name: 'b.ipynb', type: 'file' },
    ])

    await expect(discoverNotebookFiles(fs, undefined, { ...CONFIG, pageSize: 1 }))
      .resolves.toEqual({
        items: [{ path: 'nested/a.ipynb' }],
        nextAfter: 'nested/a.ipynb',
        partial: true,
      })
  })

  it('propagates an abort raised by directory listing', async () => {
    const fs = new DiscoveryFileSystem()
    const controller = new AbortController()
    Object.defineProperty(fs, 'listDir', {
      value: () => {
        const error = new Error('listing cancelled')
        controller.abort(error)
        return Promise.reject(error)
      },
    })

    await expect(discoverNotebookFiles(fs, undefined, CONFIG, { signal: controller.signal }))
      .rejects.toThrow('listing cancelled')
  })

  it('propagates an abort raised during root resolution', async () => {
    const fs = new DiscoveryFileSystem()
    const controller = new AbortController()
    Object.defineProperty(fs, 'resolve', {
      value: () => {
        const error = new Error('resolution cancelled')
        controller.abort(error)
        return Promise.reject(error)
      },
    })

    await expect(discoverNotebookFiles(fs, undefined, CONFIG, { signal: controller.signal }))
      .rejects.toThrow('resolution cancelled')
  })

  it('tolerates duplicate directory entry names from a provider', async () => {
    const fs = new DiscoveryFileSystem()
    fs.setDirectory('', [
      { name: 'same.ipynb', type: 'file', key: 'first' },
      { name: 'same.ipynb', type: 'file', key: 'first' },
    ])

    await expect(discoverNotebookFiles(fs, undefined, { ...CONFIG, pageSize: 50 }))
      .resolves.toMatchObject({
        items: [{ path: 'same.ipynb' }],
      })
  })
})
