import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {
  NotebookKernelExecutionEvent,
  NotebookKernelStartSpec,
} from '@deepseek-ai/dsh-notebook-core'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { NotebookEnvironmentError } from '@deepseek-ai/dsh-notebook-environment'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  Config as JupyterConfig,
  JupyterKernelBackend,
  SupervisorRpcError,
  apply,
} from '@deepseek-ai/dsh-notebook-kernel-jupyter'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

type RpcResponder = (method: string, params: Record<string, unknown>) => unknown

function fakeProcess(respond: RpcResponder): {
  readonly handle: SubprocessHandle
  readonly terminate: ReturnType<typeof vi.fn>
  readonly waitForExit: ReturnType<typeof vi.fn>
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const done = deferred<SubprocessOutcome>()
  let input = ''
  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    while (input.includes('\n')) {
      const newline = input.indexOf('\n')
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (line === '') continue
      const request = JSON.parse(line) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      try {
        const result = respond(request.method, request.params)
        stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        stdout.write(`${JSON.stringify({
          id: request.id,
          error: { code: failure.code ?? 'TEST_ERROR', message: failure.message ?? String(error) },
        })}\n`)
      }
    }
  })
  const terminate = vi.fn(() => {
    done.resolve({ exitCode: null, signal: 'SIGTERM' })
    stdout.end()
  })
  const waitForExit = vi.fn(async () => {
    await done.promise
    return true
  })
  return {
    handle: {
      pid: 123,
      stdin,
      stdout,
      stderr: undefined,
      collected: {
        stderr: {
          readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
        },
      },
      done: done.promise,
      terminate,
      waitForExit,
    },
    terminate,
    waitForExit,
  }
}

function startSpec(
  mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  kernelName?: string,
): NotebookKernelStartSpec {
  return {
    sessionId: 'session-test',
    notebookId: 'notebook-test',
    environmentId: 'environment-test',
    backend: 'jupyter',
    ...kernelName === undefined ? {} : { kernelName },
    sandboxPolicy: { mode, workspaceRoot: 'C:/workspace' },
    signal: new AbortController().signal,
  } as unknown as NotebookKernelStartSpec
}

function config() {
  return {
    startupTimeoutMs: 1_000,
    executionTimeoutMs: 1_000,
    interruptTimeoutMs: 1_000,
    responseGraceMs: 100,
    inspectTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    graceMs: 100,
    maxStderrBytes: 4_096,
    maxCellOutputBytes: 8_192,
    maxInspectBytes: 4_096,
    maxResponseBytes: 65_536,
  }
}

function environmentManager(pythonExecutable = 'python-safe') {
  return {
    resolveLaunch: vi.fn(async (request: { environmentId: string }) => ({
      environmentId: request.environmentId,
      pythonExecutable,
      kernelName: 'python3',
    })),
  }
}

describe('Config', () => {
  it('rejects an empty working directory', () => {
    expect(() => JupyterConfig({ cwd: '' })).toThrow()
  })

  it.each([
    'startupTimeoutMs',
    'executionTimeoutMs',
    'interruptTimeoutMs',
    'responseGraceMs',
    'inspectTimeoutMs',
    'shutdownTimeoutMs',
    'graceMs',
    'maxStderrBytes',
    'maxCellOutputBytes',
    'maxInspectBytes',
    'maxResponseBytes',
  ] as const)('rejects a fractional %s', (key) => {
    expect(() => JupyterConfig({ [key]: key === 'maxResponseBytes' ? 256.5 : 1.5 })).toThrow()
  })

  it('applies the default provider configuration', () => {
    let backend: JupyterKernelBackend | undefined
    apply({
      notebooks: { registerBackend: (value: JupyterKernelBackend) => { backend = value; return () => {} } },
    } as unknown as Context)
    expect(backend).toBeInstanceOf(JupyterKernelBackend)
  })
})

