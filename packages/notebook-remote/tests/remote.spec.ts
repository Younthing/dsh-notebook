import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CellId,
  ExecutionId,
  NotebookFileVersion,
  NotebookId,
  NotebookError,
  NotebookPersistenceError,
} from '@deepseek-ai/dsh-notebook-core'
import type { NotebookDiscoveryOptions } from '@deepseek-ai/dsh-notebook-core'
import {
  NotebookEnvironmentError,
  NotebookEnvironmentId,
} from '@deepseek-ai/dsh-notebook-environment'
import type {
  NotebookEnvironmentOperationRequest,
  NotebookEnvironmentProvisionRequest,
} from '@deepseek-ai/dsh-notebook-environment'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { NotebookRemoteService } from '../src/index.ts'
import type { NotebookRemoteResult } from '../src/types.ts'

const RpcId = (value: string): string => value

function createApiProxy(ctx: Context, config: {
  readonly notebookMaxInjectionBytes?: number
  readonly [key: string]: unknown
}) {
  const remote = new NotebookRemoteService(ctx, config.notebookMaxInjectionBytes === undefined
    ? {}
    : { maxInjectionBytes: config.notebookMaxInjectionBytes })
  const wrap = <P, R>(method: (request: P, signal: AbortSignal) => Promise<NotebookRemoteResult<R>>) => (
    async (
      request: { readonly rpcId: string; readonly payload: P },
      signal = new AbortController().signal,
    ) => ({
      rpcId: request.rpcId,
      result: await method.call(remote, request.payload, signal),
    })
  )
  return {
    notebooks: {
      discover: wrap(remote.discover),
      open: wrap(remote.open),
      create: wrap(remote.create),
      environmentCatalog: wrap(remote.environmentCatalog),
      installUv: wrap(remote.installUv),
      installPython: wrap(remote.installPython),
      createEnvironment: wrap(remote.createEnvironment),
      attachEnvironment: wrap(remote.attachEnvironment),
      runtimeStatus: wrap(remote.runtimeStatus),
      readAttachment: wrap(remote.readAttachment),
      editCell: wrap(remote.editCell),
      insertCell: wrap(remote.insertCell),
      runCell: wrap(remote.runCell),
      restart: wrap(remote.restart),
      reload: wrap(remote.reload),
      interrupt: wrap(remote.interrupt),
    },
  }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(AgentRegistry)
  const session = ctx.sessions.create(SessionId('notebook-host'))
  const injected: UserMessage[] = []
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    inject: vi.fn((message: UserMessage) => { injected.push(message) }),
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, session, agent, injected }
}

const document = (path = 'analysis.ipynb') => ({
  id: NotebookId('notebook-host'),
  path,
  fileVersion: NotebookFileVersion('v1'),
  nbformatMinor: 5,
  metadata: {},
  cells: [],
})

const catalog = {
  manager: { status: 'ready' as const, version: '0.8.0', canInstall: false },
  pythons: [{ id: 'managed-3.12', version: '3.12.8', source: 'managed' as const }],
  environments: [{
    id: NotebookEnvironmentId('workspace-default'),
    displayName: 'Workspace Python 3.12',
    status: 'ready' as const,
    pythonVersion: '3.12.8',
    managed: true,
  }],
}

