/**
 * Workspace-backed notebook documents with session-logged state and replaceable kernels.
 * @module @deepseek-ai/dsh-notebook-core
 */

import { Buffer } from 'node:buffer'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type { NotebookEnvironmentId } from '@deepseek-ai/dsh-notebook-environment/types'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { CellId, ExecutionId, NotebookFileVersion, NotebookId } from './brand.ts'
import { foldNotebooks } from './fold.ts'
import { insertIpynbCell, replaceIpynbCellExecution, replaceIpynbCellSource } from './ipynb.ts'
import type { IpynbDocument } from './ipynb.ts'
import type {
  NotebookKernelBackend,
  NotebookKernelExecutionEvent,
  NotebookKernelHandle,
} from './kernel-types.ts'
import type { NotebookKernelOutputMutation } from './kernel-output-types.ts'
import {
  admitNotebookCellContents,
  admitNotebookOutputMutations,
} from './output-admission.ts'
import type { NotebookCellContent } from './output-admission.ts'
import type { NotebookOutputMutation } from './output-types.ts'
import {
  createIpynbFile,
  NotebookPersistenceError,
  prepareIpynbFile,
  replaceIpynbFile,
} from './persistence.ts'
import type { PreparedIpynbFile } from './persistence.ts'
import type {
  CellType,
  FoldedNotebooks,
  NotebookAttachEnvironmentOptions,
  NotebookCell,
  NotebookCellEvent,
  NotebookCreateOptions,
  NotebookDiscoveryOptions,
  NotebookDiscoveryPage,
  NotebookDocument,
  NotebookExecuteEndEvent,
  NotebookExecuteEvent,
  NotebookExecuteOptions,
  NotebookExecuteResult,
  NotebookErrorCode,
  NotebookExecutionStatus,
  NotebookInspectOptions,
  NotebookKernelEvent,
  NotebookKernelRuntimeStatus,
  NotebookOpenEvent,
  NotebookOpenOptions,
  NotebookOutputEvent,
  NotebookReloadEvent,
  NotebookReloadOptions,
  NotebookRestartOptions,
} from './types.ts'
import { discoverNotebookFiles, NotebookDiscoveryError } from './discovery.ts'

export type {
  NotebookKernelAppendOutputMutation,
  NotebookKernelBackend,
  NotebookKernelBase64MimeValue,
  NotebookKernelCellAttachments,
  NotebookKernelDisplayOutput,
  NotebookKernelExecutionEvent,
  NotebookKernelExecuteResultOutput,
  NotebookKernelHandle,
  NotebookKernelJsonMimeValue,
  NotebookKernelMimeBundle,
  NotebookKernelMimeValue,
  NotebookKernelOutput,
  NotebookKernelOutputMutation,
  NotebookKernelStartSpec,
  NotebookKernelTextMimeValue,
  NotebookKernelUpdateDisplayMutation,
} from './kernel-types.ts'
export type {
  CellType,
  FoldedNotebooks,
  NotebookCell,
  NotebookCellEvent,
  NotebookCellSnapshot,
  NotebookCellStatus,
  NotebookAttachEnvironmentOptions,
  NotebookCreateOptions,
  NotebookDiscoveryEntry,
  NotebookDiscoveryOptions,
  NotebookDiscoveryPage,
  NotebookDocument,
  NotebookExecuteEndEvent,
  NotebookExecuteEvent,
  NotebookExecuteOptions,
  NotebookExecuteResult,
  NotebookErrorCode,
  NotebookEnvironmentId,
  NotebookExecutionStatus,
  NotebookInspectOptions,
  NotebookKernelEvent,
  NotebookKernelRuntimeStatus,
  NotebookKernelSelection,
  NotebookOpenEvent,
  NotebookOpenOptions,
  NotebookOutput,
  NotebookOutputEvent,
  NotebookPersistenceErrorCode,
  NotebookReloadEvent,
  NotebookReloadOptions,
  NotebookRestartOptions,
} from './types.ts'
export {
  NotebookPersistenceError,
  createIpynbFile,
  notebookKernelName,
  openIpynbFile,
  normalizeWorkspaceNotebookPath,
  prepareIpynbFile,
  replaceIpynbFile,
} from './persistence.ts'
export { NotebookLogError, foldNotebooks } from './fold.ts'
export { CellId, ExecutionId, NotebookFileVersion, NotebookId } from './brand.ts'
export { MemoryKernelBackend } from './memory-kernel.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    notebooks: NotebookService
  }
}

const DEFAULT_KERNEL_START_TIMEOUT_MS = 30_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000
const DEFAULT_INSPECT_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_DOCUMENT_IMAGES = 256
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_ITEMS = 256
const DEFAULT_MAX_EXECUTION_IMAGES = 64
const DEFAULT_MAX_INSPECT_BYTES = 1024 * 1024
const DEFAULT_DISCOVERY_PAGE_SIZE = 50
const DEFAULT_DISCOVERY_MAX_ENTRIES = 500
const DEFAULT_DISCOVERY_MAX_DEPTH = 12
const DEFAULT_DISCOVERY_EXCLUDES = [
  '.git', '.hg', '.ipynb_checkpoints', '.svn', '.venv', 'node_modules',
] as const
const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024
const MAX_DOCUMENT_IMAGES = 4_096
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_ITEMS = 4_096
const MAX_EXECUTION_IMAGES = 256
const MAX_INSPECT_BYTES = 4 * 1024 * 1024
const MAX_DISCOVERY_PAGE_SIZE = 50
const MAX_DISCOVERY_ENTRIES = 500
const MAX_DISCOVERY_DEPTH = 12
const MIN_RESULT_BYTES = 1024
const CANDIDATE_FILE_VERSION = NotebookFileVersion('candidate-file-version')

/** Notebook workspace, kernel lifecycle, and result-limit configuration. */
export interface Config {
  /** Deadline for starting one unpublished kernel (default 30 seconds). */
  kernelStartTimeoutMs?: number
  /** Whole-operation deadline for a queued kernel execution (default 120 seconds). */
  executionTimeoutMs?: number
  /** Whole-operation deadline for a queued kernel inspection (default 30 seconds). */
  inspectTimeoutMs?: number
  /** Deadline for Cordis teardown to report failure while retaining unfinished kernel joins (default 10 seconds). */
  shutdownTimeoutMs?: number
  /** Maximum complete `.ipynb` UTF-8 bytes read or written (default 64 MiB, hard maximum 256 MiB). */
  maxDocumentBytes?: number
  /** Maximum distinct raster payloads admitted from one document (default 256, hard maximum 4096). */
  maxDocumentImages?: number
  /** Maximum serialized UTF-8 bytes returned by one execution (default 16 MiB, hard maximum 64 MiB). */
  maxOutputBytes?: number
  /** Maximum kernel output mutations accepted from one execution (default 256, hard maximum 4096). */
  maxOutputItems?: number
  /** Maximum distinct raster payloads admitted from one execution (default 64, hard maximum 256). */
  maxExecutionImages?: number
  /** Maximum UTF-8 bytes returned by one inspection (default 1 MiB, hard maximum 4 MiB). */
  maxInspectBytes?: number
  /** Maximum notebook files returned per discovery page (default and hard maximum 50). */
  discoveryPageSize?: number
  /** Maximum directory entries examined by one discovery request (default and hard maximum 500). */
  discoveryMaxEntries?: number
  /** Maximum recursive directory depth below the workspace root (default and hard maximum 12). */
  discoveryMaxDepth?: number
  /** Directory basenames pruned from workspace discovery at every depth. */
  discoveryExcludeDirectoryNames?: string[]
}

/** Schemastery configuration for the notebook service. */
export const Config: z<Config> = z.object({
  kernelStartTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_KERNEL_START_TIMEOUT_MS),
  executionTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_EXECUTION_TIMEOUT_MS),
  inspectTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_INSPECT_TIMEOUT_MS),
  shutdownTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  maxDocumentBytes: z.number().step(1).min(1).max(MAX_DOCUMENT_BYTES).default(DEFAULT_MAX_DOCUMENT_BYTES),
  maxDocumentImages: z.number().step(1).min(0).max(MAX_DOCUMENT_IMAGES).default(DEFAULT_MAX_DOCUMENT_IMAGES),
  maxOutputBytes: z.number().step(1).min(MIN_RESULT_BYTES).max(MAX_OUTPUT_BYTES).default(DEFAULT_MAX_OUTPUT_BYTES),
  maxOutputItems: z.number().step(1).min(1).max(MAX_OUTPUT_ITEMS).default(DEFAULT_MAX_OUTPUT_ITEMS),
  maxExecutionImages: z.number().step(1).min(0).max(MAX_EXECUTION_IMAGES).default(DEFAULT_MAX_EXECUTION_IMAGES),
  maxInspectBytes: z.number().step(1).min(1).max(MAX_INSPECT_BYTES).default(DEFAULT_MAX_INSPECT_BYTES),
  discoveryPageSize: z.number().step(1).min(1).max(MAX_DISCOVERY_PAGE_SIZE).default(DEFAULT_DISCOVERY_PAGE_SIZE),
  discoveryMaxEntries: z.number().step(1).min(1).max(MAX_DISCOVERY_ENTRIES).default(DEFAULT_DISCOVERY_MAX_ENTRIES),
  discoveryMaxDepth: z.number().step(1).min(0).max(MAX_DISCOVERY_DEPTH).default(DEFAULT_DISCOVERY_MAX_DEPTH),
  discoveryExcludeDirectoryNames: z.array(z.string()).default([...DEFAULT_DISCOVERY_EXCLUDES]),
})

interface ResolvedConfig {
  readonly kernelStartTimeoutMs: number
  readonly executionTimeoutMs: number
  readonly inspectTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly maxDocumentBytes: number
  readonly maxDocumentImages: number
  readonly maxOutputBytes: number
  readonly maxOutputItems: number
  readonly maxExecutionImages: number
  readonly maxInspectBytes: number
  readonly discoveryPageSize: number
  readonly discoveryMaxEntries: number
  readonly discoveryMaxDepth: number
  readonly discoveryExcludeDirectoryNames: ReadonlySet<string>
}

interface BackendRegistration {
  readonly backend: NotebookKernelBackend
  readonly controller: AbortController
  readonly records: Set<KernelRecord>
  retirePromise?: Promise<void>
}

interface SessionRuntime {
  readonly session: Session
  readonly controller: AbortController
  readonly kernels: Map<NotebookId, KernelRecord>
  readonly pendingStarts: Set<PendingStart>
  readonly retiring: Map<NotebookId, KernelRetirement>
  readonly files: Map<NotebookId, FileState>
  readonly targetOwners: Map<string, NotebookId>
  readonly openings: Map<string, Promise<NotebookDocument>>
  readonly documentTails: Map<NotebookId, Promise<void>>
  readonly recoveries: Map<NotebookId, Promise<KernelRecord>>
  readonly kernelFailures: Set<NotebookId>
  readonly reservedIds: Set<string>
  cleanupPromise?: Promise<void>
}

