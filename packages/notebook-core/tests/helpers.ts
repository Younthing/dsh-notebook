import { Context } from '@deepseek-ai/cordis'
import {
  AttachmentId,
  AttachmentStore,
} from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
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
  FsVersion as FsVersionType,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

interface TestFileEntry {
  readonly bytes: Uint8Array
  readonly version: FsVersionType
}

/** Shared in-memory file state retained across test service restarts. */
export interface TestFileState {
  readonly entries: Map<string, TestFileEntry>
  readonly aliases: Map<string, string>
  version: number
  beforeWrite: (() => void) | undefined
}

/** @returns empty shareable notebook filesystem state. */
export function createTestFileState(): TestFileState {
  return { entries: new Map(), aliases: new Map(), version: 0, beforeWrite: undefined }
}

/** Minimal atomic filesystem provider for NotebookService unit tests. */
export class TestFileSystem extends FileSystem {
  readonly state: TestFileState
  readCalls = 0

  constructor(ctx: Context, config: { readonly state?: TestFileState } = {}) {
    super(ctx)
    this.state = config.state ?? createTestFileState()
  }

  /** Replace one file outside the notebook service and advance its version. */
  putText(path: string, text: string): void {
    const key = this.canonical(path)
    this.state.entries.set(key, {
      bytes: new TextEncoder().encode(text),
      version: this.nextVersion(),
    })
  }

  /** Read one test file as UTF-8 text. */
  text(path: string): string | undefined {
    const entry = this.state.entries.get(this.canonical(path))
    return entry === undefined ? undefined : new TextDecoder().decode(entry.bytes)
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal)
    const input = opts?.cwd === undefined ? path : `${opts.cwd}/${path}`
    const key = this.canonical(input)
    return Promise.resolve({ targetKey: FsTargetKey(key), displayPath: key })
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
    assertNotAborted(signal)
    const entry = this.state.entries.get(String(target.targetKey))
    if (entry !== undefined) {
      return Promise.resolve({ version: entry.version, type: 'file', size: entry.bytes.byteLength })
    }
    const key = String(target.targetKey)
    const prefix = key.length === 0 ? '' : `${key}/`
    if (key.length === 0 || [...this.state.entries.keys()].some(path => path.startsWith(prefix))) {
      return Promise.resolve({ version: FsVersion(`directory-${String(this.state.version)}`), type: 'directory' })
    }
    return Promise.resolve(undefined)
  }

  override lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    return this.resolve(path, { ...opts, ...signal === undefined ? {} : { signal } })
      .then(target => this.stat(target, signal))
  }

  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.readBytes(target, signal, Number.MAX_SAFE_INTEGER)
      .then(bytes => new TextDecoder().decode(bytes))
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const value = await this.readText(target, signal)
    return (async function* (): AsyncIterable<string> { yield value })()
  }

  override readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    assertNotAborted(signal)
    this.readCalls += 1
    const entry = this.state.entries.get(String(target.targetKey))
    if (entry === undefined) return Promise.reject(new FsError('missing', 'FS_NOT_FOUND'))
    if (entry.bytes.byteLength > maxBytes) return Promise.reject(new FsError('too large', 'FS_TOO_LARGE'))
    return Promise.resolve(new Uint8Array(entry.bytes))
  }

  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal)
    const key = String(target.targetKey)
    const prefix = key.length === 0 ? '' : `${key}/`
    const children = new Map<string, FsDirEntry>()
    for (const [path, entry] of this.state.entries) {
      if (!path.startsWith(prefix)) continue
      const relative = path.slice(prefix.length)
      const [name, ...rest] = relative.split('/')
      if (name === undefined || name.length === 0 || children.has(name)) continue
      const childPath = prefix + name
      children.set(name, rest.length === 0
        ? {
          name,
          type: 'file',
          target: { targetKey: FsTargetKey(path), displayPath: path },
          version: entry.version,
          size: entry.bytes.byteLength,
        }
        : {
          name,
          type: 'directory',
          target: { targetKey: FsTargetKey(childPath), displayPath: childPath },
        })
    }
    return Promise.resolve([...children.values()])
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return Promise.resolve().then(() => {
      const beforeWrite = this.state.beforeWrite
      this.state.beforeWrite = undefined
      beforeWrite?.()
      assertNotAborted(signal)
      const key = String(target.targetKey)
      const existing = this.state.entries.get(key)
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
      this.state.entries.set(key, { bytes: new TextEncoder().encode(content), version })
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
    _expected?: { version: FsVersionType },
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return Promise.reject(new Error('not implemented'))
  }

  private canonical(path: string): string {
    const normalized = path
      .replaceAll('\\', '/')
      .split('/')
      .filter(segment => segment.length > 0 && segment !== '.')
      .join('/')
    return this.state.aliases.get(normalized) ?? normalized
  }

  private nextVersion(): FsVersionType {
    this.state.version += 1
    return FsVersion(`v${String(this.state.version)}`)
  }
}

/** Minimal content-addressed attachment provider for notebook service tests. */
export class TestAttachmentStore extends AttachmentStore {
  override readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 16 * 1024 * 1024,
    maxImagesPerMessage: 256,
    maxMessageImageBytes: 64 * 1024 * 1024,
    maxImagePixels: 64 * 1024 * 1024,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  }

  private readonly saved = new Map<string, StoredImageAttachment>()
  private sequence = 0

  override validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.data.byteLength === 0) return Promise.reject(new Error('empty image'))
    return Promise.resolve()
  }

  override async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input)
    this.sequence += 1
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`test-image-${String(this.sequence)}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }
    this.saved.set(ref.attachmentId, { ref, data: new Uint8Array(input.data) })
    return ref
  }

  override readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const stored = this.saved.get(ref.attachmentId)
    if (stored === undefined) return Promise.reject(new Error('missing image'))
    return Promise.resolve({ ref: stored.ref, data: new Uint8Array(stored.data) })
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FsError('aborted', 'FS_ABORTED', { cause: signal.reason })
}