describe('createApiProxy notebook domain', () => {
  it('uses the strict open and create service operations and returns complete documents', async () => {
    const { ctx, session } = await harness()
    const open = vi.fn().mockResolvedValue(document('existing.ipynb'))
    const create = vi.fn().mockResolvedValue(document('new.ipynb'))
    ctx.provide('notebooks', { open, create } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })
    const abort = new AbortController()

    const opened = await api.notebooks.open({
      rpcId: RpcId('notebook-open'),
      payload: { sessionId: session.id, path: 'existing.ipynb' },
    }, abort.signal)
    const created = await api.notebooks.create({
      rpcId: RpcId('notebook-create'),
      payload: { sessionId: session.id, path: 'new.ipynb' },
    }, abort.signal)

    expect(opened.result).toEqual({ ok: true, value: document('existing.ipynb') })
    expect(created.result).toEqual({ ok: true, value: document('new.ipynb') })
    expect(open).toHaveBeenCalledWith(session, 'existing.ipynb', { signal: abort.signal })
    expect(create).toHaveBeenCalledWith(session, 'new.ipynb', { signal: abort.signal })
  })

  it('discovers and reads cold notebook state without resuming an Agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: 'C:/fallback' })
    const sessionId = SessionId('cold-notebook')
    const header = {
      version: 0,
      id: sessionId,
      createdAt: 1,
      cwd: 'C:/workspace',
    } satisfies SessionHeader
    const events = [{
      type: 'sandbox/mode',
      seq: 0,
      time: 2,
      data: { mode: 'workspace-write' },
    }] satisfies SessionEvent[]
    const list = vi.fn().mockResolvedValue([header])
    const inspect = vi.fn().mockResolvedValue({ meta: header, events })
    ctx.provide('sessionPersistence', { list, inspect } as never)
    const discoverWorkspace = vi.fn((session: Session, options: NotebookDiscoveryOptions) => {
      expect(session.header).toEqual(header)
      expect(session.events).toEqual([])
      expect(options).toMatchObject({ after: 'archive/old.ipynb' })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve({
        items: [{ path: 'reports/current.ipynb', size: 42 }],
        partial: false,
      })
    })
    const runtimeStatus = vi.fn((session: Session) => {
      expect(session.events).toContainEqual(events[0])
      return { status: 'detached' as const }
    })
    ctx.provide('notebooks', { discoverWorkspace, runtimeStatus } as never)
    const environmentCatalog = vi.fn((_operation: NotebookEnvironmentOperationRequest) => (
      Promise.resolve(catalog)
    ))
    ctx.provide('notebookEnvironments', { environmentCatalog } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: 'C:/fallback',
    })

    const discovered = await api.notebooks.discover({
      rpcId: RpcId('notebook-discover'),
      payload: { sessionId, after: 'archive/old.ipynb' },
    })
    expect(discovered.result).toEqual({
      ok: true,
      value: { items: [{ path: 'reports/current.ipynb', size: 42 }], partial: false },
    })
    expect(list).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])

    const catalogResponse = await api.notebooks.environmentCatalog({
      rpcId: RpcId('notebook-catalog'),
      payload: { sessionId },
    })
    expect(catalogResponse.result).toEqual({ ok: true, value: catalog })
    expect(environmentCatalog).toHaveBeenCalledOnce()
    const operation = environmentCatalog.mock.calls[0]?.[0]
    expect(operation?.workspaceRoot).toBe(resolve('C:/workspace'))
    expect(operation?.sandboxPolicy).toEqual({
      mode: 'workspace-write',
      workspaceRoot: resolve('C:/workspace'),
      sessionId,
    })
    expect(operation?.signal).toBeInstanceOf(AbortSignal)
    expect(inspect).toHaveBeenCalledOnce()
    expect(ctx.agents.list()).toEqual([])

    const runtime = await api.notebooks.runtimeStatus({
      rpcId: RpcId('notebook-runtime'),
      payload: { sessionId, notebookId: NotebookId('notebook-host') },
    })
    expect(runtime.result).toEqual({ ok: true, value: { status: 'detached' } })
    expect(runtimeStatus).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(ctx.agents.list()).toEqual([])
  })

  it('keeps the subagent ownership fence on cold discovery headers', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(AgentRegistry)
    const sessionId = SessionId('cold-subagent-notebook')
    const header = {
      version: 0,
      id: sessionId,
      createdAt: 1,
      cwd: 'C:/workspace',
      origin: 'subagent',
      parentSession: SessionId('parent'),
    } satisfies SessionHeader
    const inspect = vi.fn()
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header]),
      inspect,
    } as never)
    const discoverWorkspace = vi.fn()
    ctx.provide('notebooks', { discoverWorkspace } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: 'C:/fallback',
    })

    const response = await api.notebooks.discover({
      rpcId: RpcId('notebook-subagent-discover'),
      payload: { sessionId },
    })

    expect(response.result).toEqual({
      ok: false,
      error: {
        source: 'session',
        code: 'subagent-owned',
        message: `session "${sessionId}" is owned by subagent routing`,
      },
    })
    expect(discoverWorkspace).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
  })

  it('keeps Host-only launch paths off attach responses and serializes environment failures', async () => {
    const { ctx, session } = await harness()
    ctx.provide('sandboxPolicy', {
      resolve: () => ({
        mode: 'workspace-write',
        workspaceRoot: resolve('/workspace'),
        sessionId: session.id,
      }),
    } as never)
    const resolveLaunch = vi.fn().mockResolvedValue({
      environmentId: NotebookEnvironmentId('workspace-default'),
      pythonExecutable: resolve('/workspace/.venv/Scripts/python.exe'),
      kernelName: 'python3',
    })
    const installUv = vi.fn().mockRejectedValue(new NotebookEnvironmentError(
      'uv installation needs permission',
      'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      'permission',
      false,
    ))
    const provision = vi.fn((_request: NotebookEnvironmentProvisionRequest) => (
      Promise.resolve(catalog.environments[0])
    ))
    const environmentCatalog = vi.fn().mockResolvedValue(catalog)
    ctx.provide('notebookEnvironments', {
      resolveLaunch,
      installUv,
      provision,
      environmentCatalog,
    } as never)
    const attachedDocument = {
      ...document(),
      kernel: {
        environmentId: NotebookEnvironmentId('workspace-default'),
        backend: 'jupyter',
        kernelName: 'python3',
        generation: 1,
      },
    }
    const attachEnvironment = vi.fn().mockResolvedValue(attachedDocument)
    ctx.provide('notebooks', { attachEnvironment } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })

    const attached = await api.notebooks.attachEnvironment({
      rpcId: RpcId('notebook-attach'),
      payload: {
        sessionId: session.id,
        notebookId: NotebookId('notebook-host'),
        environmentId: NotebookEnvironmentId('workspace-default'),
      },
    })
    expect(attached.result).toEqual({ ok: true, value: attachedDocument })
    expect(JSON.stringify(attached)).not.toContain('python.exe')
    expect(attachEnvironment).toHaveBeenCalledWith(
      session,
      NotebookId('notebook-host'),
      NotebookEnvironmentId('workspace-default'),
      expect.objectContaining({ backend: 'jupyter', kernelName: 'python3', initiator: 'user' }),
    )

    const rebuilt = await api.notebooks.createEnvironment({
      rpcId: RpcId('notebook-rebuild'),
      payload: {
        sessionId: session.id,
        environmentId: NotebookEnvironmentId('workspace-default'),
        allowExisting: false,
        rebuild: true,
      },
    })
    expect(rebuilt.result).toEqual({ ok: true, value: catalog })
    expect(provision).toHaveBeenCalledOnce()
    const provisionRequest = provision.mock.calls[0]?.[0]
    expect(provisionRequest).toMatchObject({
      environmentId: NotebookEnvironmentId('workspace-default'),
      allowExisting: false,
      rebuild: true,
    })

    const refused = await api.notebooks.installUv({
      rpcId: RpcId('notebook-install-uv'),
      payload: { sessionId: session.id },
    })
    expect(refused.result).toEqual({
      ok: false,
      error: {
        source: 'environment',
        code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
        message: 'uv installation needs permission',
        category: 'permission',
        retryable: false,
      },
    })
  })

  it('preserves stable core discovery errors on the RPC refusal', async () => {
    const { ctx, session } = await harness()
    ctx.provide('notebooks', {
      discoverWorkspace: vi.fn().mockRejectedValue(new NotebookError(
        'the discovery cursor no longer exists',
        'DISCOVERY_CURSOR_STALE',
      )),
    } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })

    const response = await api.notebooks.discover({
      rpcId: RpcId('notebook-stale-cursor'),
      payload: { sessionId: session.id, after: 'removed.ipynb' },
    })
    expect(response.result).toEqual({
      ok: false,
      error: {
        source: 'core',
        code: 'DISCOVERY_CURSOR_STALE',
        message: 'the discovery cursor no longer exists',
      },
    })
  })

  it('routes a real runCell call and byte-bounds the status-first Agent injection', async () => {
    const { ctx, session, injected } = await harness()
    const editCell = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn().mockResolvedValue({
      executionId: ExecutionId('execution-host'),
      outputs: [{ type: 'stream', name: 'stderr', text: '🙂'.repeat(200) }],
      status: 'error',
      executionCount: 7,
      error: 'kernel rejected the cell',
    })
    ctx.provide('notebooks', { editCell, execute } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
      notebookMaxInjectionBytes: 128,
    })
    const abort = new AbortController()

    const response = await api.notebooks.runCell({
      rpcId: RpcId('notebook-run'),
      payload: {
        sessionId: session.id,
        notebookId: NotebookId('notebook-host'),
        cellId: CellId('cell-host'),
        source: 'raise RuntimeError("broken")',
      },
    }, abort.signal)

    expect(response.result).toEqual({
      ok: true,
      value: {
        executionId: ExecutionId('execution-host'),
        status: 'error',
        executionCount: 7,
        error: 'kernel rejected the cell',
      },
    })
    expect(editCell).toHaveBeenCalledWith(
      session,
      NotebookId('notebook-host'),
      CellId('cell-host'),
      'raise RuntimeError("broken")',
      abort.signal,
    )
    expect(execute).toHaveBeenCalledWith(
      session,
      NotebookId('notebook-host'),
      CellId('cell-host'),
      { initiator: 'user', signal: abort.signal },
    )
    expect(injected).toHaveLength(1)
    const content = injected[0]?.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') throw new Error('expected a text notebook injection')
    expect(Buffer.byteLength(content.text, 'utf8')).toBeLessThanOrEqual(128)
    expect(content.text).toContain('Notebook cell execution error; execution count 7.')
    expect(content.text).toContain('Error: kernel rejected the cell')
    expect(content.text).toContain('[notebook output truncated]')
    expect(content.text).not.toContain('�')
  })

  it('answers through the real gateway when the notebook seam is absent', async () => {
    const { ctx, session } = await harness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })

    const response = await api.notebooks.runCell({
      rpcId: RpcId('notebook-absent'),
      payload: {
        sessionId: session.id,
        notebookId: NotebookId('missing-notebook'),
        cellId: CellId('missing-cell'),
      },
    })

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected notebook-absent error')
    expect(response.result.error.code).toBe('service-absent')
    expect(response.result.error.source).toBe('configuration')
    expect(response.result.error.message).toContain('notebook service is absent')
  })

  it('preserves stable persistence error codes on the RPC refusal', async () => {
    const { ctx, session } = await harness()
    ctx.provide('notebooks', {
      editCell: vi.fn().mockRejectedValue(new NotebookPersistenceError(
        'the notebook changed outside this session',
        'WRITE_CONFLICT',
      )),
    } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })

    const response = await api.notebooks.editCell({
      rpcId: RpcId('notebook-write-conflict'),
      payload: {
        sessionId: session.id,
        notebookId: NotebookId('notebook-host'),
        cellId: CellId('cell-host'),
        source: 'changed',
      },
    })

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected notebook persistence refusal')
    expect(response.result.error).toEqual({
      source: 'persistence',
      code: 'WRITE_CONFLICT',
      message: 'the notebook changed outside this session',
    })
  })

  it('keeps unexpected notebook failure details in Host logs', async () => {
    const { ctx, session } = await harness()
    const failure = new Error('failed at C:\\private\\workspace\\analysis.ipynb')
    ctx.provide('notebooks', {
      editCell: vi.fn().mockRejectedValue(failure),
    } as never)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })

    const response = api.notebooks.editCell({
      rpcId: RpcId('notebook-unexpected-error'),
      payload: {
        sessionId: session.id,
        notebookId: NotebookId('notebook-host'),
        cellId: CellId('cell-host'),
        source: 'changed',
      },
    })
    await expect(response).rejects.toBe(failure)
    expect(logged).toHaveBeenNthCalledWith(1, 'notebook operation failed unexpectedly')
    expect(logged).toHaveBeenNthCalledWith(2, failure)
  })

  it('reports caller abort as cancellation instead of an internal failure', async () => {
    const { ctx, session } = await harness()
    ctx.provide('notebooks', {
      editCell: vi.fn().mockRejectedValue(new Error('storage observed abort')),
    } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })
    const abort = new AbortController()
    abort.abort('caller cancelled')

    const response = await api.notebooks.editCell({
      rpcId: RpcId('notebook-cancelled'),
      payload: {
        sessionId: session.id,
        notebookId: NotebookId('notebook-host'),
        cellId: CellId('cell-host'),
        source: 'changed',
      },
    }, abort.signal)

    expect(response.result).toEqual({
      ok: false,
      error: { source: 'cancelled', code: 'cancelled', message: 'notebook operation was cancelled' },
    })
  })

  it('routes reload as a user-initiated full-document recovery', async () => {
    const { ctx, session } = await harness()
    const reload = vi.fn().mockResolvedValue({
      id: NotebookId('notebook-host'),
      path: 'analysis.ipynb',
      fileVersion: NotebookFileVersion('v3'),
      nbformatMinor: 5,
      metadata: { external: true },
      cells: [],
    })
    ctx.provide('notebooks', { reload } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'test' }),
      cwd: '/workspace',
    })
    const abort = new AbortController()

    const response = await api.notebooks.reload({
      rpcId: RpcId('notebook-reload'),
      payload: { sessionId: session.id, notebookId: NotebookId('notebook-host') },
    }, abort.signal)

    expect(response.result).toEqual({
      ok: true,
      value: { fileVersion: NotebookFileVersion('v3') },
    })
    expect(reload).toHaveBeenCalledWith(
      session,
      NotebookId('notebook-host'),
      { initiator: 'user', signal: abort.signal },
    )
  })
})
