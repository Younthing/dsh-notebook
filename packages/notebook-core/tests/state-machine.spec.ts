import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import NotebookService, { MemoryKernelBackend } from '@younthing/dsh-notebook-core'
import { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment'
import type {
  Config,
  NotebookKernelBackend,
  NotebookKernelExecutionEvent,
  NotebookKernelHandle,
  NotebookKernelStartSpec,
} from '@younthing/dsh-notebook-core'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createTestFileState,
  TestAttachmentStore,
  TestFileSystem,
} from './helpers.ts'
import type { TestFileState } from './helpers.ts'

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function boot(config: Config = {}, state: TestFileState = createTestFileState()): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
  await ctx.plugin(TestAttachmentStore)
  await ctx.plugin(TestFileSystem, { state })
  await ctx.plugin(NotebookService, config)
  return ctx
}

async function bootWithSessions(
  config: Config = {},
  state: TestFileState = createTestFileState(),
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
  await ctx.plugin(TestAttachmentStore)
  await ctx.plugin(TestFileSystem, { state })
  await ctx.plugin(NotebookService, config)
  return ctx
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 50; attempts += 1) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition did not become true')
}

async function openAttached(
  ctx: Context,
  session: Session,
  path: string,
  backend: string,
  kernelName?: string,
) {
  let document
  try {
    document = await ctx.notebooks.open(session, path)
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'NOT_FOUND') throw error
    document = await ctx.notebooks.create(session, path)
  }
  return await ctx.notebooks.attachEnvironment(
    session,
    document.id,
    NotebookEnvironmentId(`${session.id}:${path}`),
    {
      backend,
      initiator: 'agent',
      ...kernelName === undefined ? {} : { kernelName },
    },
  )
}

function notebookText(source: string, cellId = 'external-cell', kernelName?: string): string {
  return JSON.stringify({
    cells: [{
      cell_type: 'code',
      execution_count: null,
      id: cellId,
      metadata: {},
      outputs: [],
      source,
    }],
    metadata: kernelName === undefined ? {} : { kernelspec: { name: kernelName } },
    nbformat: 4,
    nbformat_minor: 5,
  })
}

interface ControlledHandle {
  readonly notebookId: string
}

class ControlledBackend implements NotebookKernelBackend {
  readonly type = 'controlled'
  readonly starts: NotebookKernelStartSpec[] = []
  readonly executions: {
    readonly handle: ControlledHandle
    readonly gate: Deferred
    readonly signal: AbortSignal
  }[] = []
  readonly inspections: { readonly handle: ControlledHandle; readonly name: string; readonly signal: AbortSignal }[] = []
  readonly shutdowns: ControlledHandle[] = []

  start(spec: NotebookKernelStartSpec): Promise<NotebookKernelHandle> {
    this.starts.push(spec)
    return Promise.resolve({ notebookId: spec.notebookId } satisfies ControlledHandle)
  }

  async *execute(
    handle: NotebookKernelHandle,
    _source: string,
    signal: AbortSignal,
  ): AsyncIterable<NotebookKernelExecutionEvent> {
    const gate = deferred()
    this.executions.push({ handle: handle as ControlledHandle, gate, signal })
    await Promise.race([
      gate.promise,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
      }),
    ])
    yield { type: 'complete', status: 'ok', executionCount: 1 }
  }

  inspect(handle: NotebookKernelHandle, name: string, signal: AbortSignal): Promise<string> {
    this.inspections.push({ handle: handle as ControlledHandle, name, signal })
    signal.throwIfAborted()
    return Promise.resolve(name)
  }

  shutdown(handle: NotebookKernelHandle, _signal: AbortSignal): Promise<void> {
    this.shutdowns.push(handle as ControlledHandle)
    return Promise.resolve()
  }
}