interface FileState {
  readonly target: FsTarget
  readonly document: IpynbDocument
  readonly version: FsVersion
}

interface ProjectionCache {
  readonly events: readonly SessionEvent[]
  readonly lastEvent: SessionEvent | undefined
  readonly projection: FoldedNotebooks
}

interface KernelRecord {
  readonly runtime: SessionRuntime
  readonly notebookId: NotebookId
  readonly registration: BackendRegistration
  readonly handle: NotebookKernelHandle
  readonly environmentId: NotebookEnvironmentId
  readonly backend: string
  readonly kernelName?: string
  readonly sandboxPolicy: SandboxExecutionPolicy
  readonly controller: AbortController
  state: 'active' | 'closing' | 'shutdown-failed' | 'closed'
  tail: Promise<void>
  retirement?: KernelRetirement
  activeExecution?: {
    readonly executionId: ExecutionId
    readonly controller: AbortController
  }
}

interface KernelRetirement {
  readonly joined: Promise<void>
  readonly outcome: Promise<void>
}

interface PendingStart {
  readonly registration: BackendRegistration
  readonly notebookId: NotebookId
  readonly sandboxPolicy: SandboxExecutionPolicy
  readonly controller: AbortController
  readonly promise: Promise<KernelRecord>
}

interface ExecutionOutcome {
  readonly result: NotebookExecuteResult
  readonly retireReason?: Error
}

interface RestartOutcome {
  readonly document: NotebookDocument
  readonly prior?: KernelRecord
}

type NotebookEventSpec =
  | { readonly type: 'notebook/open'; readonly data: NotebookOpenEvent }
  | { readonly type: 'notebook/cell'; readonly data: NotebookCellEvent }
  | { readonly type: 'notebook/execute'; readonly data: NotebookExecuteEvent }
  | { readonly type: 'notebook/output'; readonly data: NotebookOutputEvent }
  | { readonly type: 'notebook/execute-end'; readonly data: NotebookExecuteEndEvent }
  | { readonly type: 'notebook/kernel'; readonly data: NotebookKernelEvent }
  | { readonly type: 'notebook/reload'; readonly data: NotebookReloadEvent }

/** Error carrying a stable {@link NotebookErrorCode}. */
export class NotebookError extends Error {
  /**
   * @param message - actionable failure detail.
   * @param code - stable failure category.
   */
  constructor(message: string, readonly code: NotebookErrorCode) {
    super(message)
    this.name = 'NotebookError'
  }
}