describe('JupyterKernelBackend', () => {
  it('spawns the interpreter resolved from the opaque environment id', async () => {
    const processHandle = fakeProcess(method => method === 'start_kernel'
      ? { status: 'ok', backend: 'jupyter_client' }
      : { status: 'ok' })
    let backend: JupyterKernelBackend | undefined
    let spawned: SubprocessSpawnSpec | undefined
    const environments = environmentManager('python-environment')
    const ctx = {
      notebooks: { registerBackend: (value: JupyterKernelBackend) => { backend = value; return () => {} } },
      notebookEnvironments: environments,
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: (spec: SubprocessSpawnSpec) => { spawned = spec; return processHandle.handle } },
    } as unknown as Context
    apply(ctx, { cwd: 'C:/provider-cwd' })

    const handle = await backend!.start(startSpec('danger-full-access'))
    expect(spawned?.argv[0]).toBe('python-environment')
    expect(spawned?.cwd).toBe('C:/provider-cwd')
    expect(environments.resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: 'environment-test',
      workspaceRoot: 'C:/workspace',
    }))
    await backend!.shutdown(handle, new AbortController().signal)
  })

  it('confines restricted startup and emits outputs followed by one typed terminal event', async () => {
    let spawned: SubprocessSpawnSpec | undefined
    let startedWith: Record<string, unknown> | undefined
    const process = fakeProcess((method, params) => {
      if (method === 'start_kernel') {
        startedWith = params
        return { status: 'ok', backend: 'jupyter_client' }
      }
      if (method === 'execute') {
        return {
          status: 'error',
          mutations: [{
            operation: 'append',
            output: {
              type: 'error',
              name: 'ValueError',
              value: 'boom',
              traceback: ['ValueError: boom'],
            },
          }],
          executionCount: 7,
          error: { code: 'EXECUTION_ERROR', message: 'ValueError: boom' },
        }
      }
      if (method === 'inspect') return { status: 'ok', found: true, text: 'answer = 42' }
      if (method === 'shutdown') return { status: 'ok' }
      throw new Error(`unexpected ${method}`)
    })
    const confined: ConfinedArgv = {
      argv: ['sandbox-runner', '--', 'python-safe', 'supervisor.py'],
      enforcement: 'full',
      denialSignatures: [],
      runnerFailureRules: [],
    }
    const confine = vi.fn((_argv: readonly string[], _policy: SandboxPolicy) => confined)
    const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
      spawned = spec
      return process.handle
    })
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: { confine },
      subprocess: { spawn },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())

    const handle = await backend.start(startSpec('read-only', 'python-special'))
    expect(confine).toHaveBeenCalledWith(
      expect.arrayContaining(['python-safe']),
      { mode: 'read-only', workspaceRoot: 'C:/workspace' },
    )
    expect(spawned?.argv).toEqual(confined.argv)
    expect(spawned?.cwd).toBe('C:/workspace')
    expect(spawned?.env).toEqual(expect.objectContaining({
      NO_COLOR: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    }))
    expect(spawned?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(startedWith).toEqual(expect.objectContaining({
      kernelspec: 'python-special',
      max_response_bytes: 65_536,
    }))

    const events: NotebookKernelExecutionEvent[] = []
    for await (const event of backend.execute(handle, 'raise ValueError("boom")', new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toEqual([
      {
        type: 'output',
        mutation: {
          operation: 'append',
          output: {
            type: 'error',
            name: 'ValueError',
            value: 'boom',
            traceback: ['ValueError: boom'],
          },
        },
      },
      { type: 'complete', status: 'error', error: 'ValueError: boom', executionCount: 7 },
    ])
    await expect(backend.inspect(handle, 'answer', new AbortController().signal)).resolves.toBe('answer = 42')
    await backend.shutdown(handle, new AbortController().signal)
    expect(process.terminate).toHaveBeenCalledOnce()
    expect(process.waitForExit).toHaveBeenCalledOnce()
  })

  it.each([
    ['win32', 'workspace-write', true],
    ['win32', 'read-only', false],
    ['win32', 'danger-full-access', false],
    ['linux', 'workspace-write', false],
  ] as const)('scopes the Jupyter connection-file DACL bypass on %s %s', async (platform, mode, expected) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    if (descriptor === undefined) throw new Error('process.platform descriptor is unavailable')
    const child = fakeProcess(method => method === 'start_kernel'
      ? { status: 'ok', backend: 'jupyter_client' }
      : { status: 'ok' })
    let spawned: SubprocessSpawnSpec | undefined
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: {
        confine: (argv: readonly string[]) => ({
          argv: ['sandbox-runner', '--', ...argv],
          enforcement: 'partial',
          denialSignatures: [],
          runnerFailureRules: [],
        }),
      },
      subprocess: { spawn: (spec: SubprocessSpawnSpec) => { spawned = spec; return child.handle } },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())
    try {
      vi.stubEnv('JUPYTER_RUNTIME_DIR', 'hostile-ambient-runtime')
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
      const handle = await backend.start(startSpec(mode))
      if (expected) {
        expect(spawned?.env).toEqual(expect.objectContaining({ JUPYTER_ALLOW_INSECURE_WRITES: 'true' }))
      } else {
        expect(spawned?.env?.JUPYTER_ALLOW_INSECURE_WRITES).toBeUndefined()
      }
      expect(spawned?.env).toEqual(expect.objectContaining({
        JUPYTER_PATH: undefined,
        JUPYTER_CONFIG_DIR: undefined,
        JUPYTER_DATA_DIR: undefined,
        JUPYTER_RUNTIME_DIR: undefined,
        IPYTHONDIR: undefined,
      }))
      await backend.shutdown(handle, new AbortController().signal)
    } finally {
      vi.unstubAllEnvs()
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it('validates and forwards complete rich-output mutations', async () => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') return { status: 'ok', backend: 'jupyter_client' }
      if (method === 'execute') {
        return {
          status: 'ok',
          mutations: [
            {
              operation: 'append',
              output: {
                type: 'execute-result',
                data: {
                  'application/json': { type: 'json', value: { answer: 42 } },
                  'image/png': { type: 'base64', data: 'aGk=' },
                  'text/plain': { type: 'text', text: '42' },
                },
                metadata: { expanded: true },
                executionCount: 9,
                displayId: 'result-1',
              },
            },
            { operation: 'clear', wait: true },
            {
              operation: 'update-display',
              displayId: 'result-1',
              data: { 'text/plain': { type: 'text', text: 'updated' } },
              metadata: {},
            },
          ],
          executionCount: 9,
        }
      }
      return { status: 'ok' }
    })
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    const events: NotebookKernelExecutionEvent[] = []
    for await (const event of backend.execute(handle, 'display(42)', new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toEqual([
      {
        type: 'output',
        mutation: {
          operation: 'append',
          output: {
            type: 'execute-result',
            data: {
              'application/json': { type: 'json', value: { answer: 42 } },
              'image/png': { type: 'base64', data: 'aGk=' },
              'text/plain': { type: 'text', text: '42' },
            },
            metadata: { expanded: true },
            executionCount: 9,
            displayId: 'result-1',
          },
        },
      },
      { type: 'output', mutation: { operation: 'clear', wait: true } },
      {
        type: 'output',
        mutation: {
          operation: 'update-display',
          displayId: 'result-1',
          data: { 'text/plain': { type: 'text', text: 'updated' } },
          metadata: {},
        },
      },
      { type: 'complete', status: 'ok', executionCount: 9 },
    ])
    await backend.shutdown(handle, new AbortController().signal)
  })

  it('bypasses ctx.sandbox only for danger-full-access', async () => {
    const process = fakeProcess(method => method === 'start_kernel'
      ? { status: 'ok', backend: 'jupyter_client' }
      : { status: 'ok' })
    const confine = vi.fn()
    let spawned: SubprocessSpawnSpec | undefined
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: { confine },
      subprocess: { spawn: (spec: SubprocessSpawnSpec) => { spawned = spec; return process.handle } },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    expect(confine).not.toHaveBeenCalled()
    expect(spawned?.argv[0]).toBe('python-safe')
    await backend.shutdown(handle, new AbortController().signal)
  })

  it('terminates and joins an unpublished child after startup RPC failure', async () => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') {
        const error = new SupervisorRpcError('kernelspec missing', 'KERNELSPEC_MISSING')
        throw error
      }
      return { status: 'ok' }
    })
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())
    await expect(backend.start(startSpec('danger-full-access', 'python-special'))).rejects.toEqual(expect.objectContaining({
      message: 'The selected environment does not provide the "python-special" kernelspec.',
      code: 'NOTEBOOK_ENVIRONMENT_KERNELSPEC_MISSING',
      category: 'kernelspec',
      retryable: true,
    }))
    expect(process.terminate).toHaveBeenCalledOnce()
    expect(process.waitForExit).toHaveBeenCalledOnce()
  })

  it('terminates and joins a kernel whose execution transport becomes unrecoverable', async () => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') return { status: 'ok', backend: 'jupyter_client' }
      if (method === 'execute') {
        throw new SupervisorRpcError('interrupt did not reach idle', 'KERNEL_UNRESPONSIVE')
      }
      return { status: 'ok' }
    })
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    const consume = async (): Promise<void> => {
      for await (const _event of backend.execute(handle, 'hang()', new AbortController().signal)) {
        // No event is valid after an unrecoverable supervisor RPC failure.
      }
    }
    await expect(consume()).rejects.toEqual(expect.objectContaining({ code: 'KERNEL_UNRESPONSIVE' }))
    expect(process.terminate).toHaveBeenCalledOnce()
    expect(process.waitForExit).toHaveBeenCalledOnce()
  })

  it('fails closed before spawn when confinement is unavailable', async () => {
    const spawn = vi.fn()
    const ctx = {
      notebookEnvironments: environmentManager(),
      sandbox: { confine: () => { throw new Error('sandbox unavailable') } },
      subprocess: { spawn },
    } as unknown as Context
    const backend = new JupyterKernelBackend(ctx, config())
    const error = await captureRejection(backend.start(startSpec('workspace-write')))
    expect(error).toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED',
      category: 'kernel-start',
    })
    expect((error as { cause?: unknown }).cause).toMatchObject({ message: 'sandbox unavailable' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['fractional byte limit', { maxStderrBytes: 1.5 }, 'positive safe integer'],
    ['zero byte limit', { maxStderrBytes: 0 }, 'positive safe integer'],
    ['excessive byte limit', { maxStderrBytes: 4 * 1024 * 1024 + 1 }, 'positive safe integer'],
    ['undersized response limit', { maxResponseBytes: 128 }, 'must be at least 256'],
    [
      'unsafe timeout total',
      { executionTimeoutMs: Number.MAX_SAFE_INTEGER, interruptTimeoutMs: 1, responseGraceMs: 1 },
      'RPC timeout components',
    ],
    [
      'excessive timeout total',
      { executionTimeoutMs: 2_147_483_647, interruptTimeoutMs: 1, responseGraceMs: 1 },
      'RPC timeout components',
    ],
  ])('rejects a resolved config with %s', (_label, override, expected) => {
    const ctx = {} as Context
    expect(() => new JupyterKernelBackend(ctx, { ...config(), ...override })).toThrow(expected)
  })

  it('maps spawn and supervisor-pipe failures to stable startup errors', async () => {
    const spawnFailure = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => { throw new Error('spawn unavailable') } },
    } as unknown as Context, config())
    const spawnError = await captureRejection(spawnFailure.start(startSpec('danger-full-access')))
    expect(spawnError).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED' })
    expect((spawnError as { cause?: unknown }).cause).toMatchObject({ message: 'spawn unavailable' })

    const process = fakeProcess(() => ({ status: 'ok', backend: 'jupyter_client' }))
    const missingPipes = { ...process.handle, stdin: undefined, collected: {} }
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => missingPipes },
    } as unknown as Context, config())
    await expect(backend.start(startSpec('danger-full-access'))).rejects.toEqual(expect.objectContaining({
      code: 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED',
    }))
    expect(process.terminate).toHaveBeenCalledOnce()
  })

  it.each(['JUPYTER_DEPENDENCY_UNAVAILABLE', 'JUPYTER_IMPORT_FAILED'])
  ('classifies %s as a dependency failure', async (code) => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') throw new SupervisorRpcError('dependency unavailable', code)
      return { status: 'ok' }
    })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    await expect(backend.start(startSpec('danger-full-access'))).rejects.toEqual(expect.objectContaining({
      code: 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
      category: 'dependency',
    }))
  })

  it.each([
    ['invalid status', { status: 'bad', backend: 'jupyter_client' }],
    ['invalid backend', { status: 'ok', backend: 'other' }],
  ])('rejects an %s startup result and logs bounded stderr', async (_label, startResult) => {
    const process = fakeProcess(() => startResult)
    const warn = vi.fn()
    const handle = {
      ...process.handle,
      collected: {
        ...process.handle.collected,
        stderr: { readFrom: () => ({ text: 'bounded supervisor detail\n', nextOffset: 27, lossy: false }) },
      },
    }
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => handle },
      logger: { warn },
    } as unknown as Context, config())
    await expect(backend.start(startSpec('danger-full-access'))).rejects.toEqual(expect.objectContaining({
      code: 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED',
    }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bounded supervisor detail'))
  })

  it('preserves a typed startup failure and normalizes a non-Error transport throw', async () => {
    for (const failure of [
      new NotebookEnvironmentError(
        'environment changed',
        'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
        'dependency',
        true,
      ),
      'string transport failure',
    ]) {
      const process = fakeProcess(() => ({ status: 'ok', backend: 'jupyter_client' }))
      const stdin = process.handle.stdin!
      stdin.write = (() => { throw failure }) as typeof stdin.write
      const backend = new JupyterKernelBackend({
        notebookEnvironments: environmentManager(),
        sandbox: { confine: vi.fn() },
        subprocess: { spawn: () => process.handle },
      } as unknown as Context, config())
      if (failure instanceof NotebookEnvironmentError) {
        await expect(backend.start(startSpec('danger-full-access'))).rejects.toBe(failure)
      } else {
        const error = await captureRejection(backend.start(startSpec('danger-full-access')))
        expect(error).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED' })
        expect((error as { cause?: unknown }).cause).toMatchObject({ message: failure })
      }
    }
  })

  it('preserves caller cancellation after the startup supervisor is joined', async () => {
    const controller = new AbortController()
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') controller.abort(new Error('startup cancelled'))
      return { status: 'ok', backend: 'jupyter_client' }
    })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    await expect(backend.start({
      ...startSpec('danger-full-access'),
      signal: controller.signal,
    })).rejects.toThrow('startup cancelled')
    expect(process.waitForExit).toHaveBeenCalledOnce()
  })

  it('reports both startup and process-tree cleanup failures', async () => {
    const process = fakeProcess(() => ({ status: 'bad' }))
    const handle = { ...process.handle, waitForExit: vi.fn(async () => false) }
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => handle },
    } as unknown as Context, config())
    const error = await captureRejection(backend.start(startSpec('danger-full-access')))
    expect(error).toMatchObject({ code: 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED' })
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
  })

  it('forwards stream, display, null-count, and complete JSON MIME values', async () => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') return { status: 'ok', backend: 'jupyter_client' }
      if (method === 'execute') {
        return {
          status: 'ok',
          mutations: [
            { operation: 'append', output: { type: 'stream', name: 'stdout', text: 'hello\n' } },
            {
              operation: 'append',
              output: {
                type: 'display',
                data: { 'application/json': { type: 'json', value: [null, 'text', true, 4] } },
                metadata: {},
              },
            },
            {
              operation: 'append',
              output: {
                type: 'execute-result',
                data: { 'text/plain': { type: 'text', text: 'none' } },
                metadata: {},
                executionCount: null,
              },
            },
          ],
          executionCount: 1,
        }
      }
      return { status: 'ok' }
    })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    const events: NotebookKernelExecutionEvent[] = []
    for await (const event of backend.execute(handle, 'display()', new AbortController().signal)) events.push(event)
    expect(events).toHaveLength(4)
    await backend.shutdown(handle, new AbortController().signal)
  })

  it.each([
    ['non-object result', null, 'invalid execute result'],
    ['invalid status', { status: 'bad', mutations: [], executionCount: 0 }, 'invalid execute status'],
    ['invalid mutations', { status: 'ok', mutations: {}, executionCount: 0 }, 'invalid execute mutations'],
    ['invalid error fields', { status: 'error', mutations: [], executionCount: 0, error: { code: 1, message: 'x' } }, 'invalid execute error fields'],
    ['invalid clear', { status: 'ok', mutations: [{ operation: 'clear', wait: 'yes' }], executionCount: 0 }, 'invalid clear output wait flag'],
    ['invalid update id', { status: 'ok', mutations: [{ operation: 'update-display', displayId: '', data: {}, metadata: {} }], executionCount: 0 }, 'invalid update display id'],
    ['invalid mutation', { status: 'ok', mutations: [{ operation: 'replace' }], executionCount: 0 }, 'invalid notebook output mutation operation'],
    ['invalid stream name', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'stream', name: 'log', text: '' } }], executionCount: 0 }, 'invalid notebook stream output'],
    ['invalid stream text', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'stream', name: 'stdout', text: 1 } }], executionCount: 0 }, 'invalid notebook stream output'],
    ['invalid error fields', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'error', name: 1, value: '', traceback: [] } }], executionCount: 0 }, 'invalid notebook error output fields'],
    ['invalid error value', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'error', name: 'E', value: 1, traceback: [] } }], executionCount: 0 }, 'invalid notebook error output fields'],
    ['invalid traceback record', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'error', name: 'E', value: '', traceback: 'bad' } }], executionCount: 0 }, 'invalid notebook error traceback'],
    ['invalid traceback line', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'error', name: 'E', value: '', traceback: [1] } }], executionCount: 0 }, 'invalid notebook error traceback'],
    ['invalid output type', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'audio' } }], executionCount: 0 }, 'invalid notebook kernel output type'],
    ['invalid display id', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: {}, metadata: {}, displayId: 1 } }], executionCount: 0 }, 'invalid notebook display id'],
    ['empty MIME type', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: { '': { type: 'text', text: '' } }, metadata: {} } }], executionCount: 0 }, 'invalid empty notebook MIME type'],
    ['invalid text MIME', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: { text: { type: 'text', text: 1 } }, metadata: {} } }], executionCount: 0 }, 'invalid notebook text MIME value'],
    ['non-string base64', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: { image: { type: 'base64', data: 1 } }, metadata: {} } }], executionCount: 0 }, 'invalid notebook base64 MIME value'],
    ['invalid base64 alphabet', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: { image: { type: 'base64', data: '!' } }, metadata: {} } }], executionCount: 0 }, 'invalid notebook base64 MIME value'],
    ['non-canonical base64', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: { image: { type: 'base64', data: 'ZE==' } }, metadata: {} } }], executionCount: 0 }, 'invalid notebook base64 MIME value'],
    ['invalid MIME variant', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: { text: { type: 'bytes' } }, metadata: {} } }], executionCount: 0 }, 'invalid notebook MIME value type'],
    ['invalid metadata', { status: 'ok', mutations: [{ operation: 'append', output: { type: 'display', data: {}, metadata: [] } }], executionCount: 0 }, 'invalid display metadata'],
    ['string execution count', { status: 'ok', mutations: [], executionCount: '1' }, 'invalid execute result executionCount'],
    ['fractional execution count', { status: 'ok', mutations: [], executionCount: 1.5 }, 'invalid execute result executionCount'],
    ['negative execution count', { status: 'ok', mutations: [], executionCount: -1 }, 'invalid execute result executionCount'],
  ])('rejects %s from execute', async (_label, response, expected) => {
    const process = fakeProcess(method => method === 'start_kernel'
      ? { status: 'ok', backend: 'jupyter_client' }
      : method === 'execute' ? response : { status: 'ok' })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    const consume = async (): Promise<void> => {
      for await (const _event of backend.execute(handle, 'invalid()', new AbortController().signal)) {
        // Invalid protocol data must not publish partial events.
      }
    }
    await expect(consume()).rejects.toThrow(expected)
  })

  it.each([
    ['non-object result', null, 'invalid inspect result'],
    ['invalid status', { status: 'bad', found: true, text: '' }, 'invalid inspect result fields'],
    ['invalid found', { status: 'ok', found: 'yes', text: '' }, 'invalid inspect result fields'],
    ['invalid text', { status: 'ok', found: true, text: 1 }, 'invalid inspect result fields'],
  ])('rejects %s from inspect', async (_label, response, expected) => {
    const process = fakeProcess(method => method === 'start_kernel'
      ? { status: 'ok', backend: 'jupyter_client' }
      : method === 'inspect' ? response : { status: 'ok' })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    await expect(backend.inspect(handle, 'value', new AbortController().signal)).rejects.toThrow(expected)
  })

  it.each(['execute', 'inspect'] as const)('preserves caller cancellation during %s cleanup', async (operation) => {
    const controller = new AbortController()
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') return { status: 'ok', backend: 'jupyter_client' }
      if (method === operation) controller.abort(new Error(`${operation} cancelled`))
      return operation === 'execute'
        ? { status: 'ok', mutations: [], executionCount: 1 }
        : { status: 'ok', found: true, text: '' }
    })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    if (operation === 'execute') {
      const consume = async (): Promise<void> => {
        for await (const _event of backend.execute(handle, '', controller.signal)) {
          // Cancellation publishes no execution event.
        }
      }
      await expect(consume()).rejects.toThrow('execute cancelled')
    } else {
      await expect(backend.inspect(handle, 'value', controller.signal)).rejects.toThrow('inspect cancelled')
    }
  })

  it.each(['execute', 'inspect'] as const)('reports both %s and process-tree cleanup failures', async (operation) => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') return { status: 'ok', backend: 'jupyter_client' }
      if (method === operation) return null
      return { status: 'ok' }
    })
    const handle = { ...process.handle, waitForExit: vi.fn(async () => false) }
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => handle },
    } as unknown as Context, config())
    const live = await backend.start(startSpec('danger-full-access'))
    if (operation === 'execute') {
      const consume = async (): Promise<void> => {
        for await (const _event of backend.execute(live, '', new AbortController().signal)) {
          // Invalid protocol data publishes no execution event.
        }
      }
      await expect(consume()).rejects.toBeInstanceOf(AggregateError)
    } else {
      await expect(backend.inspect(live, 'value', new AbortController().signal))
        .rejects.toBeInstanceOf(AggregateError)
    }
  })

  it.each([
    ['rpc only', true, true, SupervisorRpcError],
    ['cleanup only', false, false, Error],
    ['rpc and cleanup', true, false, AggregateError],
  ] as const)('reports %s during shutdown', async (_label, failRpc, cleanStop, expected) => {
    const process = fakeProcess((method) => {
      if (method === 'start_kernel') return { status: 'ok', backend: 'jupyter_client' }
      if (method === 'shutdown' && failRpc) throw new SupervisorRpcError('shutdown failed', 'SHUTDOWN_FAILED')
      return { status: 'ok' }
    })
    const handle = { ...process.handle, waitForExit: vi.fn(async () => cleanStop) }
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => handle },
    } as unknown as Context, config())
    const live = await backend.start(startSpec('danger-full-access'))
    await expect(backend.shutdown(live, new AbortController().signal)).rejects.toBeInstanceOf(expected)
  })

  it('skips shutdown RPC after transport failure and reuses completed teardown', async () => {
    const methods: string[] = []
    const process = fakeProcess((method) => {
      methods.push(method)
      return method === 'start_kernel'
        ? { status: 'ok', backend: 'jupyter_client' }
        : { status: 'ok' }
    })
    const backend = new JupyterKernelBackend({
      notebookEnvironments: environmentManager(),
      sandbox: { confine: vi.fn() },
      subprocess: { spawn: () => process.handle },
    } as unknown as Context, config())
    const handle = await backend.start(startSpec('danger-full-access'))
    ;(handle as unknown as { rpc: { close(reason: Error): void } }).rpc.close(new Error('transport failed'))
    await backend.shutdown(handle, new AbortController().signal)
    await backend.shutdown(handle, new AbortController().signal)
    expect(methods).toEqual(['start_kernel'])
    expect(process.terminate).toHaveBeenCalledOnce()
  })
})
