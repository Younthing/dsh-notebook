import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  FileSystem,
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
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
import { CellId } from '../src/brand.ts'
import { replaceIpynbCellSource } from '../src/ipynb.ts'
import {
  createIpynbFile,
  notebookKernelName,
  openIpynbFile,
  prepareIpynbFile,
  replaceIpynbFile,
} from '../src/persistence.ts'

interface MemoryEntry {
  readonly type: 'file' | 'directory' | 'other'
  readonly bytes: Uint8Array
  readonly version: ReturnType<typeof FsVersion>
}

const POLICY: SandboxExecutionPolicy = {
  mode: 'danger-full-access',
  workspaceRoot: 'C:\\workspace',
}

class MemoryFileSystem extends FileSystem {
  private readonly entries = new Map<string, MemoryEntry>()
  private version = 0
  resolveCalls = 0
  readCalls = 0
  readonly writeIntents: (FsWriteIntent | undefined)[] = []
  readonly writePolicies: (SandboxExecutionPolicy | undefined)[] = []
  beforeRead: (() => void) | undefined
  beforeWrite: (() => void) | undefined

  constructor() {
    super(new Context())
  }

  putText(path: string, text: string): void {
    this.putBytes(path, new TextEncoder().encode(text))
  }

  putBytes(path: string, bytes: Uint8Array): void {
    this.entries.set(path, {
      type: 'file',
      bytes: new Uint8Array(bytes),
      version: this.nextVersion(),
    })
  }

  text(path: string): string | undefined {
    const entry = this.entries.get(path)
    return entry === undefined ? undefined : new TextDecoder().decode(entry.bytes)
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return Promise.resolve().then(() => {
      this.resolveCalls += 1
      assertNotAborted(opts?.signal)
      const displayPath = (opts?.cwd === undefined ? path : `${opts.cwd}/${path}`)
        .replaceAll('\\', '/')
        .split('/')
        .filter(segment => segment.length > 0 && segment !== '.')
        .join('/')
      return { targetKey: FsTargetKey(displayPath), displayPath }
    })
  }

  override processPath(target: FsTarget): string {
    return target.displayPath
  }