/** Workspace-backed notebook registry and kernel lifecycle owner. */
export class NotebookService extends Service {
  static inject = ['attachments', 'fs', 'sandboxPolicy']
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly backends = new Map<string, BackendRegistration>()
  private readonly runtimes = new WeakMap<Session, SessionRuntime>()
  private readonly projections = new WeakMap<Session, ProjectionCache>()
  private readonly liveRuntimes = new Set<SessionRuntime>()
  private readonly disposedSessions = new WeakSet<Session>()
  // Bounded retirement outcomes may settle before shutdown joins; joins remain owned until true quiescence.
  private readonly retiring = new Set<Promise<void>>()
  private readonly shutdownJoins = new Set<Promise<void>>()
  private readonly lifecycle = new AbortController()
  private disposing = false
  private disposePromise?: Promise<void>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'notebooks')
    this.config = resolveConfig(config)
    ctx.on('session/disposed', (session) => {
      const cleanup = this.disposeSession(session)
      void cleanup.catch((error: unknown) => {
        this.ctx.logger.warn(
          `notebook session ${JSON.stringify(session.id)} teardown failed: ${errorText(error)}`,
        )
      })
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'sandbox/mode') this.handleSandboxPolicyChange(session)
    })
    ctx.effect(() => () => this.disposeAll(), 'notebook teardown')
  }

  /**
   * Register one kernel backend for this effect scope.
   * @param backend - provider with a non-empty unique type.
   * @returns disposer that removes exactly this contribution and retires its kernels.
   */
  registerBackend(backend: NotebookKernelBackend): () => void {
    this.assertActive()
    if (backend.type.length === 0) throw new Error('notebook backend type must be non-empty')
    if (this.backends.has(backend.type)) {
      throw new NotebookError(
        `a notebook backend named ${JSON.stringify(backend.type)} is already registered`,
        'DUPLICATE_BACKEND',
      )
    }
    const registration: BackendRegistration = {
      backend,
      controller: new AbortController(),
      records: new Set(),
    }
    const owned = this.ctx.effect(() => {
      this.backends.set(backend.type, registration)
      return () => this.retireRegistration(registration)
    }, 'notebook.registerBackend()')
    return () => {
      void Promise.resolve(owned()).catch((error: unknown) => {
        this.ctx.logger.warn(
          `notebook backend ${JSON.stringify(backend.type)} teardown failed: ${errorText(error)}`,
        )
      })
    }
  }

  /**
   * List registered backend types in registration order.
   * @returns fresh backend type names.
   */
  listBackends(): string[] {
    return [...this.backends.keys()]
  }

  private prepareFile(session: Session, path: string, signal: AbortSignal): Promise<PreparedIpynbFile> {
    return prepareIpynbFile({
      fs: this.ctx.fs,
      path,
      ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
      signal,
      maxDocumentBytes: this.config.maxDocumentBytes,
    })
  }

  private trackOpening(
    runtime: SessionRuntime,
    targetKey: string,
    opening: Promise<NotebookDocument>,
  ): void {
    runtime.openings.set(targetKey, opening)
    const release = (): void => {
      if (runtime.openings.get(targetKey) === opening) runtime.openings.delete(targetKey)
    }
    void opening.then(release, release)
  }

  /**
   * Open one existing workspace `.ipynb` without selecting or starting a kernel.
   * Canonical aliases in the same session coalesce to one document.
   * @param session - exact owning session instance.
   * @param path - normalized workspace-relative notebook path.
   * @param options - cancellation for the stable read and publication.
   * @returns the complete document reconstructed from committed session events.
   */
  async open(session: Session, path: string, options: NotebookOpenOptions = {}): Promise<NotebookDocument> {
    const runtime = this.runtimeFor(session)
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_OPEN_TIMEOUT',
    )
    const prepared = await this.prepareFile(session, path, operation.signal)
    if (prepared.existing === undefined) {
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(prepared.path)} does not exist`,
        'NOT_FOUND',
      )
    }
    const targetKey = String(prepared.target.targetKey)
    const owner = await this.findCanonicalOwner(runtime, prepared, operation.signal)
    if (owner !== undefined) {
      await this.refreshFile(runtime, this.requireNotebook(session, owner.id), operation.signal)
      return this.requireNotebook(session, owner.id)
    }
    const inFlight = runtime.openings.get(targetKey)
    if (inFlight !== undefined) {
      return await awaitWithAbort(inFlight, operation.signal)
    }
    const opening = this.openPreparedOwned(runtime, prepared, false)
    this.trackOpening(runtime, targetKey, opening)
    return await awaitWithAbort(opening, operation.signal)
  }

  /**
   * Guardedly create one absent workspace `.ipynb` without selecting a kernel.
   * @param session - exact owning session instance.
   * @param path - normalized workspace-relative notebook path.
   * @param options - cancellation for absence observation and guarded creation.
   * @returns the newly created document reconstructed from committed events.
   */
  async create(session: Session, path: string, options: NotebookCreateOptions = {}): Promise<NotebookDocument> {
    const runtime = this.runtimeFor(session)
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_CREATE_TIMEOUT',
    )
    const prepared = await this.prepareFile(session, path, operation.signal)
    if (prepared.existing !== undefined) {
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(prepared.path)} already exists`,
        'ALREADY_EXISTS',
      )
    }
    const targetKey = String(prepared.target.targetKey)
    const inFlight = runtime.openings.get(targetKey)
    if (inFlight !== undefined) {
      await awaitWithAbort(inFlight, operation.signal)
      throw new NotebookPersistenceError(
        `notebook ${JSON.stringify(prepared.path)} already exists`,
        'ALREADY_EXISTS',
      )
    }
    const opening = this.openPreparedOwned(runtime, prepared, true)
    this.trackOpening(runtime, targetKey, opening)
    return await awaitWithAbort(opening, operation.signal)
  }

  /**
   * Read one notebook document from the session log.
   * @param session - owning session.
   * @param notebookId - target notebook identity.
   * @returns the folded notebook document.
   */
  get(session: Session, notebookId: NotebookId): NotebookDocument {
    return this.requireNotebook(session, notebookId)
  }

  /**
   * List notebook documents visible in one session log.
   * @param session - owning session.
   * @returns documents in first-open order.
   */
  list(session: Session): NotebookDocument[] {
    return [...this.projection(session).notebooks]
  }

  /**
   * Discover a bounded page of `.ipynb` files beneath the session workspace.
   * File content is never opened or decoded by discovery.
   * @param session - session whose working directory is the discovery root.
   * @param options - exact continuation path and cancellation.
   * @returns stable traversal results plus partial and continuation state.
   */
  async discoverWorkspace(
    session: Session,
    options: NotebookDiscoveryOptions = {},
  ): Promise<NotebookDiscoveryPage> {
    this.assertActive()
    try {
      return await discoverNotebookFiles(
        this.ctx.fs,
        session.header.cwd,
        {
          pageSize: this.config.discoveryPageSize,
          maxEntries: this.config.discoveryMaxEntries,
          maxDepth: this.config.discoveryMaxDepth,
          excludeDirectoryNames: this.config.discoveryExcludeDirectoryNames,
        },
        options,
      )
    } catch (error: unknown) {
      if (error instanceof NotebookDiscoveryError) {
        throw new NotebookError(error.message, error.code)
      }
      throw error
    }
  }

  /**
   * Query process-local kernel state without mutating durable notebook state.
   * Failed state carries a path-free summary instead of the provider exception.
   * @param session - owning session.
   * @param notebookId - target document identity.
   * @returns detached, starting, ready, running, stopped, or failed state.
   */
  runtimeStatus(session: Session, notebookId: NotebookId): NotebookKernelRuntimeStatus {
    const notebook = this.requireNotebook(session, notebookId)
    if (notebook.kernel === undefined) return { status: 'detached' }
    const runtime = this.runtimes.get(session)
    const environmentId = notebook.kernel.environmentId
    if (runtime === undefined) return { status: 'stopped', environmentId }
    if ([...runtime.pendingStarts].some(start => start.notebookId === notebookId)) {
      return { status: 'starting', environmentId }
    }
    const live = runtime.kernels.get(notebookId)
    if (live !== undefined && live.state === 'active') {
      return {
        status: live.activeExecution === undefined ? 'ready' : 'running',
        environmentId,
      }
    }
    return !runtime.kernelFailures.has(notebookId)
      ? { status: 'stopped', environmentId }
      : { status: 'failed', environmentId, message: 'kernel failed to start' }
  }

  /**
   * Atomically replace one cell's source before publishing its session event.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param cellId - target cell identity.
   * @param source - complete replacement source.
   * @param signal - optional cancellation for queue wait, read, and CAS write.
   * @returns the updated folded document.
   */
  async editCell(
    session: Session,
    notebookId: NotebookId,
    cellId: CellId,
    source: string,
    signal?: AbortSignal,
  ): Promise<NotebookDocument> {
    const runtime = this.runtimeFor(session)
    const initial = this.requireNotebook(session, notebookId)
    this.requireCell(initial, cellId)
    using operation = deadline(
      this.runtimeSignal(runtime, signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_FILE_MUTATION_TIMEOUT',
    )
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    return await this.enqueueDocument(runtime, notebookId, operation.signal, async (taskSignal) => {
      const notebook = this.requireNotebook(session, notebookId)
      const cell = this.requireCell(notebook, cellId)
      const file = await this.refreshFile(runtime, notebook, taskSignal)
      const document = replaceIpynbCellSource(file.document, cellId, source)
      const index = notebook.cells.findIndex(entry => entry.id === cellId)
      const candidate: NotebookEventSpec = {
        type: 'notebook/cell',
        data: {
          notebookId,
          cellId,
          cellType: cell.cellType,
          source,
          index,
          operation: 'update',
          fileVersion: CANDIDATE_FILE_VERSION,
        },
      }
      return await this.commitCellMutation(
        runtime,
        file,
        document,
        candidate,
        policy,
        taskSignal,
      )
    })
  }

  /**
   * Insert one cell immediately after an anchor, or at index zero without one.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param cellType - native nbformat cell kind.
   * @param afterCellId - preceding cell identity; omitted inserts first.
   * @param source - optional initial source.
   * @param signal - optional cancellation for queue wait, read, and CAS write.
   * @returns the updated folded document.
   */
  async insertCell(
    session: Session,
    notebookId: NotebookId,
    cellType: CellType,
    afterCellId?: CellId,
    source: string = '',
    signal?: AbortSignal,
  ): Promise<NotebookDocument> {
    const runtime = this.runtimeFor(session)
    const initial = this.requireNotebook(session, notebookId)
    if (afterCellId !== undefined) this.requireCell(initial, afterCellId)
    using operation = deadline(
      this.runtimeSignal(runtime, signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_FILE_MUTATION_TIMEOUT',
    )
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const cellId = CellId(this.reserveId(runtime, 'cell'))
    try {
      return await this.enqueueDocument(runtime, notebookId, operation.signal, async (taskSignal) => {
        const notebook = this.requireNotebook(session, notebookId)
        const index = afterCellId === undefined
          ? 0
          : notebook.cells.findIndex(entry => entry.id === afterCellId) + 1
        if (index === 0 && afterCellId !== undefined) {
          throw new NotebookError(`unknown notebook cell ${afterCellId}`, 'NOT_FOUND')
        }
        const file = await this.refreshFile(runtime, notebook, taskSignal)
        const document = insertIpynbCell(file.document, index, { id: cellId, cellType, source, metadata: {} })
        const candidate: NotebookEventSpec = {
          type: 'notebook/cell',
          data: {
            notebookId,
            cellId,
            cellType,
            source,
            index,
            operation: 'create',
            metadata: {},
            attachments: {},
            ...cellType === 'code' ? { outputs: [] } : {},
            fileVersion: CANDIDATE_FILE_VERSION,
          },
        }
        return await this.commitCellMutation(
          runtime,
          file,
          document,
          candidate,
          policy,
          taskSignal,
        )
      })
    } finally {
      runtime.reservedIds.delete(cellId)
    }
  }

  private async commitCellMutation(
    runtime: SessionRuntime,
    file: FileState,
    document: IpynbDocument,
    candidate: Extract<NotebookEventSpec, { readonly type: 'notebook/cell' }>,
    policy: SandboxExecutionPolicy,
    signal: AbortSignal,
  ): Promise<NotebookDocument> {
    this.preflight(runtime.session, [candidate])
    const replaced = await replaceIpynbFile({
      fs: this.ctx.fs,
      target: file.target,
      document,
      version: file.version,
      sandboxPolicy: policy,
      signal,
      maxDocumentBytes: this.config.maxDocumentBytes,
    })
    const committed = {
      ...candidate,
      data: { ...candidate.data, fileVersion: fileVersion(replaced.version) },
    }
    this.preflight(runtime.session, [committed])
    this.appendSpecs(runtime.session, [committed])
    runtime.files.set(candidate.data.notebookId, {
      target: file.target,
      document,
      version: replaced.version,
    })
    return this.requireNotebook(runtime.session, candidate.data.notebookId)
  }

  /**
   * Execute one code cell with a serialized per-kernel state transition.
   * Different notebook kernels remain independently runnable.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param cellId - target code-cell identity.
   * @param options - initiator and optional cancellation.
   * @returns bounded durable outputs and an explicit terminal outcome.
   */
  async execute(
    session: Session,
    notebookId: NotebookId,
    cellId: CellId,
    options: NotebookExecuteOptions,
  ): Promise<NotebookExecuteResult> {
    const runtime = this.runtimeFor(session)
    const initial = this.requireNotebook(session, notebookId)
    const cell = this.requireCell(initial, cellId)
    if (cell.cellType !== 'code') {
      throw new NotebookError(`cell ${cellId} is not executable`, 'NOT_CODE_CELL')
    }
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_EXECUTION_TIMEOUT',
    )
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const kernel = await this.ensureKernel(runtime, initial, options.initiator, policy, operation.signal)
    const executionId = ExecutionId(this.reserveId(runtime, 'exec'))
    try {
      let outcome: ExecutionOutcome
      try {
        outcome = await this.enqueue(kernel, operation.signal, taskSignal => (
          this.executeWithCurrentPolicy(
            runtime,
            kernel,
            cellId,
            executionId,
            options.initiator,
            taskSignal,
          )
        ))
      } catch (error: unknown) {
        if (kernel.state !== 'active') await this.retireKernel(kernel, asError(error))
        throw error
      }
      if (outcome.retireReason !== undefined) await this.retireKernel(kernel, outcome.retireReason)
      return outcome.result
    } finally {
      runtime.reservedIds.delete(executionId)
    }
  }

  /**
   * Inspect one kernel name without exposing unbounded backend text.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param name - variable or symbol name.
   * @param options - initiator and cancellation for recovery, queue wait, and inspection.
   * @returns bounded backend-specific text.
   */
  async inspect(
    session: Session,
    notebookId: NotebookId,
    name: string,
    options: NotebookInspectOptions,
  ): Promise<string> {
    const runtime = this.runtimeFor(session)
    if (name.length === 0) throw new Error('inspect name must be non-empty')
    const notebook = this.requireNotebook(session, notebookId)
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.inspectTimeoutMs,
      'NOTEBOOK_INSPECT_TIMEOUT',
    )
    const policy = this.ctx.sandboxPolicy.resolve({ session })
    const kernel = await this.ensureKernel(runtime, notebook, options.initiator, policy, operation.signal)
    try {
      return await this.enqueue(kernel, operation.signal, async (taskSignal) => {
        this.assertKernelPolicy(kernel, this.ctx.sandboxPolicy.resolve({ session }))
        let text: string
        try {
          text = await awaitWithAbort(
            kernel.registration.backend.inspect(kernel.handle, name, taskSignal),
            taskSignal,
          )
        } catch (error: unknown) {
          this.markClosing(kernel, asError(error))
          throw error
        }
        if (Buffer.byteLength(text) > this.config.maxInspectBytes) {
          throw new NotebookError(
            `kernel inspection exceeds maxInspectBytes (${String(this.config.maxInspectBytes)})`,
            'OUTPUT_LIMIT',
          )
        }
        return text
      })
    } catch (error: unknown) {
      if (kernel.state !== 'active') await this.retireKernel(kernel, asError(error))
      throw error
    }
  }

  /**
   * Select an environment and publish it only after its kernel starts successfully.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param environmentId - opaque provider-owned environment identity.
   * @param options - trusted backend selection, initiator, kernelspec, and cancellation.
   * @returns the document with its newly committed kernel selection.
   */
  async attachEnvironment(
    session: Session,
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    options: NotebookAttachEnvironmentOptions,
  ): Promise<NotebookDocument> {
    assertOptionalName(options.backend, 'backend')
    assertOptionalName(options.kernelName, 'kernelName')
    if (environmentId.length === 0) throw new Error('environmentId must be non-empty')
    const runtime = this.runtimeFor(session)
    this.requireNotebook(session, notebookId)
    const registration = this.selectBackend(options.backend)
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_ATTACH_TIMEOUT',
    )
    return await this.replaceSelectedKernel(
      runtime,
      notebookId,
      environmentId,
      registration.backend.type,
      options.kernelName,
      options.initiator,
      operation.signal,
    )
  }

  /**
   * Replace the selected environment's idle kernel and advance its generation.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param options - initiator and optional cancellation.
   * @returns the document after the successful replacement is published.
   */
  async restart(
    session: Session,
    notebookId: NotebookId,
    options: NotebookRestartOptions,
  ): Promise<NotebookDocument> {
    const runtime = this.runtimeFor(session)
    const notebook = this.requireNotebook(session, notebookId)
    if (notebook.kernel === undefined) throw environmentRequired(notebook)
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_RESTART_TIMEOUT',
    )
    return await this.replaceSelectedKernel(
      runtime,
      notebookId,
      notebook.kernel.environmentId,
      notebook.kernel.backend,
      notebook.kernel.kernelName,
      options.initiator,
      operation.signal,
    )
  }

  private async replaceSelectedKernel(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    backend: string,
    kernelName: string | undefined,
    initiator: 'agent' | 'user',
    signal: AbortSignal,
  ): Promise<NotebookDocument> {
    const policy = this.ctx.sandboxPolicy.resolve({ session: runtime.session })
    const live = await this.activeKernelForPolicy(runtime, notebookId, policy)
    if (live !== undefined && live.state === 'active') {
      const outcome = await this.enqueue(live, signal, taskSignal => this.publishReplacementKernel(
        runtime,
        notebookId,
        environmentId,
        backend,
        kernelName,
        initiator,
        policy,
        taskSignal,
        live,
      ))
      if (outcome.prior !== undefined) {
        await this.retireKernel(outcome.prior, new Error('notebook kernel was replaced'))
      }
      return outcome.document
    }
    const retiring = runtime.retiring.get(notebookId)
    if (retiring !== undefined) await awaitWithAbort(retiring.joined, signal)
    const outcome = await this.publishReplacementKernel(
      runtime,
      notebookId,
      environmentId,
      backend,
      kernelName,
      initiator,
      policy,
      signal,
    )
    return outcome.document
  }

  private async publishReplacementKernel(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    backend: string,
    kernelName: string | undefined,
    initiator: 'agent' | 'user',
    policy: SandboxExecutionPolicy,
    signal: AbortSignal,
    prior?: KernelRecord,
  ): Promise<RestartOutcome> {
    const registration = this.requireBackend(backend)
    let replacement: KernelRecord | undefined
    try {
      replacement = await this.startKernelRecord(
        runtime,
        notebookId,
        environmentId,
        backend,
        kernelName,
        registration,
        policy,
        signal,
      )
      const notebook = this.requireNotebook(runtime.session, notebookId)
      const spec = kernelSpec(notebook, environmentId, backend, kernelName, initiator)
      this.preflight(runtime.session, [spec])
      this.assertPublishableKernel(replacement)
      const existing = runtime.kernels.get(notebookId)
      if ((prior === undefined && existing !== undefined) || (prior !== undefined && existing !== prior)) {
        throw new NotebookError(`kernel ${notebookId} was concurrently replaced`, 'KERNEL_UNAVAILABLE')
      }
      runtime.kernels.set(notebookId, replacement)
      runtime.kernelFailures.delete(notebookId)
      try {
        this.appendSpecs(runtime.session, [spec])
      } catch (error: unknown) {
        if (runtime.kernels.get(notebookId) === replacement) {
          if (prior === undefined) runtime.kernels.delete(notebookId)
          else runtime.kernels.set(notebookId, prior)
        }
        throw error
      }
      if (prior !== undefined) this.markClosing(prior, new Error('notebook kernel was replaced'))
      return {
        document: this.requireNotebook(runtime.session, notebookId),
        ...(prior === undefined ? {} : { prior }),
      }
    } catch (error: unknown) {
      if (prior === undefined) runtime.kernelFailures.add(notebookId)
      if (replacement !== undefined && runtime.kernels.get(notebookId) !== replacement) {
        try {
          await this.closeUnpublished(replacement, asError(error))
        } catch (cleanupError: unknown) {
          throw new AggregateError([error, cleanupError], 'notebook kernel publication rollback failed')
        }
      }
      throw error
    }
  }

  /**
   * Accept the current external `.ipynb` revision as one atomic document snapshot.
   * The selected environment is retained while any live kernel is retired after publication.
   * @param session - exact owning session instance.
   * @param notebookId - document identity retained by the reload.
   * @param options - initiator and optional cancellation.
   * @returns the reloaded folded document.
   */
  async reload(
    session: Session,
    notebookId: NotebookId,
    options: NotebookReloadOptions,
  ): Promise<NotebookDocument> {
    const runtime = this.runtimeFor(session)
    this.requireNotebook(session, notebookId)
    using operation = deadline(
      this.runtimeSignal(runtime, options.signal),
      this.config.executionTimeoutMs,
      'NOTEBOOK_RELOAD_TIMEOUT',
    )
    return await this.enqueueDocument(runtime, notebookId, operation.signal, taskSignal => (
      this.reloadWithoutActiveExecution(runtime, notebookId, options, taskSignal)
    ))
  }

  private async reloadWithoutActiveExecution(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    options: NotebookReloadOptions,
    signal: AbortSignal,
  ): Promise<NotebookDocument> {
    const session = runtime.session
    const notebook = this.requireNotebook(session, notebookId)
    if (runtime.kernels.get(notebookId)?.activeExecution !== undefined) {
      throw new NotebookError('notebook cannot reload during an active execution', 'KERNEL_UNAVAILABLE')
    }
    const previousFile = runtime.files.get(notebookId)
    const previousOwners = new Map(runtime.targetOwners)
    const observed = await prepareIpynbFile({
      fs: this.ctx.fs,
      path: notebook.path,
      ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
      signal,
      maxDocumentBytes: this.config.maxDocumentBytes,
    })
    if (observed.existing === undefined) throw persistenceConflict(notebook.path)
    const document = observed.existing.document
    const contents = await admitNotebookCellContents(
      this.ctx.attachments,
      document.cells.map(cell => ({ outputs: cell.outputs, attachments: cell.attachments })),
      this.config.maxDocumentImages,
      signal,
    )
    const spec = reloadSpec(
      notebook,
      options,
      fileVersion(observed.existing.version),
      document,
      contents,
    )
    this.preflight(session, [spec])
    const finalStat = await this.ctx.fs.stat(observed.target, signal)
    if (finalStat?.type !== 'file' || finalStat.version !== observed.existing.version) {
      throw persistenceConflict(notebook.path)
    }
    const targetKey = String(observed.target.targetKey)
    const owner = runtime.targetOwners.get(targetKey)
    if (owner !== undefined && owner !== notebookId) {
      throw persistenceConflict(notebook.path)
    }
    const live = runtime.kernels.get(notebookId)
    if (live?.activeExecution !== undefined) {
      throw new NotebookError('notebook cannot reload during an active execution', 'KERNEL_UNAVAILABLE')
    }
    runtime.files.set(notebookId, {
      target: observed.target,
      document,
      version: observed.existing.version,
    })
    runtime.targetOwners.set(targetKey, notebookId)
    try {
      this.appendSpecs(session, [spec])
    } catch (error: unknown) {
      if (previousFile === undefined) runtime.files.delete(notebookId)
      else runtime.files.set(notebookId, previousFile)
      runtime.targetOwners.clear()
      for (const [key, owner] of previousOwners) runtime.targetOwners.set(key, owner)
      throw error
    }
    if (live !== undefined) {
      void this.retireKernel(live, new Error('notebook document was reloaded'))
    }
    return this.requireNotebook(session, notebookId)
  }

  /**
   * Cancel the active execution for one exact session/notebook kernel.
   * @param session - exact owning session instance.
   * @param notebookId - target notebook identity.
   * @param reason - optional cancellation text persisted by the terminal outcome.
   * @returns true only when an active execution was newly interrupted.
   */
  interrupt(session: Session, notebookId: NotebookId, reason?: string): boolean {
    const runtime = this.runtimes.get(session)
    if (runtime === undefined || this.disposedSessions.has(session)) return false
    const active = runtime.kernels.get(notebookId)?.activeExecution
    if (active === undefined || active.controller.signal.aborted) return false
    active.controller.abort(new Error(reason === undefined || reason.length === 0
      ? 'notebook execution interrupted'
      : reason))
    return true
  }

  private async openPrepared(
    runtime: SessionRuntime,
    prepared: PreparedIpynbFile,
    create: boolean,
    signal: AbortSignal,
  ): Promise<NotebookDocument> {
    const notebookId = NotebookId(this.reserveId(runtime, 'notebook'))
    const initialCellId = create ? CellId(this.reserveId(runtime, 'cell')) : undefined
    try {
      const initialDocument = prepared.existing?.document
      if (!create && initialDocument === undefined) {
        throw new NotebookPersistenceError(
          `notebook ${JSON.stringify(prepared.path)} does not exist`,
          'NOT_FOUND',
        )
      }
      const policy = this.ctx.sandboxPolicy.resolve({ session: runtime.session })
      let file: FileState
      if (create) {
        if (prepared.existing !== undefined || initialCellId === undefined) {
          throw new NotebookPersistenceError(
            `notebook ${JSON.stringify(prepared.path)} already exists`,
            'ALREADY_EXISTS',
          )
        }
        const created = await createIpynbFile({
          fs: this.ctx.fs,
          target: prepared.target,
          initialCellId,
          sandboxPolicy: policy,
          signal,
          maxDocumentBytes: this.config.maxDocumentBytes,
        })
        file = { target: created.target, document: created.document, version: created.version }
      } else {
        const existing = prepared.existing as NonNullable<PreparedIpynbFile['existing']>
        file = { target: prepared.target, document: existing.document, version: existing.version }
      }
      const contents = await admitNotebookCellContents(
        this.ctx.attachments,
        file.document.cells.map(cell => ({ outputs: cell.outputs, attachments: cell.attachments })),
        this.config.maxDocumentImages,
        signal,
      )
      const candidate = openSpecs(
        notebookId,
        prepared.path,
        CANDIDATE_FILE_VERSION,
        file.document,
        contents,
      )
      this.preflight(runtime.session, candidate)
      const confirmed = await this.ctx.fs.stat(file.target, signal)
      if (confirmed?.type !== 'file' || confirmed.version !== file.version) {
        throw persistenceConflict(prepared.path)
      }
      const committed = openSpecs(
        notebookId,
        prepared.path,
        fileVersion(file.version),
        file.document,
        contents,
      )
      this.preflight(runtime.session, committed)
      this.assertRuntimeActive(runtime)
      runtime.files.set(notebookId, file)
      runtime.targetOwners.set(String(file.target.targetKey), notebookId)
      try {
        this.appendSpecs(runtime.session, committed)
      } catch (error: unknown) {
        runtime.files.delete(notebookId)
        if (runtime.targetOwners.get(String(file.target.targetKey)) === notebookId) {
          runtime.targetOwners.delete(String(file.target.targetKey))
        }
        throw error
      }
      return this.requireNotebook(runtime.session, notebookId)
    } finally {
      runtime.reservedIds.delete(notebookId)
      if (initialCellId !== undefined) runtime.reservedIds.delete(initialCellId)
    }
  }

  private async openPreparedOwned(
    runtime: SessionRuntime,
    prepared: PreparedIpynbFile,
    create: boolean,
  ): Promise<NotebookDocument> {
    using shared = deadline(
      this.runtimeSignal(runtime),
      this.config.executionTimeoutMs,
      create ? 'NOTEBOOK_CREATE_TIMEOUT' : 'NOTEBOOK_OPEN_TIMEOUT',
    )
    return await this.openPrepared(runtime, prepared, create, shared.signal)
  }

  private executeWithCurrentPolicy(
    runtime: SessionRuntime,
    kernel: KernelRecord,
    cellId: CellId,
    executionId: ExecutionId,
    initiator: 'agent' | 'user',
    taskSignal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const policy = this.ctx.sandboxPolicy.resolve({ session: runtime.session })
    this.assertKernelPolicy(kernel, policy)
    return this.executeInKernel(runtime, kernel, cellId, executionId, initiator, policy, taskSignal)
  }

  private async executeInKernel(
    runtime: SessionRuntime,
    kernel: KernelRecord,
    cellId: CellId,
    executionId: ExecutionId,
    initiator: 'agent' | 'user',
    policy: SandboxExecutionPolicy,
    taskSignal: AbortSignal,
  ): Promise<ExecutionOutcome> {
    const session = runtime.session
    const notebook = this.requireNotebook(session, kernel.notebookId)
    const cell = this.requireCell(notebook, cellId)
    const file = await this.refreshFile(runtime, notebook, taskSignal)
    const executionController = new AbortController()
    kernel.activeExecution = { executionId, controller: executionController }
    const runSignal = AbortSignal.any([taskSignal, executionController.signal])
    const rawMutations: NotebookKernelOutputMutation[] = []
    let status: NotebookExecutionStatus = 'ok'
    let executionCount: number | null = null
    let error: string | undefined
    let retireReason: Error | undefined
    try {
      const iterator = kernel.registration.backend.execute(kernel.handle, cell.source, runSignal)[Symbol.asyncIterator]()
      let completion: Extract<NotebookKernelExecutionEvent, { readonly type: 'complete' }> | undefined
      while (true) {
        const step = await awaitWithAbort(iterator.next(), runSignal)
        if (step.done) break
        const event = step.value
        switch (event.type) {
          case 'output':
            if (completion !== undefined) throw new Error('kernel emitted output after its terminal event')
            this.acceptRawMutation(executionId, rawMutations, event.mutation)
            break
          case 'complete':
            if (completion !== undefined) throw new Error('kernel emitted more than one terminal event')
            if (!Number.isSafeInteger(event.executionCount) || event.executionCount < 0) {
              throw new Error('kernel executionCount must be a non-negative safe integer')
            }
            if (event.status === 'error' && event.error.length === 0) {
              throw new Error('kernel error terminal event requires non-empty error text')
            }
            completion = event
            break
          default:
            assertNever(event)
        }
      }
      if (completion === undefined) throw new Error('kernel execution ended without a terminal event')
      status = completion.status
      executionCount = completion.executionCount
      if (completion.status === 'error') error = completion.error
    } catch (runError: unknown) {
      status = runSignal.aborted ? 'cancelled' : 'error'
      executionCount = null
      error = executionFailureText(runError, runSignal)
      retireReason = asError(runError)
    } finally {
      if (kernel.activeExecution.executionId === executionId) delete kernel.activeExecution
    }

    let terminalError = status === 'ok'
      ? undefined
      : truncateUtf8(error ?? 'kernel execution failed', Math.max(1, Math.floor(this.config.maxOutputBytes / 4)))
    let admitted: readonly NotebookOutputMutation[]
    let persistedMutations = [...rawMutations]
    try {
      persistedMutations = this.ensureFailureOutput(persistedMutations, status, terminalError)
      admitted = await admitNotebookOutputMutations(
        this.ctx.attachments,
        persistedMutations,
        this.config.maxExecutionImages,
        this.recordSignal(kernel),
      )
    } catch (admissionError: unknown) {
      status = 'error'
      executionCount = null
      terminalError = truncateUtf8(
        `notebook output admission failed: ${errorText(admissionError)}`,
        Math.max(1, Math.floor(this.config.maxOutputBytes / 4)),
      )
      retireReason ??= asError(admissionError)
      persistedMutations = [errorMutation(terminalError)]
      admitted = await admitNotebookOutputMutations(
        this.ctx.attachments,
        persistedMutations,
        this.config.maxExecutionImages,
        this.recordSignal(kernel),
      )
    }

    let document = replaceIpynbCellExecution(file.document, cellId, {
      executionCount,
      mutations: persistedMutations,
      status,
      ...terminalError === undefined ? {} : { error: terminalError },
    })
    let specs = executionSpecs(
      kernel.notebookId,
      cellId,
      executionId,
      initiator,
      admitted,
      status,
      executionCount,
      terminalError,
      CANDIDATE_FILE_VERSION,
    )
    let projection = this.preflight(session, specs)
    let projectedCell = requireProjectedCell(projection.notebooks, kernel.notebookId, cellId)
    let result = executionResult(executionId, projectedCell.outputs, status, executionCount, terminalError)
    if (serializedBytes(result) > this.config.maxOutputBytes) {
      status = 'error'
      executionCount = null
      terminalError = 'notebook execution result exceeds maxOutputBytes'
      retireReason ??= new NotebookError(terminalError, 'OUTPUT_LIMIT')
      persistedMutations = [errorMutation(terminalError)]
      admitted = await admitNotebookOutputMutations(
        this.ctx.attachments,
        persistedMutations,
        this.config.maxExecutionImages,
        this.recordSignal(kernel),
      )
      document = replaceIpynbCellExecution(file.document, cellId, {
        executionCount,
        mutations: persistedMutations,
        status,
        error: terminalError,
      })
      specs = executionSpecs(
        kernel.notebookId,
        cellId,
        executionId,
        initiator,
        admitted,
        status,
        executionCount,
        terminalError,
        CANDIDATE_FILE_VERSION,
      )
      projection = this.preflight(session, specs)
      projectedCell = requireProjectedCell(projection.notebooks, kernel.notebookId, cellId)
      result = executionResult(executionId, projectedCell.outputs, status, executionCount, terminalError)
      if (serializedBytes(result) > this.config.maxOutputBytes) {
        throw new NotebookError('maxOutputBytes is too small for a terminal execution result', 'OUTPUT_LIMIT')
      }
    }

    using commit = deadline(
      this.recordSignal(kernel),
      this.config.executionTimeoutMs,
      'NOTEBOOK_EXECUTION_COMMIT_TIMEOUT',
    )
    try {
      const replaced = await replaceIpynbFile({
        fs: this.ctx.fs,
        target: file.target,
        document,
        version: file.version,
        sandboxPolicy: policy,
        signal: commit.signal,
        maxDocumentBytes: this.config.maxDocumentBytes,
      })
      specs = executionSpecs(
        kernel.notebookId,
        cellId,
        executionId,
        initiator,
        admitted,
        status,
        executionCount,
        terminalError,
        fileVersion(replaced.version),
      )
      projection = this.preflight(session, specs)
      projectedCell = requireProjectedCell(projection.notebooks, kernel.notebookId, cellId)
      result = executionResult(executionId, projectedCell.outputs, status, executionCount, terminalError)
      this.appendSpecs(session, specs)
      runtime.files.set(kernel.notebookId, { target: file.target, document, version: replaced.version })
    } catch (commitError: unknown) {
      this.markClosing(kernel, asError(commitError))
      throw commitError
    }
    if (retireReason !== undefined) this.markClosing(kernel, retireReason)
    return {
      result,
      ...retireReason === undefined ? {} : { retireReason },
    }
  }

  private acceptRawMutation(
    executionId: ExecutionId,
    mutations: NotebookKernelOutputMutation[],
    mutation: NotebookKernelOutputMutation,
  ): void {
    if (!isJsonValue(mutation)) throw new Error('kernel output mutation must be lossless JSON')
    if (mutations.length >= this.config.maxOutputItems) {
      throw new NotebookError(
        `kernel execution exceeds maxOutputItems (${String(this.config.maxOutputItems)})`,
        'OUTPUT_LIMIT',
      )
    }
    const candidate = [...mutations, mutation]
    const bytes = serializedBytes({
      executionId,
      mutations: candidate,
      status: 'error',
      executionCount: null,
      error: 'kernel execution output exceeds configured limit',
    })
    if (bytes > this.config.maxOutputBytes) {
      throw new NotebookError(
        `kernel execution exceeds maxOutputBytes (${String(this.config.maxOutputBytes)})`,
        'OUTPUT_LIMIT',
      )
    }
    mutations.push(mutation)
  }

  private ensureFailureOutput(
    source: readonly NotebookKernelOutputMutation[],
    status: NotebookExecutionStatus,
    error: string | undefined,
  ): NotebookKernelOutputMutation[] {
    const result = [...source]
    if (status === 'ok' || result.some(isErrorMutation)) return result
    const terminal = errorMutation(error ?? 'kernel execution failed')
    while (
      result.length >= this.config.maxOutputItems
      || serializedBytes([...result, terminal]) > this.config.maxOutputBytes
    ) {
      if (result.length === 0) break
      result.pop()
    }
    result.push(terminal)
    return result
  }

  private async findCanonicalOwner(
    runtime: SessionRuntime,
    prepared: PreparedIpynbFile,
    signal: AbortSignal,
  ): Promise<NotebookDocument | undefined> {
    const key = String(prepared.target.targetKey)
    const direct = runtime.targetOwners.get(key)
    if (direct !== undefined) {
      const notebook = this.requireNotebook(runtime.session, direct)
      this.adoptPreparedFile(runtime, notebook, prepared)
      return notebook
    }
    for (const notebook of this.list(runtime.session)) {
      const target = await this.ctx.fs.resolve(notebook.path, {
        ...runtime.session.header.cwd === undefined ? {} : { cwd: runtime.session.header.cwd },
        signal,
      })
      if (String(target.targetKey) !== key) continue
      this.adoptPreparedFile(runtime, notebook, prepared)
      runtime.targetOwners.set(key, notebook.id)
      return notebook
    }
    return undefined
  }

  private adoptPreparedFile(
    runtime: SessionRuntime,
    notebook: NotebookDocument,
    prepared: PreparedIpynbFile,
  ): void {
    const existing = prepared.existing
    if (existing === undefined || fileVersion(existing.version) !== notebook.fileVersion) {
      throw persistenceConflict(notebook.path)
    }
    const key = String(prepared.target.targetKey)
    const owner = runtime.targetOwners.get(key)
    if (owner !== undefined && owner !== notebook.id) {
      throw new Error(`canonical notebook target is already owned by ${owner}`)
    }
    runtime.targetOwners.set(key, notebook.id)
    runtime.files.set(notebook.id, {
      target: prepared.target,
      document: existing.document,
      version: existing.version,
    })
  }

  private async refreshFile(
    runtime: SessionRuntime,
    notebook: NotebookDocument,
    signal: AbortSignal,
  ): Promise<FileState> {
    const prepared = await prepareIpynbFile({
      fs: this.ctx.fs,
      path: notebook.path,
      ...runtime.session.header.cwd === undefined ? {} : { cwd: runtime.session.header.cwd },
      signal,
      maxDocumentBytes: this.config.maxDocumentBytes,
    })
    this.adoptPreparedFile(runtime, notebook, prepared)
    return runtime.files.get(notebook.id) as FileState
  }

  private handleSandboxPolicyChange(session: Session): void {
    const runtime = this.runtimes.get(session)
    if (runtime === undefined || this.disposedSessions.has(session)) return
    let policy: SandboxExecutionPolicy | undefined
    let resolutionError: unknown
    try {
      policy = this.ctx.sandboxPolicy.resolve({ session })
    } catch (error: unknown) {
      resolutionError = error
    }
    for (const pending of runtime.pendingStarts) {
      if (policy !== undefined && sameSandboxPolicy(pending.sandboxPolicy, policy)) continue
      pending.controller.abort(policyChangeError(pending.notebookId, resolutionError))
    }
    for (const registration of this.backends.values()) {
      for (const record of registration.records) {
        if (record.runtime !== runtime || record.state !== 'active') continue
        if (policy !== undefined && sameSandboxPolicy(record.sandboxPolicy, policy)) continue
        void this.retireKernel(record, policyChangeError(record.notebookId, resolutionError))
      }
    }
  }

  private async activeKernelForPolicy(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    policy: SandboxExecutionPolicy,
  ): Promise<KernelRecord | undefined> {
    const live = runtime.kernels.get(notebookId)
    if (live === undefined || live.state !== 'active') return undefined
    if (sameSandboxPolicy(live.sandboxPolicy, policy)) return live
    await this.retireKernel(live, policyChangeError(notebookId))
    return undefined
  }

  private assertKernelPolicy(record: KernelRecord, policy: SandboxExecutionPolicy): void {
    if (sameSandboxPolicy(record.sandboxPolicy, policy)) return
    const reason = policyChangeError(record.notebookId)
    void this.retireKernel(record, reason)
    throw reason
  }

  private assertPublishableKernel(record: KernelRecord): void {
    const policy = this.ctx.sandboxPolicy.resolve({ session: record.runtime.session })
    this.assertKernelPolicy(record, policy)
    if (record.state !== 'active') {
      throw new NotebookError(`kernel ${record.notebookId} is not active`, 'KERNEL_UNAVAILABLE')
    }
  }

  private async ensureKernel(
    runtime: SessionRuntime,
    notebook: NotebookDocument,
    initiator: 'agent' | 'user',
    policy: SandboxExecutionPolicy,
    signal: AbortSignal,
  ): Promise<KernelRecord> {
    this.assertRuntimeActive(runtime)
    const selection = notebook.kernel
    if (selection === undefined) throw environmentRequired(notebook)
    const existing = runtime.kernels.get(notebook.id)
    if (existing !== undefined && existing.state === 'active') {
      if (
        existing.environmentId !== selection.environmentId
        || existing.backend !== selection.backend
        || existing.kernelName !== selection.kernelName
      ) {
        throw new NotebookError(`kernel ${notebook.id} no longer matches its logged document`, 'KERNEL_UNAVAILABLE')
      }
      this.assertKernelPolicy(existing, policy)
      return existing
    }
    const retiring = runtime.retiring.get(notebook.id)
    if (retiring !== undefined) await awaitWithAbort(retiring.joined, signal)
    const inFlight = runtime.recoveries.get(notebook.id)
    if (inFlight !== undefined) return await awaitWithAbort(inFlight, signal)
    const recovering = this.publishReplacementKernel(
      runtime,
      notebook.id,
      selection.environmentId,
      selection.backend,
      selection.kernelName,
      initiator,
      policy,
      signal,
    ).then((outcome) => {
      const record = runtime.kernels.get(outcome.document.id)
      if (record === undefined) {
        throw new NotebookError(`kernel ${notebook.id} recovery was not published`, 'KERNEL_UNAVAILABLE')
      }
      return record
    })
    runtime.recoveries.set(notebook.id, recovering)
    void recovering.then(
      () => { if (runtime.recoveries.get(notebook.id) === recovering) runtime.recoveries.delete(notebook.id) },
      () => { if (runtime.recoveries.get(notebook.id) === recovering) runtime.recoveries.delete(notebook.id) },
    )
    return await awaitWithAbort(recovering, signal)
  }

  private startKernelRecord(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    backend: string,
    kernelName: string | undefined,
    registration: BackendRegistration,
    policy: SandboxExecutionPolicy,
    upstream: AbortSignal,
  ): Promise<KernelRecord> {
    const controller = new AbortController()
    const promise = Promise.resolve().then(async () => {
      using startup = deadline(
        AbortSignal.any([
          this.runtimeSignal(runtime, upstream),
          registration.controller.signal,
          controller.signal,
        ]),
        this.config.kernelStartTimeoutMs,
        'NOTEBOOK_KERNEL_START_TIMEOUT',
      )
      startup.signal.throwIfAborted()
      const starting = Promise.resolve(registration.backend.start({
        sessionId: runtime.session.id,
        notebookId,
        environmentId,
        backend,
        ...kernelName === undefined ? {} : { kernelName },
        ...runtime.session.header.cwd === undefined ? {} : { cwd: runtime.session.header.cwd },
        sandboxPolicy: policy,
        signal: startup.signal,
      }))
      let handle: NotebookKernelHandle
      try {
        handle = await awaitWithAbort(starting, startup.signal)
      } catch (error: unknown) {
        if (startup.signal.aborted) {
          const reason = abortError(startup.signal)
          const cleanup = starting.then(
            lateHandle => this.closeUnpublished(this.createKernelRecord(
              runtime,
              notebookId,
              environmentId,
              backend,
              kernelName,
              registration,
              policy,
              lateHandle,
            ), reason),
            () => {},
          )
          this.trackRetirement(cleanup)
        }
        throw error
      }
      const record = this.createKernelRecord(
        runtime,
        notebookId,
        environmentId,
        backend,
        kernelName,
        registration,
        policy,
        handle,
      )
      const currentPolicy = this.ctx.sandboxPolicy.resolve({ session: runtime.session })
      if (
        !startup.signal.aborted
        && !this.disposing
        && !this.disposedSessions.has(runtime.session)
        && sameSandboxPolicy(policy, currentPolicy)
      ) {
        return record
      }
      const reason = sameSandboxPolicy(policy, currentPolicy)
        ? abortError(startup.signal)
        : policyChangeError(notebookId)
      try {
        await this.closeUnpublished(record, reason)
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [reason, cleanupError],
          'aborted kernel startup cleanup failed',
        )
      }
      throw reason
    })
    const pending: PendingStart = { registration, notebookId, sandboxPolicy: policy, controller, promise }
    runtime.pendingStarts.add(pending)
    void promise.then(
      () => { runtime.pendingStarts.delete(pending) },
      () => { runtime.pendingStarts.delete(pending) },
    )
    return promise
  }

  private createKernelRecord(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    environmentId: NotebookEnvironmentId,
    backend: string,
    kernelName: string | undefined,
    registration: BackendRegistration,
    sandboxPolicy: SandboxExecutionPolicy,
    handle: NotebookKernelHandle,
  ): KernelRecord {
    const record: KernelRecord = {
      runtime,
      notebookId,
      registration,
      handle,
      environmentId,
      backend,
      ...kernelName === undefined ? {} : { kernelName },
      sandboxPolicy,
      controller: new AbortController(),
      state: 'active',
      tail: Promise.resolve(),
    }
    registration.records.add(record)
    return record
  }

  private enqueue<T>(
    record: KernelRecord,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = record.tail
    const taskSignal = AbortSignal.any([signal, this.recordSignal(record)])
    const result = Promise.resolve().then(async () => {
      await awaitWithAbort(previous, taskSignal)
      taskSignal.throwIfAborted()
      if (record.state !== 'active') {
        throw new NotebookError(`kernel ${record.notebookId} is not active`, 'KERNEL_UNAVAILABLE')
      }
      return await task(taskSignal)
    })
    record.tail = Promise.allSettled([previous, result]).then(() => {})
    return result
  }

  private enqueueDocument<T>(
    runtime: SessionRuntime,
    notebookId: NotebookId,
    signal: AbortSignal,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = runtime.documentTails.get(notebookId) ?? Promise.resolve()
    const taskSignal = AbortSignal.any([signal, this.runtimeSignal(runtime)])
    const result = Promise.resolve().then(async () => {
      await awaitWithAbort(previous, taskSignal)
      taskSignal.throwIfAborted()
      return await task(taskSignal)
    })
    const tail = Promise.allSettled([previous, result]).then(() => {})
    runtime.documentTails.set(notebookId, tail)
    void tail.finally(() => {
      if (runtime.documentTails.get(notebookId) === tail) runtime.documentTails.delete(notebookId)
    })
    return result
  }

  private markClosing(record: KernelRecord, _reason: Error): void {
    if (record.state !== 'active') return
    record.state = 'closing'
    if (record.runtime.kernels.get(record.notebookId) === record) {
      record.runtime.kernels.delete(record.notebookId)
    }
  }

  private retireKernel(record: KernelRecord, reason: Error): Promise<void> {
    const retirement = this.beginKernelRetirement(record, reason)
    const current = record.runtime.retiring.get(record.notebookId)
    if (record.state !== 'closed' && (current === undefined || current === retirement)) {
      record.runtime.retiring.set(record.notebookId, retirement)
    }
    return retirement.outcome
  }

  private closeUnpublished(record: KernelRecord, reason: Error): Promise<void> {
    return this.beginKernelRetirement(record, reason).outcome
  }

  private beginKernelRetirement(record: KernelRecord, reason: Error): KernelRetirement {
    if (record.retirement !== undefined) return record.retirement
    this.markClosing(record, reason)
    record.controller.abort(reason)
    const shutdown = deadline(
      undefined,
      this.config.shutdownTimeoutMs,
      'NOTEBOOK_KERNEL_SHUTDOWN_TIMEOUT',
    )
    const backendShutdown = Promise.resolve().then(() => (
      record.registration.backend.shutdown(record.handle, shutdown.signal)
    ))
    const joined = joinKernelWork(record.tail, backendShutdown, record.notebookId)
    const outcome = awaitWithAbort(joined, shutdown.signal).finally(() => {
      shutdown[Symbol.dispose]()
    })
    const retirement = { joined, outcome }
    record.retirement = retirement
    this.shutdownJoins.add(joined)
    this.trackRetirement(outcome)
    void joined.then(
      () => {
        record.state = 'closed'
        record.registration.records.delete(record)
        this.shutdownJoins.delete(joined)
        if (record.runtime.retiring.get(record.notebookId) === retirement) {
          record.runtime.retiring.delete(record.notebookId)
        }
      },
      (error: unknown) => {
        record.state = 'shutdown-failed'
        this.shutdownJoins.delete(joined)
        this.ctx.logger.warn(
          `notebook kernel ${JSON.stringify(record.notebookId)} shutdown failed: ${errorText(error)}`,
        )
      },
    )
    return retirement
  }

  private retireRegistration(registration: BackendRegistration): Promise<void> {
    if (registration.retirePromise !== undefined) return registration.retirePromise
    if (this.backends.get(registration.backend.type) === registration) {
      this.backends.delete(registration.backend.type)
    }
    registration.controller.abort(new NotebookError(
      `notebook backend ${JSON.stringify(registration.backend.type)} was disposed`,
      'KERNEL_UNAVAILABLE',
    ))
    const records = [...registration.records]
    for (const record of records) {
      this.markClosing(record, new NotebookError('notebook backend was disposed', 'KERNEL_UNAVAILABLE'))
    }
    const pending = [...this.liveRuntimes]
      .flatMap(runtime => [...runtime.pendingStarts])
      .filter(start => start.registration === registration)
      .map(start => start.promise)
    const retirement = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      await Promise.allSettled(pending)
      const ownedRecords = [...registration.records]
      for (const record of ownedRecords) {
        this.markClosing(record, new NotebookError('notebook backend was disposed', 'KERNEL_UNAVAILABLE'))
      }
      const closed = await Promise.allSettled(ownedRecords.map(record => (
        this.retireKernel(record, new NotebookError('notebook backend was disposed', 'KERNEL_UNAVAILABLE'))
      )))
      for (const result of closed) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `failed to retire notebook backend ${JSON.stringify(registration.backend.type)}`,
        )
      }
    })
    registration.retirePromise = retirement
    this.trackRetirement(retirement)
    return retirement
  }

  private trackRetirement(promise: Promise<void>): void {
    this.retiring.add(promise)
    void promise.then(
      () => { this.retiring.delete(promise) },
      () => { this.retiring.delete(promise) },
    )
  }

  private runtimeFor(session: Session): SessionRuntime {
    this.assertActive()
    if (this.disposedSessions.has(session)) {
      throw new NotebookError(`notebook session ${JSON.stringify(session.id)} is disposed`, 'SESSION_DISPOSED')
    }
    const existing = this.runtimes.get(session)
    if (existing !== undefined) return existing
    const runtime: SessionRuntime = {
      session,
      controller: new AbortController(),
      kernels: new Map(),
      pendingStarts: new Set(),
      retiring: new Map(),
      files: new Map(),
      targetOwners: new Map(),
      openings: new Map(),
      documentTails: new Map(),
      recoveries: new Map(),
      kernelFailures: new Set(),
      reservedIds: new Set(),
    }
    this.runtimes.set(session, runtime)
    this.liveRuntimes.add(runtime)
    return runtime
  }

  private assertRuntimeActive(runtime: SessionRuntime): void {
    this.assertActive()
    if (this.disposedSessions.has(runtime.session) || runtime.controller.signal.aborted) {
      throw new NotebookError(
        `notebook session ${JSON.stringify(runtime.session.id)} is disposed`,
        'SESSION_DISPOSED',
      )
    }
  }

  private assertActive(): void {
    if (this.disposing) throw new NotebookError('notebook service is disposing', 'SERVICE_DISPOSING')
  }

  private runtimeSignal(runtime: SessionRuntime, upstream?: AbortSignal): AbortSignal {
    return upstream === undefined
      ? AbortSignal.any([this.lifecycle.signal, runtime.controller.signal])
      : AbortSignal.any([upstream, this.lifecycle.signal, runtime.controller.signal])
  }

  private recordSignal(record: KernelRecord): AbortSignal {
    return AbortSignal.any([
      this.lifecycle.signal,
      record.runtime.controller.signal,
      record.registration.controller.signal,
      record.controller.signal,
    ])
  }

  private requireBackend(backend: string): BackendRegistration {
    const registration = this.backends.get(backend)
    if (registration === undefined || registration.controller.signal.aborted) {
      throw new NotebookError(`no notebook backend registered for ${JSON.stringify(backend)}`, 'NO_BACKEND')
    }
    return registration
  }

  private selectBackend(requested: string | undefined): BackendRegistration {
    const backend = requested ?? defaultBackend(this.backends)
    if (backend === undefined || backend.length === 0) {
      throw new NotebookError('no notebook kernel backend is registered', 'NO_BACKEND')
    }
    return this.requireBackend(backend)
  }

  private requireNotebook(session: Session, notebookId: NotebookId): NotebookDocument {
    const notebook = this.projection(session).notebooks.find(entry => entry.id === notebookId)
    if (notebook === undefined) throw new NotebookError(`unknown notebook ${notebookId}`, 'NOT_FOUND')
    return notebook
  }

  private projection(session: Session): FoldedNotebooks {
    const events = session.events
    const cached = this.projections.get(session)
    const lastEvent = events.at(-1)
    if (cached !== undefined && cached.events === events && cached.lastEvent === lastEvent) {
      return cached.projection
    }
    const projection = foldNotebooks(events)
    this.projections.set(session, { events, lastEvent, projection })
    return projection
  }

  private requireCell(notebook: NotebookDocument, cellId: CellId): NotebookCell {
    const cell = notebook.cells.find(entry => entry.id === cellId)
    if (cell === undefined) throw new NotebookError(`unknown notebook cell ${cellId}`, 'NOT_FOUND')
    return cell
  }

  private reserveId(runtime: SessionRuntime, prefix: 'notebook' | 'cell' | 'exec'): string {
    const used = new Set<string>(runtime.reservedIds)
    for (const event of runtime.session.events) {
      switch (event.type) {
        case 'notebook/open':
          used.add(event.data.notebookId)
          break
        case 'notebook/cell':
          used.add(event.data.cellId)
          break
        case 'notebook/execute':
          used.add(event.data.executionId)
          break
        default:
          break
      }
    }
    let sequence = 1
    while (used.has(`${prefix}-${String(sequence)}`)) sequence += 1
    const id = `${prefix}-${String(sequence)}`
    runtime.reservedIds.add(id)
    return id
  }

  private preflight(session: Session, specs: readonly NotebookEventSpec[]) {
    for (const spec of specs) {
      if (!isJsonValue(spec.data)) {
        throw new Error(`notebook event ${JSON.stringify(spec.type)} must carry lossless JSON`)
      }
    }
    const events = candidateEvents(session, specs)
    return foldNotebooks([...session.events, ...events])
  }

  private appendSpecs(session: Session, specs: readonly NotebookEventSpec[]): void {
    // The published development dependency is rc.6 while the package requires
    // the rc.7 append-options API at runtime. Keep the future API assertion
    // local until that Harness release is available on npm.
    const append = session.append.bind(session) as unknown as (
      type: NotebookEventSpec['type'],
      data: NotebookEventSpec['data'],
      options: { readonly ignorable: true },
    ) => void
    for (const spec of specs) {
      switch (spec.type) {
        case 'notebook/open':
          append(spec.type, spec.data, { ignorable: true })
          break
        case 'notebook/cell':
          append(spec.type, spec.data, { ignorable: true })
          break
        case 'notebook/execute':
          append(spec.type, spec.data, { ignorable: true })
          break
        case 'notebook/output':
          append(spec.type, spec.data, { ignorable: true })
          break
        case 'notebook/execute-end':
          append(spec.type, spec.data, { ignorable: true })
          break
        case 'notebook/kernel':
          append(spec.type, spec.data, { ignorable: true })
          break
        case 'notebook/reload':
          append(spec.type, spec.data, { ignorable: true })
          break
        default:
          assertNever(spec)
      }
    }
  }

  private disposeSession(session: Session): Promise<void> {
    this.disposedSessions.add(session)
    const runtime = this.runtimes.get(session)
    if (runtime === undefined) return Promise.resolve()
    if (runtime.cleanupPromise !== undefined) return runtime.cleanupPromise
    const reason = new NotebookError('notebook session is disposed', 'SESSION_DISPOSED')
    runtime.controller.abort(reason)
    const records = [...runtime.kernels.values()]
    for (const record of records) this.markClosing(record, reason)
    const cleanup = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      const starts = await Promise.allSettled([...runtime.pendingStarts].map(start => start.promise))
      for (const result of starts) if (result.status === 'rejected') failures.push(result.reason)
      const closed = await Promise.allSettled(records.map(record => this.retireKernel(record, reason)))
      for (const result of closed) if (result.status === 'rejected') failures.push(result.reason)
      const retiring = await Promise.allSettled(
        [...runtime.retiring.values()].map(retirement => retirement.outcome),
      )
      for (const result of retiring) if (result.status === 'rejected') failures.push(result.reason)
      runtime.kernels.clear()
      runtime.pendingStarts.clear()
      runtime.retiring.clear()
      runtime.files.clear()
      runtime.targetOwners.clear()
      runtime.openings.clear()
      runtime.documentTails.clear()
      runtime.recoveries.clear()
      runtime.kernelFailures.clear()
      runtime.reservedIds.clear()
      this.liveRuntimes.delete(runtime)
      this.runtimes.delete(session)
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `failed to shut down notebook kernels for session ${JSON.stringify(session.id)}`,
        )
      }
    })
    runtime.cleanupPromise = cleanup
    return cleanup
  }

  private disposeAll(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposing = true
    const reason = new NotebookError('notebook service is disposing', 'SERVICE_DISPOSING')
    this.lifecycle.abort(reason)
    const runtimes = [...this.liveRuntimes]
    for (const runtime of runtimes) {
      runtime.controller.abort(reason)
      for (const record of runtime.kernels.values()) this.markClosing(record, reason)
    }
    const disposing = Promise.resolve().then(async () => {
      const failures: unknown[] = []
      const sessions = await Promise.allSettled(runtimes.map(runtime => this.disposeSession(runtime.session)))
      for (const result of sessions) if (result.status === 'rejected') failures.push(result.reason)
      const registrations = await Promise.allSettled([...this.backends.values()].map(entry => (
        this.retireRegistration(entry)
      )))
      for (const result of registrations) if (result.status === 'rejected') failures.push(result.reason)
      const retiring = await Promise.allSettled(this.retiring)
      for (const result of retiring) if (result.status === 'rejected') failures.push(result.reason)
      this.backends.clear()
      this.liveRuntimes.clear()
      this.retiring.clear()
      if (failures.length > 0) throw new AggregateError(failures, 'failed to shut down notebook kernels')
    })
    this.disposePromise = disposing
    return disposing
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    kernelStartTimeoutMs: config.kernelStartTimeoutMs ?? DEFAULT_KERNEL_START_TIMEOUT_MS,
    executionTimeoutMs: config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    inspectTimeoutMs: config.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    maxDocumentBytes: config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    maxDocumentImages: config.maxDocumentImages ?? DEFAULT_MAX_DOCUMENT_IMAGES,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxOutputItems: config.maxOutputItems ?? DEFAULT_MAX_OUTPUT_ITEMS,
    maxExecutionImages: config.maxExecutionImages ?? DEFAULT_MAX_EXECUTION_IMAGES,
    maxInspectBytes: config.maxInspectBytes ?? DEFAULT_MAX_INSPECT_BYTES,
    discoveryPageSize: config.discoveryPageSize ?? DEFAULT_DISCOVERY_PAGE_SIZE,
    discoveryMaxEntries: config.discoveryMaxEntries ?? DEFAULT_DISCOVERY_MAX_ENTRIES,
    discoveryMaxDepth: config.discoveryMaxDepth ?? DEFAULT_DISCOVERY_MAX_DEPTH,
    discoveryExcludeDirectoryNames: new Set(
      (config.discoveryExcludeDirectoryNames ?? DEFAULT_DISCOVERY_EXCLUDES).map(name => name.toLowerCase()),
    ),
  }
  for (const key of [
    'kernelStartTimeoutMs',
    'executionTimeoutMs',
    'inspectTimeoutMs',
    'shutdownTimeoutMs',
  ] as const) {
    const value = resolved[key]
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `notebook config.${key} must be a positive number no greater than ${String(MAX_TIMER_DELAY_MS)}`,
      )
    }
  }
  for (const [key, minimum, maximum] of [
    ['maxDocumentBytes', 1, MAX_DOCUMENT_BYTES],
    ['maxDocumentImages', 0, MAX_DOCUMENT_IMAGES],
    ['maxOutputBytes', MIN_RESULT_BYTES, MAX_OUTPUT_BYTES],
    ['maxOutputItems', 1, MAX_OUTPUT_ITEMS],
    ['maxExecutionImages', 0, MAX_EXECUTION_IMAGES],
    ['maxInspectBytes', 1, MAX_INSPECT_BYTES],
    ['discoveryPageSize', 1, MAX_DISCOVERY_PAGE_SIZE],
    ['discoveryMaxEntries', 1, MAX_DISCOVERY_ENTRIES],
    ['discoveryMaxDepth', 0, MAX_DISCOVERY_DEPTH],
  ] as const) {
    const value = resolved[key]
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `notebook config.${key} must be a safe integer between ${String(minimum)} and ${String(maximum)}`,
      )
    }
  }
  for (const name of resolved.discoveryExcludeDirectoryNames) {
    if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error('notebook config.discoveryExcludeDirectoryNames must contain portable basenames')
    }
  }
  return resolved
}

