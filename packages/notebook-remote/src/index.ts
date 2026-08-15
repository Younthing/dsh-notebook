/** Host Remote exposing Notebook operations to separately installed clients. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  CellId,
  NotebookError,
  NotebookId,
  NotebookPersistenceError,
  type NotebookService,
} from '@younthing/dsh-notebook-core'
import {
  NotebookEnvironmentError,
  NotebookEnvironmentId,
  type NotebookEnvironmentManager,
  type NotebookEnvironmentOperationRequest,
} from '@younthing/dsh-notebook-environment'
import {
  Session,
  SessionId,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { hasApiRemoteSubagentOwner } from '@deepseek-ai/dsh-api-remotes'
import { Remote, TypertLookupFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { findNotebookImage } from './attachments.ts'
import { renderNotebookInjection } from './injection.ts'
import type {
  NotebookAttachEnvironmentRequest,
  NotebookCreateEnvironmentRequest,
  NotebookCreateRequest,
  NotebookDiscoverRequest,
  NotebookDiscoveryPage,
  NotebookDocument,
  NotebookEditCellAck,
  NotebookEditCellRequest,
  NotebookEnvironmentCatalog,
  NotebookEnvironmentCatalogRequest,
  NotebookIdentityRequest,
  NotebookInsertCellAck,
  NotebookInsertCellRequest,
  NotebookInstallPythonRequest,
  NotebookInterruptAck,
  NotebookInterruptRequest,
  NotebookKernelAck,
  NotebookKernelRuntimeStatus,
  NotebookOpenRequest,
  NotebookReloadAck,
  NotebookReadAttachmentAck,
  NotebookReadAttachmentRequest,
  NotebookRemoteError,
  NotebookRemoteResult,
  NotebookRunAck,
  NotebookRunCellRequest,
  NotebookRuntimeStatusRequest,
  NotebookSessionRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    notebookRemote: NotebookRemoteService
  }
}

/** Default maximum bytes injected into the Agent after a user-initiated run. */
export const DEFAULT_NOTEBOOK_MAX_INJECTION_BYTES = 64 * 1024
/** Absolute allocation ceiling for one model-visible notebook run summary. */
export const NOTEBOOK_INJECTION_HARD_MAX_BYTES = 1024 * 1024

/** Notebook Remote configuration. */
export interface Config {
  /** Maximum UTF-8 bytes injected into the Agent after a user-initiated run. */
  maxInjectionBytes?: number
}

interface SessionAccess {
  readonly header: SessionHeader
  readonly session: Session
  readonly agent?: Agent
  readonly headerOnly?: true
}

function success<T>(value: T): NotebookRemoteResult<T> {
  return { ok: true, value }
}

function failure<T>(error: NotebookRemoteError): NotebookRemoteResult<T> {
  return { ok: false, error }
}

function configured<T>(value: T | undefined, message: string): NotebookRemoteResult<T> {
  return value === undefined
    ? failure({ source: 'configuration', code: 'service-absent', message })
    : success(value)
}