describe('NotebookService kernel state machine', () => {
  it('mints ids from durable history after a service restart', async () => {
    const session = Session.create(SessionId('notebook-restart'))
    const firstCtx = await boot()
    firstCtx.notebooks.registerBackend(new MemoryKernelBackend())
    const first = await openAttached(firstCtx, session, 'first.ipynb', 'memory')
    const firstExecution = await firstCtx.notebooks.execute(
      session,
      first.id,
      first.cells[0]!.id,
      { initiator: 'agent' },
    )
    await firstCtx.fiber.dispose()

    const secondCtx = await boot()
    secondCtx.notebooks.registerBackend(new MemoryKernelBackend())
    const second = await openAttached(secondCtx, session, 'second.ipynb', 'memory')
    const secondExecution = await secondCtx.notebooks.execute(
      session,
      second.id,
      second.cells[0]!.id,
      { initiator: 'agent' },
    )

    expect(second.id).not.toBe(first.id)
    expect(second.cells[0]!.id).not.toBe(first.cells[0]!.id)
    expect(secondExecution.executionId).not.toBe(firstExecution.executionId)
    await secondCtx.fiber.dispose()
  })

  it('isolates equal notebook ids across sessions', async () => {
    const ctx = await boot()
    ctx.notebooks.registerBackend(new MemoryKernelBackend())
    const firstSession = Session.create(SessionId('notebook-isolation-a'))
    const secondSession = Session.create(SessionId('notebook-isolation-b'))
    const first = await openAttached(ctx, firstSession, 'shared.ipynb', 'memory')
    const second = await openAttached(ctx, secondSession, 'shared.ipynb', 'memory')
    expect(first.id).toBe(second.id)

    await ctx.notebooks.editCell(firstSession, first.id, first.cells[0]!.id, 'secret = 42')
    await ctx.notebooks.execute(firstSession, first.id, first.cells[0]!.id, { initiator: 'agent' })
    expect(await ctx.notebooks.inspect(firstSession, first.id, 'secret', { initiator: 'agent' })).toContain('42')
    expect(await ctx.notebooks.inspect(secondSession, second.id, 'secret', { initiator: 'agent' })).toBe('secret is not defined')
    await ctx.fiber.dispose()
  })

  it('serializes one kernel while allowing different kernels to run concurrently', async () => {
    const ctx = await boot()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-serialization'))
    const first = await openAttached(ctx, session, 'first.ipynb', backend.type)
    const second = await openAttached(ctx, session, 'second.ipynb', backend.type)

    const firstRun = ctx.notebooks.execute(session, first.id, first.cells[0]!.id, { initiator: 'agent' })
    const queuedRun = ctx.notebooks.execute(session, first.id, first.cells[0]!.id, { initiator: 'user' })
    await waitUntil(() => backend.executions.length === 1)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(backend.executions).toHaveLength(1)

    const parallelRun = ctx.notebooks.execute(session, second.id, second.cells[0]!.id, { initiator: 'agent' })
    await waitUntil(() => backend.executions.length === 2)
    backend.executions[0]!.gate.resolve()
    backend.executions[1]!.gate.resolve()
    await waitUntil(() => backend.executions.length === 3)
    backend.executions[2]!.gate.resolve()
    const outcomes = await Promise.all([firstRun, queuedRun, parallelRun])
    expect(new Set(outcomes.map(outcome => outcome.executionId))).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('retires an idle kernel synchronously when its durable sandbox policy changes', async () => {
    const ctx = await bootWithSessions()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = ctx.sessions.create(SessionId('notebook-policy-idle'))
    const opened = await openAttached(ctx, session, 'policy-idle.ipynb', backend.type)
    const service = ctx.notebooks as unknown as {
      runtimes: WeakMap<Session, {
        kernels: Map<unknown, { state: string; controller: AbortController }>
      }>
    }
    const runtime = service.runtimes.get(session)
    const record = runtime?.kernels.get(opened.id)
    if (runtime === undefined || record === undefined) throw new Error('active kernel record was not retained')

    expect(backend.starts[0]?.sandboxPolicy.mode).toBe('danger-full-access')
    setSandboxMode(session, 'workspace-write')

    expect(record.state).toBe('closing')
    expect(record.controller.signal.aborted).toBe(true)
    expect(runtime.kernels.has(opened.id)).toBe(false)
    await waitUntil(() => backend.shutdowns.length === 1)
    expect(ctx.notebooks.runtimeStatus(session, opened.id)).toMatchObject({ status: 'stopped' })
    expect(backend.executions).toHaveLength(0)

    await ctx.notebooks.restart(session, opened.id, { initiator: 'user' })
    expect(backend.starts[1]?.sandboxPolicy.mode).toBe('workspace-write')
    await ctx.fiber.dispose()
  })

  it('aborts active and queued kernel work synchronously on a sandbox policy change', async () => {
    const ctx = await bootWithSessions()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = ctx.sessions.create(SessionId('notebook-policy-active'))
    const opened = await openAttached(ctx, session, 'policy-active.ipynb', backend.type)
    const service = ctx.notebooks as unknown as {
      runtimes: WeakMap<Session, {
        kernels: Map<unknown, { state: string; controller: AbortController }>
      }>
    }
    const runtime = service.runtimes.get(session)
    const record = runtime?.kernels.get(opened.id)
    if (runtime === undefined || record === undefined) throw new Error('active kernel record was not retained')
    const active = ctx.notebooks.execute(session, opened.id, opened.cells[0]!.id, { initiator: 'user' })
    const queued = ctx.notebooks.execute(session, opened.id, opened.cells[0]!.id, { initiator: 'agent' })
    await waitUntil(() => backend.executions.length === 1)

    setSandboxMode(session, 'workspace-write')

    expect(record.state).toBe('closing')
    expect(record.controller.signal.aborted).toBe(true)
    expect(backend.executions[0]!.signal.aborted).toBe(true)
    expect(runtime.kernels.has(opened.id)).toBe(false)
    expect(backend.executions).toHaveLength(1)
    await expect(active).rejects.toMatchObject({ code: 'KERNEL_UNAVAILABLE' })
    await expect(queued).rejects.toMatchObject({ code: 'KERNEL_UNAVAILABLE' })
    await waitUntil(() => backend.shutdowns.length === 1)
    await ctx.fiber.dispose()
  })

  it('defensively rejects execute and inspect when an unattached session policy drifts', async () => {
    const ctx = await boot()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-policy-defensive'))
    const executable = await openAttached(ctx, session, 'policy-execute.ipynb', backend.type)
    const inspectable = await openAttached(ctx, session, 'policy-inspect.ipynb', backend.type)

    setSandboxMode(session, 'workspace-write')

    await expect(ctx.notebooks.execute(
      session,
      executable.id,
      executable.cells[0]!.id,
      { initiator: 'user' },
    )).rejects.toMatchObject({ code: 'KERNEL_UNAVAILABLE' })
    await expect(ctx.notebooks.inspect(session, inspectable.id, 'secret', { initiator: 'agent' }))
      .rejects.toMatchObject({ code: 'KERNEL_UNAVAILABLE' })
    expect(backend.executions).toHaveLength(0)
    expect(backend.inspections).toHaveLength(0)
    await waitUntil(() => backend.shutdowns.length === 2)
    await ctx.fiber.dispose()
  })

  it('closes a kernel whose sandbox policy changes before startup can publish it', async () => {
    const ctx = await bootWithSessions()
    const backend = new ControlledBackend()
    const startEntered = deferred()
    const startGate = deferred()
    const shutdownGate = deferred()
    const originalStart = backend.start.bind(backend)
    const session = ctx.sessions.create(SessionId('notebook-policy-start-race'))
    let startupSignalAborted = false
    backend.start = async (spec) => {
      startEntered.resolve()
      await startGate.promise
      const handle = await originalStart(spec)
      setSandboxMode(session, 'workspace-write')
      startupSignalAborted = spec.signal.aborted
      return handle
    }
    backend.shutdown = async (handle) => {
      backend.shutdowns.push(handle as ControlledHandle)
      await shutdownGate.promise
    }
    ctx.notebooks.registerBackend(backend)

    const opening = openAttached(ctx, session, 'policy-start-race.ipynb', backend.type)
    await startEntered.promise
    startGate.resolve()
    await expect(opening).rejects.toMatchObject({ code: 'KERNEL_UNAVAILABLE' })
    await expect(opening).rejects.toThrow('sandbox policy changed; explicit restart/reload required')
    await waitUntil(() => backend.shutdowns.length === 1)
    expect(startupSignalAborted).toBe(true)
    expect(backend.starts[0]?.sandboxPolicy.mode).toBe('danger-full-access')
    expect(ctx.notebooks.list(session)).toHaveLength(1)
    expect(ctx.notebooks.list(session)[0]?.kernel).toBeUndefined()
    expect((ctx.fs as TestFileSystem).text('policy-start-race.ipynb')).toBeDefined()

    let disposed = false
    const disposing = ctx.fiber.dispose().then(() => { disposed = true })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    shutdownGate.resolve()
    await disposing
  })

  it('retains the document when its environment fails to start', async () => {
    const ctx = await boot()
    const backend: NotebookKernelBackend = {
      type: 'broken',
      start: () => Promise.reject(new Error('start failed')),
      execute: () => { throw new Error('unreachable') },
      inspect: () => Promise.reject(new Error('unreachable')),
      shutdown: () => Promise.reject(new Error('unreachable')),
    }
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-start-failure'))

    await expect(openAttached(ctx, session, 'broken.ipynb', backend.type)).rejects.toThrow('start failed')
    expect(session.events).toEqual([])
    expect(ctx.notebooks.list(session)).toHaveLength(1)
    expect((ctx.fs as TestFileSystem).text('broken.ipynb')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('publishes one winner for concurrent absent-only creates', async () => {
    const ctx = await boot()
    const session = Session.create(SessionId('notebook-open-coalesce'))

    const outcomes = await Promise.allSettled([
      ctx.notebooks.create(session, 'same.ipynb'),
      ctx.notebooks.create(session, 'same.ipynb'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toMatchObject([{
      reason: { code: 'ALREADY_EXISTS' },
    }])
    expect(ctx.notebooks.list(session)).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects a guarded create race without publishing notebook events', async () => {
    const state = createTestFileState()
    const ctx = await boot({}, state)
    const session = Session.create(SessionId('notebook-create-race'))
    state.beforeWrite = () => {
      (ctx.fs as TestFileSystem).putText('raced.ipynb', notebookText('external'))
    }

    await expect(ctx.notebooks.create(session, 'raced.ipynb'))
      .rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(session.events).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps kernel attachment independent from an external document change', async () => {
    const state = createTestFileState()
    const ctx = await boot({}, state)
    const fs = ctx.fs as TestFileSystem
    fs.putText('changing.ipynb', notebookText('before'))
    const backend = new ControlledBackend()
    const startGate = deferred()
    const startEntered = deferred()
    const originalStart = backend.start.bind(backend)
    backend.start = async (spec) => {
      startEntered.resolve()
      await startGate.promise
      return await originalStart(spec)
    }
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-open-toctou'))

    const opening = openAttached(ctx, session, 'changing.ipynb', backend.type)
    await startEntered.promise
    fs.putText('changing.ipynb', notebookText('after'))
    startGate.resolve()
    const attached = await opening
    expect(attached).toMatchObject({ kernel: { generation: 1 } })
    expect(ctx.notebooks.get(session, attached.id).kernel?.generation).toBe(1)
    expect(backend.shutdowns).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('persists cancellation as a terminal outcome and requires explicit restart', async () => {
    const ctx = await boot()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-interrupt'))
    const opened = await openAttached(ctx, session, 'interrupt.ipynb', backend.type)
    const running = ctx.notebooks.execute(
      session,
      opened.id,
      opened.cells[0]!.id,
      { initiator: 'user' },
    )
    await waitUntil(() => backend.executions.length === 1)

    expect(ctx.notebooks.interrupt(session, opened.id, 'user stopped execution')).toBe(true)
    expect(ctx.notebooks.interrupt(session, opened.id)).toBe(false)
    await expect(running).resolves.toMatchObject({ status: 'cancelled', error: 'user stopped execution' })
    await expect(ctx.notebooks.inspect(session, opened.id, 'x', { initiator: 'user' })).resolves.toBe('x')
    const restarted = await ctx.notebooks.restart(session, opened.id, { initiator: 'user' })
    expect(restarted.kernel?.generation).toBe(3)
    expect(backend.starts).toHaveLength(3)
    await ctx.fiber.dispose()
  })

  it('restarts an idle kernel and publishes its replacement generation', async () => {
    const ctx = await boot()
    ctx.notebooks.registerBackend(new MemoryKernelBackend())
    const session = Session.create(SessionId('notebook-restart-kernel'))
    const opened = await openAttached(ctx, session, 'restart.ipynb', 'memory')
    await ctx.notebooks.editCell(session, opened.id, opened.cells[0]!.id, 'secret = 42')
    await ctx.notebooks.execute(session, opened.id, opened.cells[0]!.id, { initiator: 'agent' })
    expect(await ctx.notebooks.inspect(session, opened.id, 'secret', { initiator: 'agent' })).toContain('42')

    const restarted = await ctx.notebooks.restart(session, opened.id, { initiator: 'user' })
    expect(restarted.kernel?.generation).toBe(2)
    expect(await ctx.notebooks.inspect(session, opened.id, 'secret', { initiator: 'agent' })).toBe('secret is not defined')
    expect(session.events).toEqual([])
    await ctx.fiber.dispose()
  })

  it('persists raw and markdown inserts without code-only imported fields', async () => {
    const ctx = await boot()
    ctx.notebooks.registerBackend(new MemoryKernelBackend())
    const session = Session.create(SessionId('notebook-non-code-insert'))
    const opened = await openAttached(ctx, session, 'non-code.ipynb', 'memory')

    const raw = await ctx.notebooks.insertCell(session, opened.id, 'raw', undefined, 'raw text')
    const markdown = await ctx.notebooks.insertCell(
      session,
      opened.id,
      'markdown',
      raw.cells[0]!.id,
      '# heading',
    )
    expect(markdown.cells.slice(0, 2).map(cell => [cell.cellType, cell.source])).toEqual([
      ['raw', 'raw text'],
      ['markdown', '# heading'],
    ])
    await ctx.fiber.dispose()
  })

  it.skip('keeps the logged revision authoritative when insert publication fails', async () => {
    const ctx = await boot()
    const fs = ctx.fs as TestFileSystem
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-insert-append-failure'))
    const opened = await openAttached(ctx, session, 'insert-failure.ipynb', backend.type)
    const eventCount = session.events.length
    const originalAppend = session.append.bind(session)
    Object.defineProperty(session, 'append', {
      configurable: true,
      value: (type: string, data: unknown) => {
        if (type === 'notebook/cell') throw new Error('insert append failed')
        const result: unknown = Reflect.apply(originalAppend, session, [type, data])
        return result
      },
    })

    await expect(ctx.notebooks.insertCell(session, opened.id, 'raw', undefined, 'externalized'))
      .rejects.toThrow('insert append failed')
    Object.defineProperty(session, 'append', { configurable: true, value: originalAppend })
    expect(session.events).toHaveLength(eventCount)
    expect(ctx.notebooks.get(session, opened.id).cells).toHaveLength(1)
    expect(fs.text('insert-failure.ipynb')).toContain('externalized')
    await expect(ctx.notebooks.editCell(session, opened.id, opened.cells[0]!.id, 'stale'))
      .rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    const recovered = await ctx.notebooks.reload(session, opened.id, { initiator: 'user' })
    expect(recovered.cells.map(cell => cell.source)).toContain('externalized')
    await ctx.fiber.dispose()
  })

  it.skip('retires changed kernel state when execution publication fails', async () => {
    const ctx = await boot()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-execute-append-failure'))
    const opened = await openAttached(ctx, session, 'execute-failure.ipynb', backend.type)
    const eventCount = session.events.length
    const originalAppend = session.append.bind(session)
    Object.defineProperty(session, 'append', {
      configurable: true,
      value: (type: string, data: unknown) => {
        if (type === 'notebook/execute') throw new Error('execute append failed')
        const result: unknown = Reflect.apply(originalAppend, session, [type, data])
        return result
      },
    })

    const execution = ctx.notebooks.execute(
      session,
      opened.id,
      opened.cells[0]!.id,
      { initiator: 'user' },
    )
    await waitUntil(() => backend.executions.length === 1)
    backend.executions[0]!.gate.resolve()
    await expect(execution).rejects.toThrow('execute append failed')
    Object.defineProperty(session, 'append', { configurable: true, value: originalAppend })
    expect(session.events).toHaveLength(eventCount)
    expect(ctx.notebooks.get(session, opened.id).cells[0]!.executionCount).toBeUndefined()
    expect(backend.shutdowns).toHaveLength(1)
    await expect(ctx.notebooks.inspect(session, opened.id, 'lost-state', { initiator: 'agent' }))
      .resolves.toBe('lost-state')
    const recovered = await ctx.notebooks.reload(session, opened.id, { initiator: 'user' })
    expect(recovered.cells[0]!.executionCount).toBe(1)
    await ctx.fiber.dispose()
  })

  it.skip('restores the prior live kernel when restart publication fails', async () => {
    const ctx = await boot()
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-restart-append-failure'))
    const opened = await openAttached(ctx, session, 'restart-failure.ipynb', backend.type)
    const originalAppend = session.append.bind(session)
    Object.defineProperty(session, 'append', {
      configurable: true,
      value: (type: string, data: unknown) => {
        if (type === 'notebook/kernel') throw new Error('restart append failed')
        const result: unknown = Reflect.apply(originalAppend, session, [type, data])
        return result
      },
    })

    await expect(ctx.notebooks.restart(session, opened.id, { initiator: 'user' }))
      .rejects.toThrow('restart append failed')
    Object.defineProperty(session, 'append', { configurable: true, value: originalAppend })
    expect(ctx.notebooks.get(session, opened.id).kernel?.generation).toBe(1)
    expect(await ctx.notebooks.inspect(session, opened.id, 'still-live', { initiator: 'agent' })).toBe('still-live')
    expect(backend.shutdowns).toHaveLength(1)
    const recovered = await ctx.notebooks.restart(session, opened.id, { initiator: 'user' })
    expect(recovered.kernel?.generation).toBe(2)
    await ctx.fiber.dispose()
  })

  it('logs a new kernel generation when inspect resumes a selected environment', async () => {
    const state = createTestFileState()
    const session = Session.create(SessionId('notebook-resume-kernel'))
    const firstCtx = await boot({}, state)
    firstCtx.notebooks.registerBackend(new MemoryKernelBackend())
    const opened = await openAttached(firstCtx, session, 'resume.ipynb', 'memory')
    await firstCtx.fiber.dispose()

    const secondCtx = await boot({}, state)
    secondCtx.notebooks.registerBackend(new MemoryKernelBackend())
    expect(secondCtx.notebooks.runtimeStatus(session, opened.id)).toMatchObject({ status: 'stopped' })
    expect(await secondCtx.notebooks.inspect(session, opened.id, 'x', { initiator: 'user' }))
      .toBe('x is not defined')
    expect(secondCtx.notebooks.get(session, opened.id).kernel?.generation).toBe(2)
    expect(session.events).toEqual([])
    await secondCtx.fiber.dispose()
  })

  it('keeps the selected environment and reports failed runtime state when resume fails', async () => {
    const state = createTestFileState()
    const session = Session.create(SessionId('notebook-resume-failure'))
    const firstCtx = await boot({}, state)
    const firstBackend = new ControlledBackend()
    firstCtx.notebooks.registerBackend(firstBackend)
    const opened = await openAttached(firstCtx, session, 'resume-failure.ipynb', firstBackend.type)
    await firstCtx.fiber.dispose()

    const secondCtx = await boot({}, state)
    const failedBackend = new ControlledBackend()
    failedBackend.start = () => Promise.reject(new Error('resume failed'))
    secondCtx.notebooks.registerBackend(failedBackend)
    await expect(secondCtx.notebooks.inspect(session, opened.id, 'x', { initiator: 'agent' }))
      .rejects.toThrow('resume failed')

    expect(session.events).toEqual([])
    expect(secondCtx.notebooks.get(session, opened.id).kernel).toEqual(opened.kernel)
    expect(secondCtx.notebooks.runtimeStatus(session, opened.id)).toMatchObject({
      status: 'failed',
      message: 'kernel failed to start',
    })
    await secondCtx.fiber.dispose()
  })

  it('reloads an externally changed document and resumes its selected environment on demand', async () => {
    const ctx = await boot()
    const fs = ctx.fs as TestFileSystem
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-reload'))
    const opened = await openAttached(ctx, session, 'reload.ipynb', backend.type)
    fs.putText('reload.ipynb', notebookText('print("external")', 'external-cell', 'python-alt'))

    await expect(ctx.notebooks.editCell(session, opened.id, opened.cells[0]!.id, 'local'))
      .rejects.toMatchObject({ code: 'WRITE_CONFLICT' })
    const reloaded = await ctx.notebooks.reload(session, opened.id, { initiator: 'user' })
    expect(reloaded.kernel).toEqual(opened.kernel)
    expect(reloaded.cells.map(cell => [cell.id, cell.source])).toEqual([
      ['external-cell', 'print("external")'],
    ])
    expect(backend.starts).toHaveLength(1)
    expect(session.events).toEqual([])
    expect(ctx.notebooks.runtimeStatus(session, opened.id)).toMatchObject({ status: 'stopped' })
    await waitUntil(() => backend.shutdowns.length === 1)
    await expect(ctx.notebooks.inspect(session, opened.id, 'resumed', { initiator: 'agent' }))
      .resolves.toBe('resumed')
    expect(backend.starts).toHaveLength(2)
    expect(ctx.notebooks.get(session, opened.id).kernel?.generation).toBe(2)
    expect(session.events).toEqual([])
    await ctx.fiber.dispose()
  })

  it.skip('restores runtime ownership when reload publication fails', async () => {
    const ctx = await boot()
    const fs = ctx.fs as TestFileSystem
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-reload-append-failure'))
    const opened = await openAttached(ctx, session, 'reload-failure.ipynb', backend.type)
    fs.putText('reload-failure.ipynb', notebookText('external', 'changed-cell'))
    const originalAppend = session.append.bind(session)
    Object.defineProperty(session, 'append', {
      configurable: true,
      value: (type: string, data: unknown) => {
        if (type === 'notebook/reload') throw new Error('reload append failed')
        const result: unknown = Reflect.apply(originalAppend, session, [type, data])
        return result
      },
    })

    await expect(ctx.notebooks.reload(session, opened.id, { initiator: 'user' }))
      .rejects.toThrow('reload append failed')
    Object.defineProperty(session, 'append', { configurable: true, value: originalAppend })
    expect(ctx.notebooks.get(session, opened.id).cells[0]!.id).toBe(opened.cells[0]!.id)
    expect(await ctx.notebooks.inspect(session, opened.id, 'still-live', { initiator: 'agent' })).toBe('still-live')
    expect(backend.shutdowns).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('retires live kernels when their backend registration is disposed', async () => {
    const ctx = await boot()
    const backend = new ControlledBackend()
    const dispose = ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-backend-dispose'))
    const opened = await openAttached(ctx, session, 'backend.ipynb', backend.type)

    dispose()
    await waitUntil(() => backend.shutdowns.length === 1)
    await expect(ctx.notebooks.inspect(session, opened.id, 'x', { initiator: 'agent' })).rejects.toMatchObject({
      code: 'NO_BACKEND',
    })
    await ctx.fiber.dispose()
  })

  it('bounds owner teardown while retaining ownership until backend shutdown joins', async () => {
    const ctx = await boot({ shutdownTimeoutMs: 10 })
    const disposalErrors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
    const backend = new ControlledBackend()
    const shutdownStarted = deferred()
    const shutdownGate = deferred()
    backend.shutdown = (handle) => {
      backend.shutdowns.push(handle as ControlledHandle)
      shutdownStarted.resolve()
      return shutdownGate.promise
    }
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-shutdown-timeout'))
    await openAttached(ctx, session, 'shutdown.ipynb', backend.type)

    const service = ctx.notebooks as unknown as { readonly shutdownJoins: ReadonlySet<Promise<void>> }
    const disposal = ctx.fiber.dispose()
    await shutdownStarted.promise
    const outcome = await Promise.race([
      disposal.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ readonly status: 'late' }>((resolve) => {
        setTimeout(() => { resolve({ status: 'late' }) }, 500)
      }),
    ])
    try {
      expect(outcome.status).toBe('fulfilled')
      expect(disposalErrors.some(error => (
        String(error).includes('failed to shut down notebook kernels')
      ))).toBe(true)
      expect(backend.shutdowns).toHaveLength(1)
      expect(service.shutdownJoins.size).toBe(1)
    } finally {
      shutdownGate.resolve()
    }
    await waitUntil(() => service.shutdownJoins.size === 0)
  })

  it('retains a shutdown-failed record when the provider cannot prove quiescence', async () => {
    const ctx = await boot()
    const disposalErrors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { disposalErrors.push(error) }) as typeof ctx.logger.error
    const backend = new ControlledBackend()
    backend.shutdown = () => Promise.reject(new Error('provider shutdown failed'))
    ctx.notebooks.registerBackend(backend)
    const session = Session.create(SessionId('notebook-shutdown-failure'))
    await openAttached(ctx, session, 'shutdown-failure.ipynb', backend.type)
    const service = ctx.notebooks as unknown as {
      readonly backends: ReadonlyMap<string, {
        readonly records: ReadonlySet<{ readonly state: string }>
      }>
    }
    const registration = service.backends.get(backend.type)
    if (registration === undefined) throw new Error('controlled backend registration was not retained')

    await ctx.fiber.dispose()

    expect([...registration.records].map(record => record.state)).toEqual(['shutdown-failed'])
    expect(disposalErrors.some(error => String(error).includes('failed to shut down notebook kernels')))
      .toBe(true)
  })

  it('shuts down kernels when their live session is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
    await ctx.plugin(TestAttachmentStore)
    await ctx.plugin(TestFileSystem)
    await ctx.plugin(NotebookService)
    const backend = new ControlledBackend()
    ctx.notebooks.registerBackend(backend)
    let session!: Session
    const owner = await ctx.plugin(Object.assign((scope: Context) => {
      session = scope.sessions.create(SessionId('notebook-session-dispose'))
    }, { inject: ['sessions'] }))
    await openAttached(ctx, session, 'dispose.ipynb', backend.type)

    await owner.dispose()
    await waitUntil(() => backend.shutdowns.length === 1)
    expect(backend.shutdowns).toHaveLength(1)

    const resumed = Session.create(SessionId('notebook-session-dispose'))
    const reopened = await openAttached(ctx, resumed, 'resumed.ipynb', backend.type)
    expect(reopened.path).toBe('resumed.ipynb')
    await ctx.fiber.dispose()
  })
})