function defaultBackend(backends: ReadonlyMap<string, BackendRegistration>): string | undefined {
  if (backends.has('jupyter')) return 'jupyter'
  if (backends.has('memory')) return 'memory'
  return backends.keys().next().value
}

function openSpecs(
  notebookId: NotebookId,
  path: string,
  version: NotebookFileVersion,
  document: IpynbDocument,
  contents: readonly NotebookCellContent[],
): NotebookEventSpec[] {
  const specs: NotebookEventSpec[] = [{
    type: 'notebook/open',
    data: {
      notebookId,
      path,
      fileVersion: version,
      nbformatMinor: document.nbformatMinor,
      metadata: document.metadata,
    },
  }]
  for (const [index, cell] of document.cells.entries()) {
    const content = contents[index]
    if (content === undefined) throw new Error(`missing admitted notebook cell at index ${String(index)}`)
    specs.push({
      type: 'notebook/cell',
      data: {
        notebookId,
        cellId: cell.id,
        cellType: cell.cellType,
        source: cell.source,
        index,
        operation: 'create',
        metadata: cell.metadata,
        attachments: content.attachments,
        ...cell.cellType === 'code' ? { outputs: content.outputs } : {},
        ...cell.executionCount === null ? {} : { executionCount: cell.executionCount },
        fileVersion: version,
      },
    })
  }
  return specs
}