/** Remote-only Notebook service under `ctx.remote.notebooks`. */
export class NotebookRemoteService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'typert']

  static Config: z<Config> = z.object({
    maxInjectionBytes: z.number().default(DEFAULT_NOTEBOOK_MAX_INJECTION_BYTES),
  })

  private readonly maxInjectionBytes: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'notebookRemote', { namespace: 'notebooks' })
    const maxInjectionBytes = config.maxInjectionBytes ?? DEFAULT_NOTEBOOK_MAX_INJECTION_BYTES
    if (!Number.isSafeInteger(maxInjectionBytes)
      || maxInjectionBytes < 128
      || maxInjectionBytes > NOTEBOOK_INJECTION_HARD_MAX_BYTES) {
      throw new Error(
        `maxInjectionBytes must be an integer between 128 and ${String(NOTEBOOK_INJECTION_HARD_MAX_BYTES)}`,
      )
    }
    this.maxInjectionBytes = maxInjectionBytes
  }

  private notebooksFor(agent?: Agent): NotebookRemoteResult<NotebookService> {
    return configured(
      agent?.ctx.get('notebooks') ?? this.ctx.get('notebooks'),
      'notebook service is absent: load @younthing/dsh-notebook-core',
    )
  }

  private async agentFor(sessionId: string): Promise<NotebookRemoteResult<Agent>> {
    const provider = this.ctx.typert.lookups.get('agent')
    if (provider === undefined) {
      return failure({
        source: 'configuration',
        code: 'lookup-absent',
        message: 'the Host agent lookup is not configured',
      })
    }
    try {
      const resolved = await provider.resolve(SessionId(sessionId))
      if (resolved === undefined) {
        return failure({ source: 'session', code: 'session-not-found', message: `session "${sessionId}" not found` })
      }
      return success(resolved as Agent)
    } catch (error: unknown) {
      if (error instanceof TypertLookupFailure) {
        const lookup = error.failure as { readonly code?: unknown; readonly message?: unknown }
        return failure({
          source: 'session',
          code: typeof lookup.code === 'string' ? lookup.code : 'lookup-rejected',
          message: typeof lookup.message === 'string' ? lookup.message : 'the Host rejected the session identity',
        })
      }
      throw error
    }
  }

  private environmentsFor(agent?: Agent): NotebookRemoteResult<NotebookEnvironmentManager> {
    return configured(
      agent?.ctx.get('notebookEnvironments') ?? this.ctx.get('notebookEnvironments'),
      'notebook environment service is absent: load @younthing/dsh-notebook-environment',
    )
  }

  private resident(sessionId: SessionId): NotebookRemoteResult<SessionAccess> | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) {
      if (hasApiRemoteSubagentOwner(this.ctx, agent.session, agent)) {
        return failure({
          source: 'session',
          code: 'subagent-owned',
          message: `session "${sessionId}" is owned by subagent routing`,
        })
      }
      return success({ header: agent.session.header, session: agent.session, agent })
    }
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    if (hasApiRemoteSubagentOwner(this.ctx, session, undefined)) {
      return failure({
        source: 'session',
        code: 'subagent-owned',
        message: `session "${sessionId}" is owned by subagent routing`,
      })
    }
    return success({ header: session.header, session })
  }

  private async headerFor(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<NotebookRemoteResult<SessionAccess>> {
    const resident = this.resident(sessionId)
    if (resident !== undefined) return resident
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      return failure({
        source: 'configuration',
        code: 'service-absent',
        message: 'session persistence is not configured',
      })
    }
    try {
      signal?.throwIfAborted()
      const header = (await persistence.list(signal)).find(candidate => candidate.id === sessionId)
      signal?.throwIfAborted()
      const attached = this.resident(sessionId)
      if (attached !== undefined) return attached
      if (header === undefined || header.cwd === undefined) {
        return failure({ source: 'session', code: 'session-not-found', message: `session "${sessionId}" not found` })
      }
      if (hasApiRemoteSubagentOwner(this.ctx, { header }, undefined)) {
        return failure({
          source: 'session',
          code: 'subagent-owned',
          message: `session "${sessionId}" is owned by subagent routing`,
        })
      }
      return success({ header, session: Session.create(header.id, undefined, header), headerOnly: true })
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        return failure({ source: 'cancelled', code: 'cancelled', message: 'notebook header read was cancelled' })
      }
      this.ctx.logger.error(error)
      throw new Error(`notebook header read failed for session "${sessionId}"`)
    }
  }

  private async sessionFor(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<NotebookRemoteResult<SessionAccess>> {
    const access = await this.headerFor(sessionId, signal)
    if (!access.ok || access.value.headerOnly !== true) return access
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      return failure({ source: 'configuration', code: 'service-absent', message: 'session persistence is not configured' })
    }
    try {
      const inspected = await persistence.inspect(sessionId, signal)
      signal?.throwIfAborted()
      const attached = this.resident(sessionId)
      if (attached !== undefined) return attached
      if (inspected.meta.cwd === undefined) {
        return failure({ source: 'session', code: 'session-not-found', message: `session "${sessionId}" not found` })
      }
      if (hasApiRemoteSubagentOwner(this.ctx, { header: inspected.meta }, undefined)) {
        return failure({
          source: 'session',
          code: 'subagent-owned',
          message: `session "${sessionId}" is owned by subagent routing`,
        })
      }
      return success({
        header: inspected.meta,
        session: Session.fromRestore(inspected.meta.id, inspected.events, inspected.meta),
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        return failure({ source: 'cancelled', code: 'cancelled', message: 'notebook session read was cancelled' })
      }
      this.ctx.logger.error(error)
      throw new Error(`notebook session read failed for session "${sessionId}"`)
    }
  }

  private operationFor(session: Session, context: Context, signal?: AbortSignal): NotebookRemoteResult<NotebookEnvironmentOperationRequest> {
    const sandboxPolicy = context.get('sandboxPolicy')
    if (sandboxPolicy === undefined) {
      return failure({
        source: 'configuration',
        code: 'service-absent',
        message: 'sandbox policy service is absent: load @deepseek-ai/dsh-sandbox-policy',
      })
    }
    const policy = sandboxPolicy.resolve({ session })
    return success({
      workspaceRoot: policy.workspaceRoot,
      sandboxPolicy: policy,
      signal: signal ?? new AbortController().signal,
    })
  }

  private knownError<T>(error: unknown, signal?: AbortSignal): NotebookRemoteResult<T> | undefined {
    if (signal?.aborted === true) {
      return failure({ source: 'cancelled', code: 'cancelled', message: 'notebook operation was cancelled' })
    }
    if (error instanceof NotebookError) {
      return failure({ source: 'core', code: error.code, message: error.message })
    }
    if (error instanceof NotebookPersistenceError) {
      return failure({ source: 'persistence', code: error.code, message: error.message })
    }
    if (error instanceof NotebookEnvironmentError) {
      return failure({
        source: 'environment',
        code: error.code,
        message: error.message,
        category: error.category,
        retryable: error.retryable,
      })
    }
    return undefined
  }

  private async execute<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<NotebookRemoteResult<T>> {
    try {
      return success(await operation())
    } catch (error: unknown) {
      const known = this.knownError<T>(error, signal)
      if (known !== undefined) return known
      this.ctx.logger.error('notebook operation failed unexpectedly')
      this.ctx.logger.error(error)
      throw error
    }
  }

  /** Discover workspace notebooks without activating a cold session. */
  @Remote
  async discover(request: NotebookDiscoverRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookDiscoveryPage>> {
    const access = await this.headerFor(SessionId(request.sessionId), signal)
    if (!access.ok) return access
    const notebooks = this.notebooksFor()
    if (!notebooks.ok) return notebooks
    return await this.execute(async () => {
      const discovered = await notebooks.value.discoverWorkspace(access.value.session, {
        ...request.after === undefined ? {} : { after: request.after },
        signal,
      })
      return {
        items: discovered.items.map(item => ({ path: item.path, ...item.size === undefined ? {} : { size: item.size } })),
        ...discovered.nextAfter === undefined ? {} : { nextAfter: discovered.nextAfter },
        partial: discovered.partial,
      }
    }, signal)
  }

  /** Open an existing notebook in one exact session. */
  @Remote
  async open(request: NotebookOpenRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookDocument>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(() => notebooks.value.open(agent.session, request.path, { signal }), signal)
  }

  /** Create an absent notebook in one exact session. */
  @Remote
  async create(request: NotebookCreateRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookDocument>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(() => notebooks.value.create(agent.session, request.path, { signal }), signal)
  }

  /** Read the environment catalog without activating a cold session. */
  @Remote
  async environmentCatalog(
    request: NotebookEnvironmentCatalogRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookEnvironmentCatalog>> {
    const access = await this.sessionFor(SessionId(request.sessionId), signal)
    if (!access.ok) return access
    const environments = this.environmentsFor()
    if (!environments.ok) return environments
    const operation = this.operationFor(access.value.session, this.ctx, signal)
    if (!operation.ok) return operation
    return await this.execute(() => environments.value.environmentCatalog(operation.value), signal)
  }

  /** Install the private uv manager after explicit user intent. */
  @Remote
  async installUv(request: NotebookSessionRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookEnvironmentCatalog>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const environments = this.environmentsFor(agent)
    if (!environments.ok) return environments
    const operation = this.operationFor(agent.session, agent.ctx, signal)
    if (!operation.ok) return operation
    return await this.execute(() => environments.value.installUv(operation.value), signal)
  }

  /** Install the supported Python line after explicit user intent. */
  @Remote
  async installPython(
    request: NotebookInstallPythonRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookEnvironmentCatalog>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const environments = this.environmentsFor(agent)
    if (!environments.ok) return environments
    const operation = this.operationFor(agent.session, agent.ctx, signal)
    if (!operation.ok) return operation
    return await this.execute(() => environments.value.installPython({ ...operation.value, version: request.version }), signal)
  }

  /** Provision or explicitly claim one workspace environment. */
  @Remote
  async createEnvironment(
    request: NotebookCreateEnvironmentRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookEnvironmentCatalog>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const environments = this.environmentsFor(agent)
    if (!environments.ok) return environments
    const operation = this.operationFor(agent.session, agent.ctx, signal)
    if (!operation.ok) return operation
    return await this.execute(async () => {
      await environments.value.provision({
        ...operation.value,
        environmentId: NotebookEnvironmentId(request.environmentId),
        allowExisting: request.allowExisting,
        rebuild: request.rebuild,
      })
      return await environments.value.environmentCatalog(operation.value)
    }, signal)
  }

  /** Attach a ready workspace environment and start its Jupyter kernel. */
  @Remote
  async attachEnvironment(
    request: NotebookAttachEnvironmentRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookDocument>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const environments = this.environmentsFor(agent)
    if (!environments.ok) return environments
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    const operation = this.operationFor(agent.session, agent.ctx, signal)
    if (!operation.ok) return operation
    return await this.execute(async () => {
      const environmentId = NotebookEnvironmentId(request.environmentId)
      const launch = await environments.value.resolveLaunch({ ...operation.value, environmentId })
      return await notebooks.value.attachEnvironment(
        agent.session,
        NotebookId(request.notebookId),
        environmentId,
        { backend: 'jupyter', kernelName: launch.kernelName, initiator: 'user', signal },
      )
    }, signal)
  }

  /** Read notebook runtime state without activating a cold session. */
  @Remote
  async runtimeStatus(
    request: NotebookRuntimeStatusRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookKernelRuntimeStatus>> {
    const access = await this.sessionFor(SessionId(request.sessionId), signal)
    if (!access.ok) return access
    const notebooks = this.notebooksFor(access.value.agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(
      () => notebooks.value.runtimeStatus(access.value.session, NotebookId(request.notebookId)),
      signal,
    )
  }

  /** Read one verified raster referenced by a document open in this process. */
  @Remote
  async readAttachment(
    request: NotebookReadAttachmentRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookReadAttachmentAck>> {
    const access = await this.agentFor(request.sessionId)
    if (!access.ok) return access
    const notebooks = this.notebooksFor(access.value)
    if (!notebooks.ok) return notebooks
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      return failure({
        source: 'configuration',
        code: 'service-absent',
        message: 'attachment storage is absent: load @deepseek-ai/dsh-attachment',
      })
    }
    const ref = findNotebookImage(notebooks.value.list(access.value.session), request.attachmentId)
    if (ref === undefined) {
      return failure({
        source: 'attachment',
        code: 'ATTACHMENT_NOT_REFERENCED',
        message: 'image is not referenced by a Notebook open in this process',
      })
    }
    try {
      const stored = await attachments.readImage(ref, signal)
      return success({ attachment: stored.ref, data: Buffer.from(stored.data).toString('base64') })
    } catch (error: unknown) {
      if (signal.aborted) {
        return failure({ source: 'cancelled', code: 'cancelled', message: 'notebook attachment read was cancelled' })
      }
      if (error instanceof AttachmentError) {
        return failure({ source: 'attachment', code: error.code, message: error.message })
      }
      throw error
    }
  }

  /** Replace one cell's source. */
  @Remote
  async editCell(request: NotebookEditCellRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookEditCellAck>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(async () => {
      const document = await notebooks.value.editCell(
        agent.session,
        NotebookId(request.notebookId),
        CellId(request.cellId),
        request.source,
        signal,
      )
      return { document }
    }, signal)
  }

  /** Insert one cell after a stable predecessor, or at the start. */
  @Remote
  async insertCell(
    request: NotebookInsertCellRequest,
    signal: AbortSignal,
  ): Promise<NotebookRemoteResult<NotebookInsertCellAck>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(async () => {
      const notebookId = NotebookId(request.notebookId)
      const before = new Set(notebooks.value.get(agent.session, notebookId).cells.map(cell => cell.id))
      const document = await notebooks.value.insertCell(
        agent.session,
        notebookId,
        request.cellType,
        request.afterCellId === undefined ? undefined : CellId(request.afterCellId),
        request.source ?? '',
        signal,
      )
      const inserted = document.cells.find(cell => !before.has(cell.id))
      if (inserted === undefined) throw new Error('inserted notebook cell is missing after append')
      return { cellId: inserted.id, document }
    }, signal)
  }

  /** Execute one cell and inject its bounded result into the initiating Agent. */
  @Remote
  async runCell(request: NotebookRunCellRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookRunAck>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(async () => {
      const notebookId = NotebookId(request.notebookId)
      const cellId = CellId(request.cellId)
      if (request.source !== undefined) {
        await notebooks.value.editCell(agent.session, notebookId, cellId, request.source, signal)
      }
      const result = await notebooks.value.execute(agent.session, notebookId, cellId, { initiator: 'user', signal })
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: renderNotebookInjection(result, this.maxInjectionBytes) }],
        source: { kind: 'plugin', plugin: 'dsh-notebook' },
      }))
      return {
        executionId: result.executionId,
        status: result.status,
        executionCount: result.executionCount,
        ...result.error === undefined ? {} : { error: result.error },
        document: notebooks.value.get(agent.session, notebookId),
      }
    }, signal)
  }

  /** Replace one notebook kernel while retaining its environment. */
  @Remote
  async restart(request: NotebookIdentityRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookKernelAck>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(async () => {
      const document = await notebooks.value.restart(
        agent.session,
        NotebookId(request.notebookId),
        { initiator: 'user', signal },
      )
      const kernel = document.kernel
      if (kernel === undefined) throw new Error('notebook restart completed without a kernel selection')
      return {
        notebookId: document.id,
        environmentId: kernel.environmentId,
        backend: kernel.backend,
        ...kernel.kernelName === undefined ? {} : { kernelName: kernel.kernelName },
        generation: kernel.generation,
        document,
      }
    }, signal)
  }

  /** Accept the current external file revision. */
  @Remote
  async reload(request: NotebookIdentityRequest, signal: AbortSignal): Promise<NotebookRemoteResult<NotebookReloadAck>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(async () => {
      const document = await notebooks.value.reload(
        agent.session,
        NotebookId(request.notebookId),
        { initiator: 'user', signal },
      )
      return { fileVersion: document.fileVersion, document }
    }, signal)
  }

  /** Interrupt the active execution for one notebook. */
  @Remote
  async interrupt(request: NotebookInterruptRequest): Promise<NotebookRemoteResult<NotebookInterruptAck>> {
    const agentAccess = await this.agentFor(request.sessionId)
    if (!agentAccess.ok) return agentAccess
    const agent = agentAccess.value
    const notebooks = this.notebooksFor(agent)
    if (!notebooks.ok) return notebooks
    return await this.execute(() => ({
      interrupted: notebooks.value.interrupt(
        agent.session,
        NotebookId(request.notebookId),
        request.reason,
      ),
    }))
  }
}

export default NotebookRemoteService