  override fileUrl(target: FsTarget): string {
    return `file:${target.displayPath}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return parent.displayPath.length === 0
      || child.displayPath === parent.displayPath
      || child.displayPath.startsWith(`${parent.displayPath}/`)
  }

  override stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return Promise.resolve().then(() => {
      assertNotAborted(signal)
      const entry = this.entries.get(target.targetKey)
      if (entry === undefined) return undefined
      return {
        version: entry.version,
        type: entry.type,
        ...entry.type === 'file' ? { size: entry.bytes.byteLength } : {},
      }
    })
  }

  override lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    return this.resolve(path, {
      ...opts,
      ...signal === undefined ? {} : { signal },
    }).then(target => this.stat(target, signal))
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.readBytes(target, signal, Number.MAX_SAFE_INTEGER)
      .then(bytes => new TextDecoder().decode(bytes))
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal)
    return (async function* (): AsyncIterable<string> {
      await Promise.resolve()
      yield text
    })()
  }

  override readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      this.readCalls += 1
      const beforeRead = this.beforeRead
      this.beforeRead = undefined
      beforeRead?.()
      assertNotAborted(signal)
      const entry = this.entries.get(target.targetKey)
      if (entry === undefined) throw new FsError('missing', 'FS_NOT_FOUND')
      if (entry.type !== 'file') throw new FsError('not a file', 'FS_NOT_REGULAR_FILE')
      if (entry.bytes.byteLength > maxBytes) throw new FsError('too large', 'FS_TOO_LARGE')
      return new Uint8Array(entry.bytes)
    })
  }

  override listDir(_target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal)
    return Promise.resolve([])
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return Promise.resolve().then(() => {
      const beforeWrite = this.beforeWrite
      this.beforeWrite = undefined
      beforeWrite?.()
      assertNotAborted(signal)
      this.writeIntents.push(expected)
      this.writePolicies.push(sandboxPolicy)
      const existing = this.entries.get(target.targetKey)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError('not a file', 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError('appeared', 'FS_NOT_OBSERVED')
      }
      if (
        expected?.kind === 'replaceIfVersion'
        && (existing === undefined || existing.version !== expected.version)
      ) {
        throw new FsError('stale', 'FS_STALE_VERSION')
      }
      const before = existing === undefined ? null : new TextDecoder().decode(existing.bytes)
      const version = this.nextVersion()
      this.entries.set(target.targetKey, {
        type: 'file',
        bytes: new TextEncoder().encode(content),
        version,
      })
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: content,
      }
    })
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

  private nextVersion(): ReturnType<typeof FsVersion> {
    this.version += 1
    return FsVersion(`v${String(this.version)}`)
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED', { cause: signal.reason })
}

function documentText(source = '', metadata: object = {}): string {
  return JSON.stringify({
    cells: [{
      cell_type: 'code',
      execution_count: null,
      id: 'existing-cell',
      metadata: {},
      outputs: [],
      source,
    }],
    metadata,
    nbformat: 4,
    nbformat_minor: 5,
  })
}

function request(fs: MemoryFileSystem, path: string, maxDocumentBytes = 1024 * 1024) {
  return {
    fs,
    path,
    initialCellId: CellId('new-cell'),
    sandboxPolicy: POLICY,
    signal: new AbortController().signal,
    maxDocumentBytes,
  }
}

describe('notebook file persistence', () => {
  it('rejects non-ipynb paths before filesystem resolution', async () => {
    const fs = new MemoryFileSystem()
    await expect(openIpynbFile(request(fs, 'analysis.py'))).rejects.toMatchObject({ code: 'INVALID_EXTENSION' })
    expect(fs.resolveCalls).toBe(0)
  })

  it('rejects absolute and traversal paths before resolution and enforces canonical containment', async () => {
    for (const path of ['/outside.ipynb', '../outside.ipynb', 'C:\\outside.ipynb', 'dir/../outside.ipynb']) {
      const fs = new MemoryFileSystem()
      await expect(prepareIpynbFile(request(fs, path))).rejects.toMatchObject({ code: 'INVALID_PATH' })
      expect(fs.resolveCalls).toBe(0)
    }

    const escaped = new MemoryFileSystem()
    Object.defineProperty(escaped, 'contains', { value: () => false })
    await expect(prepareIpynbFile(request(escaped, 'linked.ipynb')))
      .rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' })
  })

  it('strictly decodes and parses a stable bounded UTF-8 file', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('analysis.ipynb', documentText('print("你好")', {
      kernelspec: { display_name: 'Python', language: 'python', name: 'python3' },
    }))

    const opened = await openIpynbFile(request(fs, 'analysis.ipynb'))
    expect(opened.created).toBe(false)
    expect(opened.document.cells[0]?.source).toBe('print("你好")')
    expect(notebookKernelName(opened.document)).toBe('python3')
    expect(fs.readCalls).toBe(1)
  })

  it('rejects an oversized file before reading its content', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('large.ipynb', documentText('x'.repeat(500)))
    await expect(openIpynbFile(request(fs, 'large.ipynb', 64))).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    })
    expect(fs.readCalls).toBe(0)
  })

  it('distinguishes malformed JSON and invalid UTF-8', async () => {
    const malformed = new MemoryFileSystem()
    malformed.putText('malformed.ipynb', '{not json')
    await expect(openIpynbFile(request(malformed, 'malformed.ipynb'))).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT',
    })

    const invalidUtf8 = new MemoryFileSystem()
    invalidUtf8.putBytes('invalid.ipynb', new Uint8Array([0xff, 0xfe, 0xfd]))
    await expect(openIpynbFile(request(invalidUtf8, 'invalid.ipynb'))).rejects.toMatchObject({
      code: 'INVALID_UTF8',
    })
  })

  it('strict open rejects an absent notebook without writing it', async () => {
    const fs = new MemoryFileSystem()
    await expect(openIpynbFile(request(fs, 'new.ipynb'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(fs.writeIntents).toEqual([])
    expect(fs.text('new.ipynb')).toBeUndefined()
  })

  it('can defer an absent-file commit until after external setup succeeds', async () => {
    const fs = new MemoryFileSystem()
    const prepared = await prepareIpynbFile({
      fs,
      path: 'deferred.ipynb',
      signal: new AbortController().signal,
      maxDocumentBytes: 1024 * 1024,
    })
    expect(prepared.existing).toBeUndefined()
    expect(fs.writeIntents).toEqual([])
    expect(fs.text('deferred.ipynb')).toBeUndefined()

    const created = await createIpynbFile({
      fs,
      target: prepared.target,
      initialCellId: CellId('deferred-cell'),
      sandboxPolicy: POLICY,
      signal: new AbortController().signal,
      maxDocumentBytes: 1024 * 1024,
    })
    expect(created.created).toBe(true)
    expect(created.document.cells[0]?.id).toBe('deferred-cell')
    expect(fs.writeIntents).toEqual([{ kind: 'createIfAbsent' }])
  })

  it('maps a competing guarded create without overwriting the winner', async () => {
    const fs = new MemoryFileSystem()
    const prepared = await prepareIpynbFile(request(fs, 'race.ipynb'))
    fs.beforeWrite = () => { fs.putText('race.ipynb', documentText('competitor')) }

    await expect(createIpynbFile({
      fs,
      target: prepared.target,
      initialCellId: CellId('race-cell'),
      sandboxPolicy: POLICY,
      signal: new AbortController().signal,
      maxDocumentBytes: 1024 * 1024,
    })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(fs.text('race.ipynb')).toContain('competitor')
  })

  it('rejects content whose version changes across the bounded read', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('moving.ipynb', documentText('before'))
    fs.beforeRead = () => { fs.putText('moving.ipynb', documentText('during-read')) }

    await expect(openIpynbFile(request(fs, 'moving.ipynb'))).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
  })

  it('atomically replaces the observed version and rejects a stale retry', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('edit.ipynb', documentText('before'))
    const opened = await openIpynbFile(request(fs, 'edit.ipynb'))
    const changed = replaceIpynbCellSource(opened.document, CellId('existing-cell'), 'after')
    const replaced = await replaceIpynbFile({
      fs,
      target: opened.target,
      document: changed,
      version: opened.version,
      sandboxPolicy: POLICY,
      signal: new AbortController().signal,
      maxDocumentBytes: 1024 * 1024,
    })
    expect(replaced.version).not.toBe(opened.version)
    expect(fs.text('edit.ipynb')).toContain('after')

    fs.putText('edit.ipynb', documentText('external'))
    await expect(replaceIpynbFile({
      fs,
      target: opened.target,
      document: changed,
      version: replaced.version,
      sandboxPolicy: POLICY,
      signal: new AbortController().signal,
      maxDocumentBytes: 1024 * 1024,
    })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    expect(fs.text('edit.ipynb')).toContain('external')
  })

  it('rejects an oversized replacement before entering the filesystem write', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('bounded.ipynb', documentText('small'))
    const opened = await openIpynbFile(request(fs, 'bounded.ipynb'))
    const changed = replaceIpynbCellSource(opened.document, CellId('existing-cell'), 'x'.repeat(1000))

    await expect(replaceIpynbFile({
      fs,
      target: opened.target,
      document: changed,
      version: opened.version,
      sandboxPolicy: POLICY,
      signal: new AbortController().signal,
      maxDocumentBytes: 128,
    })).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' })
    expect(fs.writeIntents).toEqual([])
  })

  it('propagates filesystem cancellation without translating it to a document error', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('cancel.ipynb', documentText())
    const controller = new AbortController()
    fs.beforeRead = () => { controller.abort(new Error('cancelled by caller')) }

    await expect(openIpynbFile({
      ...request(fs, 'cancel.ipynb'),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'FS_ABORTED' })
  })

  it('requires a string kernelspec name when kernelspec metadata is present', async () => {
    const fs = new MemoryFileSystem()
    fs.putText('kernel.ipynb', documentText('', { kernelspec: { name: 3 } }))
    const opened = await openIpynbFile(request(fs, 'kernel.ipynb'))
    expect(() => notebookKernelName(opened.document)).toThrow(expect.objectContaining({ code: 'INVALID_DOCUMENT' }))
  })
})