function executionSpecs(
  notebookId: NotebookId,
  cellId: CellId,
  executionId: ExecutionId,
  initiator: 'agent' | 'user',
  mutations: readonly NotebookOutputMutation[],
  status: NotebookExecutionStatus,
  executionCount: number | null,
  error: string | undefined,
  version: NotebookFileVersion,
): NotebookEventSpec[] {
  return [
    {
      type: 'notebook/execute',
      data: { notebookId, cellId, executionId, initiator },
    },
    ...mutations.map((mutation): NotebookEventSpec => ({
      type: 'notebook/output',
      data: { notebookId, cellId, executionId, mutation },
    })),
    {
      type: 'notebook/execute-end',
      data: {
        notebookId,
        cellId,
        executionId,
        status,
        executionCount,
        ...error === undefined ? {} : { error },
        fileVersion: version,
      },
    },
  ]
}

function kernelSpec(
  notebook: NotebookDocument,
  environmentId: NotebookEnvironmentId,
  backend: string,
  kernelName: string | undefined,
  initiator: 'agent' | 'user',
): NotebookEventSpec {
  return {
    type: 'notebook/kernel',
    data: {
      notebookId: notebook.id,
      environmentId,
      backend,
      ...kernelName === undefined ? {} : { kernelName },
      generation: (notebook.kernel?.generation ?? 0) + 1,
      initiator,
      fileVersion: notebook.fileVersion,
    },
  }
}

function reloadSpec(
  notebook: NotebookDocument,
  options: NotebookReloadOptions,
  version: NotebookFileVersion,
  document: IpynbDocument,
  contents: readonly NotebookCellContent[],
): NotebookEventSpec {
  return {
    type: 'notebook/reload',
    data: {
      notebookId: notebook.id,
      initiator: options.initiator,
      fileVersion: version,
      nbformatMinor: document.nbformatMinor,
      metadata: document.metadata,
      cells: document.cells.map((cell, index) => {
        const content = contents[index]
        if (content === undefined) throw new Error(`missing admitted notebook cell at index ${String(index)}`)
        return {
          id: cell.id,
          cellType: cell.cellType,
          source: cell.source,
          metadata: cell.metadata,
          attachments: content.attachments,
          outputs: cell.cellType === 'code' ? content.outputs : [],
          ...cell.executionCount === null ? {} : { executionCount: cell.executionCount },
        }
      }),
    },
  }
}

function candidateEvents(session: Session, specs: readonly NotebookEventSpec[]): SessionEvent[] {
  return specs.map((spec, index): SessionEvent => {
    const envelope = { seq: session.seq + index, time: Date.now() }
    switch (spec.type) {
      case 'notebook/open':
        return { type: spec.type, ...envelope, data: spec.data }
      case 'notebook/cell':
        return { type: spec.type, ...envelope, data: spec.data }
      case 'notebook/execute':
        return { type: spec.type, ...envelope, data: spec.data }
      case 'notebook/output':
        return { type: spec.type, ...envelope, data: spec.data }
      case 'notebook/execute-end':
        return { type: spec.type, ...envelope, data: spec.data }
      case 'notebook/kernel':
        return { type: spec.type, ...envelope, data: spec.data }
      case 'notebook/reload':
        return { type: spec.type, ...envelope, data: spec.data }
      default:
        return assertNever(spec)
    }
  })
}

function executionResult(
  executionId: ExecutionId,
  outputs: readonly NotebookCell['outputs'][number][],
  status: NotebookExecutionStatus,
  executionCount: number | null,
  error: string | undefined,
): NotebookExecuteResult {
  return {
    executionId,
    outputs,
    executionCount,
    status,
    ...error === undefined ? {} : { error },
  }
}

function requireProjectedCell(
  notebooks: readonly NotebookDocument[],
  notebookId: NotebookId,
  cellId: CellId,
): NotebookCell {
  const notebook = notebooks.find(entry => entry.id === notebookId)
  const cell = notebook?.cells.find(entry => entry.id === cellId)
  if (cell === undefined) throw new Error('candidate execution lost its target cell')
  return cell
}

function errorMutation(error: string): NotebookKernelOutputMutation {
  return {
    operation: 'append',
    output: { type: 'error', name: 'NotebookExecutionError', value: error, traceback: [] },
  }
}

function isErrorMutation(mutation: NotebookKernelOutputMutation): boolean {
  return mutation.operation === 'append' && mutation.output.type === 'error'
}

function fileVersion(version: FsVersion): NotebookFileVersion {
  return NotebookFileVersion(String(version))
}

function persistenceConflict(path: string): NotebookPersistenceError {
  return new NotebookPersistenceError(
    `notebook ${JSON.stringify(path)} changed outside this session`,
    'WRITE_CONFLICT',
  )
}

function environmentRequired(notebook: NotebookDocument): NotebookError {
  return new NotebookError(
    `notebook ${JSON.stringify(notebook.path)} requires an attached environment`,
    'ENVIRONMENT_REQUIRED',
  )
}

function sameSandboxPolicy(left: SandboxExecutionPolicy, right: SandboxExecutionPolicy): boolean {
  return left.mode === right.mode
    && left.workspaceRoot === right.workspaceRoot
    && left.sessionId === right.sessionId
}

function policyChangeError(notebookId: NotebookId, cause?: unknown): NotebookError {
  const detail = cause === undefined ? '' : `: ${errorText(cause)}`
  return new NotebookError(
    `kernel ${notebookId} sandbox policy changed; explicit restart/reload required${detail}`,
    'KERNEL_UNAVAILABLE',
  )
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function truncateUtf8(source: string, maxBytes: number): string {
  const normalized = source.length === 0 ? 'notebook operation failed' : source
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized
  let low = 1
  let high = normalized.length
  let fitted = normalized.slice(0, 1)
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = normalized.slice(0, middle)
    if (Buffer.byteLength(candidate) <= maxBytes) {
      fitted = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return fitted
}

function executionFailureText(error: unknown, signal: AbortSignal): string {
  const timeout = timeoutOf(signal, 'NOTEBOOK_EXECUTION_TIMEOUT')
  if (timeout !== undefined) return `notebook execution timed out after ${String(timeout.timeoutMs)}ms`
  if (signal.aborted) return errorText(signal.reason)
  return errorText(error)
}

function assertOptionalName(value: string | undefined, field: string): void {
  if (value !== undefined && value.length === 0) throw new Error(`${field} must be non-empty`)
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const text = String(error)
  return text.length === 0 ? 'notebook operation failed' : text
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorText(error))
}

async function joinKernelWork(
  tail: Promise<void>,
  shutdown: Promise<void>,
  notebookId: NotebookId,
): Promise<void> {
  const settled = await Promise.allSettled([tail, shutdown])
  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown)
  if (failures.length > 0) {
    throw new AggregateError(failures, `kernel ${JSON.stringify(notebookId)} did not shut down cleanly`)
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.aborted ? asError(signal.reason) : new Error('notebook operation aborted')
}

function awaitWithAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function assertNever(value: never): never {
  throw new Error(`unreachable notebook value ${JSON.stringify(value)}`)
}

export default NotebookService
