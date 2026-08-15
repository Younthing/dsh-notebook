import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Writable } from 'node:stream'
import {
  JsonLineRpcConnection,
  SupervisorRpcError,
  SupervisorRpcTimeoutError,
} from '@younthing/dsh-notebook-kernel-jupyter'

const SUPERVISOR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../supervisor/dsh_notebook_supervisor.py',
)

const EXECUTE_LIMITS = {
  timeout_ms: 5_000,
  interrupt_timeout_ms: 2_000,
  max_output_bytes: 65_536,
} as const
const INSPECT_LIMITS = { timeout_ms: 5_000, max_output_bytes: 65_536 } as const

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function resolvePython(): string | undefined {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  for (const command of candidates) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return command
  }
  return undefined
}

function processDone(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => { resolve() })
  })
}

function connection(
  stdin: Writable,
  stdout: PassThrough,
  done: Promise<unknown>,
  timeoutMs = 1_000,
  maxResponseBytes = 65_536,
): JsonLineRpcConnection {
  return new JsonLineRpcConnection(stdin, stdout, {
    processDone: done,
    requestTimeoutMs: timeoutMs,
    maxResponseBytes,
  })
}

describe('JsonLineRpcConnection', () => {
  it('round-trips one JSON-RPC request and rejects a structured RPC error', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const done = deferred<undefined>()
    const rpc = connection(output, input, done.promise)
    const first = rpc.request('ping', { value: 1 })
    input.write(`${JSON.stringify({ id: 1, result: { ok: true } })}\n`)
    await expect(first).resolves.toEqual({ ok: true })

    const second = rpc.request('ping')
    input.write(`${JSON.stringify({ id: 2, error: { code: 'NO_PING', message: 'no ping' } })}\n`)
    await expect(second).rejects.toEqual(expect.objectContaining({
      name: 'SupervisorRpcError',
      code: 'NO_PING',
      message: 'no ping',
    }))
    rpc.close()
    done.resolve(undefined)
  })

  it.each([
    ['stdout close', (input: PassThrough, _output: PassThrough, _done: Deferred<undefined>) => { input.end() }, 'stdout closed'],
    ['stdout error', (input: PassThrough, _output: PassThrough, _done: Deferred<undefined>) => { input.destroy(new Error('read failed')) }, 'read failed'],
    ['stdin error', (_input: PassThrough, output: PassThrough, _done: Deferred<undefined>) => { output.destroy(new Error('write stream failed')) }, 'write stream failed'],
    ['child exit', (_input: PassThrough, _output: PassThrough, done: Deferred<undefined>) => { done.resolve(undefined) }, 'supervisor exited'],
  ])('settles every pending request once on %s', async (_label, breakTransport, expected) => {
    const input = new PassThrough()
    const output = new PassThrough()
    const done = deferred<undefined>()
    const rpc = connection(output, input, done.promise)
    const pending = rpc.request('wait')
    breakTransport(input, output, done)
    await expect(pending).rejects.toThrow(expected)
    await expect(rpc.request('later')).rejects.toThrow(expected)
  })

  it('settles a request on callback-delivered and synchronous write failures', async () => {
    const input = new PassThrough()
    const done = deferred<undefined>()
    const callbackFailure = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('callback write failed'))
      },
    })
    const first = connection(callbackFailure, input, done.promise)
    await expect(first.request('write')).rejects.toThrow('callback write failed')

    const throwing = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    throwing.write = (() => { throw new Error('synchronous write failed') }) as typeof throwing.write
    const second = connection(throwing, new PassThrough(), done.promise)
    await expect(second.request('write')).rejects.toThrow('synchronous write failed')
    done.resolve(undefined)
  })

  it('settles on timeout and AbortSignal without a later response changing the outcome', async () => {
    const done = deferred<undefined>()
    const timedInput = new PassThrough()
    const timed = connection(new PassThrough(), timedInput, done.promise, 10)
    const timeout = timed.request('slow')
    await expect(timeout).rejects.toBeInstanceOf(SupervisorRpcTimeoutError)
    timedInput.write(`${JSON.stringify({ id: 1, result: 'late' })}\n`)

    const aborted = connection(new PassThrough(), new PassThrough(), done.promise)
    const controller = new AbortController()
    const pending = aborted.request('slow', {}, { signal: controller.signal })
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
    aborted.close()
    done.resolve(undefined)
  })

  it('fails closed on malformed response JSON', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const done = deferred<undefined>()
    const rpc = connection(output, input, done.promise)
    const pending = rpc.request('ping')
    input.write('{not-json}\n')
    await expect(pending).rejects.toThrow('invalid JSON from notebook supervisor')
    done.resolve(undefined)
  })

  it('fails before buffering a supervisor response beyond the byte cap', async () => {
    const input = new PassThrough()
    const done = deferred<undefined>()
    const rpc = connection(new PassThrough(), input, done.promise, 1_000, 32)
    const pending = rpc.request('ping')
    input.write(Buffer.alloc(33, 0x78))
    await expect(pending).rejects.toThrow('response exceeded 32 bytes')
    await expect(rpc.request('later')).rejects.toThrow('response exceeded 32 bytes')
    done.resolve(undefined)
  })

  it('validates connection limits and rejects a pre-aborted request without writing', async () => {
    expect(() => connection(new PassThrough(), new PassThrough(), Promise.resolve(), Number.NaN))
      .toThrow('request timeout must be a positive finite number')
    expect(() => connection(new PassThrough(), new PassThrough(), Promise.resolve(), 0))
      .toThrow('request timeout must be a positive finite number')
    expect(() => connection(new PassThrough(), new PassThrough(), Promise.resolve(), 1_000, 1.5))
      .toThrow('response limit must be a positive safe integer')
    expect(() => connection(new PassThrough(), new PassThrough(), Promise.resolve(), 1_000, 0))
      .toThrow('response limit must be a positive safe integer')

    const output = new PassThrough()
    const write = output.write.bind(output)
    let writes = 0
    output.write = ((...args: Parameters<typeof output.write>) => {
      writes += 1
      return write(...args)
    }) as typeof output.write
    const rpc = connection(output, new PassThrough(), new Promise(() => {}))
    const controller = new AbortController()
    controller.abort('cancelled before request')
    await expect(rpc.request('never-written', {}, { signal: controller.signal }))
      .rejects.toThrow('cancelled before request')
    expect(writes).toBe(0)
    rpc.close()
  })

  it('handles cancellation during listener registration and both shutdown request forms', async () => {
    const output = new PassThrough()
    const input = new PassThrough()
    const rpc = connection(output, input, new Promise(() => {}))
    expect(rpc.failed).toBe(false)
    const racedSignal = {
      aborted: true,
      reason: undefined,
      throwIfAborted() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
      onabort: null,
    } as unknown as AbortSignal
    await expect(rpc.request('raced', {}, { signal: racedSignal }))
      .rejects.toThrow('notebook supervisor RPC aborted')

    const first = rpc.shutdown()
    input.write(`${JSON.stringify({ id: 2, result: { status: 'ok' } })}\n`)
    await expect(first).resolves.toBeUndefined()
    const second = rpc.shutdown(new AbortController().signal)
    input.write(`${JSON.stringify({ id: 3, result: { status: 'ok' } })}\n`)
    await expect(second).resolves.toBeUndefined()
    rpc.close()
    expect(rpc.failed).toBe(true)
  })

  it('fails pending work when the supervisor process promise rejects', async () => {
    const done = deferred<undefined>()
    const rpc = connection(new PassThrough(), new PassThrough(), done.promise)
    const pending = rpc.request('wait')
    done.reject('supervisor spawn failed')
    await expect(pending).rejects.toThrow('supervisor spawn failed')
    rpc.close(new Error('later close is idempotent'))
  })

  it.each([
    ['null response', 'null', 'invalid notebook supervisor response object'],
    ['array response', '[]', 'invalid notebook supervisor response object'],
    ['string id', JSON.stringify({ id: '1', result: null }), 'invalid notebook supervisor response id'],
    ['fractional id', JSON.stringify({ id: 1.5, result: null }), 'invalid notebook supervisor response id'],
  ])('fails closed on a %s', async (_label, line, expected) => {
    const input = new PassThrough()
    const rpc = connection(new PassThrough(), input, new Promise(() => {}))
    const pending = rpc.request('ping')
    input.write(`${line}\n`)
    await expect(pending).rejects.toThrow(expected)
  })

  it('ignores unknown response ids and supplies structured-error defaults', async () => {
    const input = new PassThrough()
    const rpc = connection(new PassThrough(), input, new Promise(() => {}))
    const first = rpc.request('ping')
    input.write(`${JSON.stringify({ id: 999, result: 'ignored' })}\n`)
    input.write(`${JSON.stringify({ id: 1, result: 'accepted' })}\n`)
    await expect(first).resolves.toBe('accepted')

    const primitive = rpc.request('ping')
    input.write(`${JSON.stringify({ id: 2, error: 'broken' })}\n`)
    await expect(primitive).rejects.toEqual(expect.objectContaining({
      name: 'SupervisorRpcError',
      code: undefined,
      message: 'notebook supervisor RPC failed',
    }))

    const defaults = rpc.request('ping')
    input.write(`${JSON.stringify({ id: 3, error: { details: { retry: false } } })}\n`)
    await expect(defaults).rejects.toEqual(expect.objectContaining({
      code: undefined,
      message: 'notebook supervisor RPC failed',
      details: { retry: false },
    }))
    rpc.close()
  })
})

describe('notebook supervisor process protocol', () => {
  const python = resolvePython()
  const hasJupyter = python !== undefined
    && spawnSync(python, ['-c', 'import jupyter_client'], { encoding: 'utf8' }).status === 0
  let child: ChildProcessWithoutNullStreams | undefined
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const closed = processDone(child)
      child.kill()
      await closed
    }
    child = undefined
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  function launch(args: readonly string[] = [SUPERVISOR], env?: NodeJS.ProcessEnv): JsonLineRpcConnection {
    child = spawn(python!, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    return new JsonLineRpcConnection(child.stdin, child.stdout, {
      processDone: processDone(child),
      requestTimeoutMs: 20_000,
      maxResponseBytes: 65_536,
    })
  }

  it.skipIf(python === undefined)('returns typed terminal outcomes and survives Python exceptions', async () => {
    const rpc = launch()
    await expect(rpc.request('start_kernel', {
      backend: 'interactive_interpreter',
      timeout_ms: 5_000,
    })).resolves.toEqual({ status: 'ok', backend: 'interactive_interpreter' })

    await expect(rpc.request('execute', {
      source: 'answer = 41 + 1\nprint(answer)',
      ...EXECUTE_LIMITS,
    })).resolves.toEqual({
      status: 'ok',
      mutations: [{
        operation: 'append',
        output: { type: 'stream', name: 'stdout', text: '42\n' },
      }],
      executionCount: 1,
    })
    await expect(rpc.request('inspect', { name: 'answer', ...INSPECT_LIMITS })).resolves.toEqual({
      status: 'ok',
      found: true,
      text: 'answer = 42',
    })

    const failed = await rpc.request<{
      status: string
      error: { code: string; message: string }
      mutations: Array<{ output?: { type?: string; name?: string; value?: string } }>
      executionCount: number
    }>('execute', { source: 'raise ValueError("boom")', ...EXECUTE_LIMITS })
    expect(failed.status).toBe('error')
    expect(failed.error).toEqual(expect.objectContaining({ code: 'EXECUTION_ERROR' }))
    expect(failed.executionCount).toBe(2)
    expect(failed.mutations[0]?.output).toEqual(expect.objectContaining({
      type: 'error',
      name: 'ValueError',
      value: 'boom',
    }))

    const systemExit = await rpc.request<{ status: string; executionCount: number }>('execute', {
      source: 'raise SystemExit(3)',
      ...EXECUTE_LIMITS,
    })
    expect(systemExit.status).toBe('error')
    expect(systemExit.executionCount).toBe(3)
    await expect(rpc.request('execute', { source: 'print("alive")', ...EXECUTE_LIMITS }))
      .resolves.toEqual(expect.objectContaining({ status: 'ok' }))

    const limited = await rpc.request<{
      status: string
      error: { code: string }
      executionCount: number
    }>('execute', {
      source: 'print("é" * 100)',
      ...EXECUTE_LIMITS,
      max_output_bytes: 8,
    })
    expect(limited.status).toBe('error')
    expect(limited.error.code).toBe('OUTPUT_LIMIT')
    expect(limited.executionCount).toBe(5)
    await rpc.request('execute', { source: 'large = "é" * 100', ...EXECUTE_LIMITS })
    await expect(rpc.request('inspect', { name: 'large', ...INSPECT_LIMITS, max_output_bytes: 8 }))
      .rejects.toEqual(expect.objectContaining({ code: 'INSPECT_OUTPUT_LIMIT' }))

    await expect(rpc.request('execute', {
      source: 'print("x" * 1000)',
      ...EXECUTE_LIMITS,
      max_response_bytes: 256,
    })).rejects.toEqual(expect.objectContaining({ code: 'RESPONSE_LIMIT' }))

    await rpc.request('shutdown')
    await expect(processDone(child!)).resolves.toBeUndefined()
  }, 30_000)

  it.skipIf(python === undefined)('falls back only when jupyter_client is unavailable and explicitly allowed', async () => {
    const rpc = launch(['-S', SUPERVISOR])
    await expect(rpc.request('start_kernel', { kernelspec: 'python3', timeout_ms: 5_000 }))
      .rejects.toEqual(expect.objectContaining({ code: 'JUPYTER_DEPENDENCY_UNAVAILABLE' }))
    await expect(rpc.request('start_kernel', {
      kernelspec: 'python3',
      timeout_ms: 5_000,
      allow_interpreter_fallback: true,
    })).resolves.toEqual({
      status: 'ok',
      backend: 'interactive_interpreter',
    })
    await rpc.request('shutdown')
  })

  it.skipIf(python === undefined)('fails loud when jupyter_client itself raises ImportError', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-jupyter-import-'))
    temporaryDirectories.push(directory)
    await writeFile(join(directory, 'jupyter_client.py'), 'raise ImportError("broken internal dependency")\n')
    const rpc = launch(['-S', SUPERVISOR], { ...process.env, PYTHONPATH: directory })
    await expect(rpc.request('start_kernel', { kernelspec: 'python3', timeout_ms: 5_000 }))
      .rejects.toEqual(expect.objectContaining({
        name: 'SupervisorRpcError',
        code: 'JUPYTER_IMPORT_FAILED',
      }))
    await expect(rpc.request('execute', { source: 'print(1)', ...EXECUTE_LIMITS }))
      .rejects.toBeInstanceOf(SupervisorRpcError)
    child!.stdin.end()
  })

  it.skipIf(python === undefined)('handles queue.Empty, interrupt-to-idle, MIME updates, and clear_output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-jupyter-fake-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, 'jupyter_client'))
    await writeFile(join(directory, 'jupyter_client', '__init__.py'), [
      'import queue',
      'import subprocess',
      'import sys',
      '',
      'class Client:',
      '    def __init__(self, manager):',
      '        self.manager = manager',
      '        self.source = ""',
      '        self.phase = 0',
      '        self.mode = "execute"',
      '        self.execution_count = 0',
      '    def start_channels(self): pass',
      '    def stop_channels(self): pass',
      '    def wait_for_ready(self, timeout): pass',
      '    def execute(self, source, stop_on_error=True):',
      '        self.source = source; self.phase = 0; self.mode = "execute"; self.manager.interrupted = False; self.execution_count += 1',
      '        return "exec-id"',
      '    def inspect(self, code, cursor_pos, detail_level=0):',
      '        self.mode = "inspect"; return "inspect-id"',
      '    def get_shell_msg(self, timeout):',
      '        if self.mode == "inspect":',
      '            return {"parent_header":{"msg_id":"inspect-id"},"content":{"status":"ok","found":True,"data":{"text/plain":"answer = 42"}}}',
      '        if self.source == "missing-count":',
      '            return {"parent_header":{"msg_id":"exec-id"},"content":{"status":"ok"}}',
      '        if self.source == "reply-error-large":',
      '            return {"parent_header":{"msg_id":"exec-id"},"content":{"status":"error","execution_count":self.execution_count,"ename":"ValueError","evalue":"x" * 500,"traceback":[]}}',
      '        return {"parent_header":{"msg_id":"exec-id"},"content":{"status":"ok","execution_count":self.execution_count}}',
      '    def get_iopub_msg(self, timeout):',
      '        parent = {"msg_id":"exec-id"}',
      '        if self.source == "unresponsive": raise queue.Empty()',
      '        if self.source == "timeout":',
      '            if not self.manager.interrupted: raise queue.Empty()',
      '            return {"parent_header":parent,"msg_type":"status","content":{"execution_state":"idle"}}',
      '        if self.source == "large":',
      '            if self.phase == 0:',
      '                self.phase += 1; return {"parent_header":parent,"msg_type":"stream","content":{"name":"stdout","text":"x" * 100}}',
      '            return {"parent_header":parent,"msg_type":"status","content":{"execution_state":"idle"}}',
      '        if self.source == "mime":',
      '            messages = [',
      '                {"parent_header":parent,"msg_type":"execute_result","content":{"data":{"application/vnd.plotly.v1+json":{"data":[1]},"image/png":"aGk=","text/plain":"old"},"metadata":{"expanded":True},"execution_count":self.execution_count,"transient":{"display_id":"d"}}},',
      '                {"parent_header":parent,"msg_type":"update_display_data","content":{"data":{"application/vnd.plotly.v1+json":{"data":[2]},"text/plain":"new"},"metadata":{"expanded":False},"transient":{"display_id":"d"}}},',
      '                {"parent_header":parent,"msg_type":"status","content":{"execution_state":"idle"}},',
      '            ]',
      '        elif self.source == "error":',
      '            messages = [',
      '                {"parent_header":parent,"msg_type":"error","content":{"ename":"ValueError","evalue":"boom","traceback":["Traceback line","ValueError: boom"]}},',
      '                {"parent_header":parent,"msg_type":"status","content":{"execution_state":"idle"}},',
      '            ]',
      '        elif self.source == "reply-error-large":',
      '            messages = [{"parent_header":parent,"msg_type":"status","content":{"execution_state":"idle"}}]',
      '        else:',
      '            messages = [',
      '                {"parent_header":parent,"msg_type":"stream","content":{"name":"stdout","text":"old"}},',
      '                {"parent_header":parent,"msg_type":"clear_output","content":{"wait":True}},',
      '                {"parent_header":parent,"msg_type":"stream","content":{"name":"stderr","text":"new"}},',
      '                {"parent_header":parent,"msg_type":"status","content":{"execution_state":"idle"}},',
      '            ]',
      '        message = messages[self.phase]; self.phase += 1; return message',
      '',
      'class KernelManager:',
      '    def __init__(self, kernel_name, kernel_spec_manager): self.interrupted = False; self._client = Client(self)',
      '    def start_kernel(self, **kwargs):',
      '        expected = {"stdin": subprocess.DEVNULL} if sys.platform == "win32" else {}',
      '        if kwargs != expected: raise RuntimeError(f"unexpected kernel stdio: {kwargs!r}")',
      '    def client(self): return self._client',
      '    def interrupt_kernel(self): self.interrupted = True',
      '    def shutdown_kernel(self, now=True): pass',
      '',
    ].join('\n'))
    const nativeResource = join(directory, 'native-kernel')
    await writeFile(join(directory, 'jupyter_client', 'kernelspec.py'), [
      `RESOURCE = ${JSON.stringify(nativeResource)}`,
      'class Spec:',
      '    resource_dir = RESOURCE',
      'class KernelSpecManager:',
      '    def __init__(self, kernel_dirs):',
      '        if kernel_dirs != []: raise RuntimeError("ambient kernel dirs were not disabled")',
      '    def get_kernel_spec(self, name):',
      '        if name != "python3": raise RuntimeError("unexpected kernelspec")',
      '        return Spec()',
      '',
    ].join('\n'))
    await mkdir(join(directory, 'ipykernel'))
    await writeFile(join(directory, 'ipykernel', '__init__.py'), '')
    await writeFile(join(directory, 'ipykernel', 'kernelspec.py'), `RESOURCES = ${JSON.stringify(nativeResource)}\n`)
    const rpc = launch(['-S', SUPERVISOR], { ...process.env, PYTHONPATH: directory })
    await expect(rpc.request('start_kernel', { kernelspec: 'python3', timeout_ms: 5_000 }))
      .resolves.toEqual({ status: 'ok', backend: 'jupyter_client' })

    const timed = await rpc.request<{
      status: string
      error: { code: string }
      executionCount: number
    }>('execute', {
      source: 'timeout',
      timeout_ms: 5,
      interrupt_timeout_ms: 100,
      max_output_bytes: 65_536,
    })
    expect(timed.error.code).toBe('EXECUTION_TIMEOUT')
    expect(timed.executionCount).toBe(1)

    const mime = await rpc.request<{ mutations: unknown[]; executionCount: number }>('execute', {
      source: 'mime',
      ...EXECUTE_LIMITS,
    })
    expect(mime.executionCount).toBe(2)
    expect(mime.mutations).toEqual([
      {
        operation: 'append',
        output: {
          type: 'execute-result',
          data: {
            'application/vnd.plotly.v1+json': { type: 'json', value: { data: [1] } },
            'image/png': { type: 'base64', data: 'aGk=' },
            'text/plain': { type: 'text', text: 'old' },
          },
          metadata: { expanded: true },
          executionCount: 2,
          displayId: 'd',
        },
      },
      {
        operation: 'update-display',
        displayId: 'd',
        data: {
          'application/vnd.plotly.v1+json': { type: 'json', value: { data: [2] } },
          'text/plain': { type: 'text', text: 'new' },
        },
        metadata: { expanded: false },
      },
    ])

    const cleared = await rpc.request<{ mutations: unknown[]; executionCount: number }>('execute', {
      source: 'clear',
      ...EXECUTE_LIMITS,
    })
    expect(cleared.executionCount).toBe(3)
    expect(cleared.mutations).toEqual([
      { operation: 'append', output: { type: 'stream', name: 'stdout', text: 'old' } },
      { operation: 'clear', wait: true },
      { operation: 'append', output: { type: 'stream', name: 'stderr', text: 'new' } },
    ])

    const failed = await rpc.request<{
      status: string
      mutations: unknown[]
      error: { code: string; message: string }
      executionCount: number
    }>('execute', { source: 'error', ...EXECUTE_LIMITS })
    expect(failed).toEqual({
      status: 'error',
      mutations: [{
        operation: 'append',
        output: {
          type: 'error',
          name: 'ValueError',
          value: 'boom',
          traceback: ['Traceback line', 'ValueError: boom'],
        },
      }],
      executionCount: 4,
      error: { code: 'EXECUTION_ERROR', message: 'ValueError: boom' },
    })

    const bundleLimited = await rpc.request<{
      status: string
      mutations: unknown[]
      error: { code: string }
      executionCount: number
    }>('execute', {
      source: 'mime',
      ...EXECUTE_LIMITS,
      max_output_bytes: 128,
    })
    expect(bundleLimited.status).toBe('error')
    expect(bundleLimited.mutations).toEqual([])
    expect(bundleLimited.executionCount).toBe(5)
    expect(bundleLimited.error.code).toBe('OUTPUT_LIMIT')

    const replyErrorLimited = await rpc.request<{
      status: string
      mutations: unknown[]
      error: { code: string }
      executionCount: number
    }>('execute', {
      source: 'reply-error-large',
      ...EXECUTE_LIMITS,
      max_output_bytes: 128,
    })
    expect(replyErrorLimited.status).toBe('error')
    expect(replyErrorLimited.mutations).toEqual([])
    expect(replyErrorLimited.executionCount).toBe(6)
    expect(replyErrorLimited.error.code).toBe('OUTPUT_LIMIT')

    const limited = await rpc.request<{ status: string; error: { code: string } }>('execute', {
      source: 'large',
      ...EXECUTE_LIMITS,
      max_output_bytes: 8,
    })
    expect(limited.error.code).toBe('OUTPUT_LIMIT')
    await expect(rpc.request('inspect', { name: 'answer', ...INSPECT_LIMITS }))
      .resolves.toEqual({ status: 'ok', found: true, text: 'answer = 42' })

    await expect(rpc.request('execute', { source: 'missing-count', ...EXECUTE_LIMITS }))
      .rejects.toEqual(expect.objectContaining({ code: 'INVALID_KERNEL_REPLY' }))

    await expect(rpc.request('execute', {
      source: 'unresponsive',
      timeout_ms: 5,
      interrupt_timeout_ms: 5,
      max_output_bytes: 65_536,
    })).rejects.toEqual(expect.objectContaining({ code: 'KERNEL_UNRESPONSIVE' }))
    child!.stdin.end()
  }, 20_000)

  it.skipIf(!hasJupyter)('executes and inspects through a real Jupyter kernel', async () => {
    const rpc = launch()
    await expect(rpc.request('start_kernel', { kernelspec: 'python3', timeout_ms: 15_000 }))
      .resolves.toEqual({ status: 'ok', backend: 'jupyter_client' })
    await expect(rpc.request('execute', {
      source: 'answer = 6 * 7',
      timeout_ms: 10_000,
      interrupt_timeout_ms: 5_000,
      max_output_bytes: 65_536,
    }))
      .resolves.toEqual(expect.objectContaining({ status: 'ok' }))
    const inspected = await rpc.request<{ found: boolean; text: string }>('inspect', {
      name: 'answer',
      timeout_ms: 10_000,
      max_output_bytes: 65_536,
    })
    expect(inspected.found).toBe(true)
    expect(inspected.text).toContain('42')
    await rpc.request('shutdown')
  }, 40_000)

  it.skipIf(!hasJupyter)('binds python3 to ipykernel resources despite a hostile ambient kernelspec', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-jupyter-hostile-kernelspec-'))
    temporaryDirectories.push(directory)
    const kernelspec = join(directory, 'kernels', 'python3')
    await mkdir(kernelspec, { recursive: true })
    await writeFile(join(kernelspec, 'kernel.json'), JSON.stringify({
      argv: [join(directory, 'outside-python'), '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      display_name: 'Hostile ambient Python',
      language: 'python',
    }))
    const rpc = launch([SUPERVISOR], { ...process.env, JUPYTER_PATH: directory })
    await expect(rpc.request('start_kernel', { kernelspec: 'python3', timeout_ms: 15_000 }))
      .resolves.toEqual({ status: 'ok', backend: 'jupyter_client' })
    const execution = await rpc.request<{
      status: string
      mutations: Array<{ output?: { text?: string } }>
    }>('execute', {
      source: 'print("TRUSTED_NATIVE_KERNEL")',
      timeout_ms: 10_000,
      interrupt_timeout_ms: 5_000,
      max_output_bytes: 65_536,
    })
    expect(execution.status).toBe('ok')
    expect(execution.mutations.some(mutation => mutation.output?.text === 'TRUSTED_NATIVE_KERNEL\n')).toBe(true)
    await rpc.request('shutdown')
  }, 40_000)

  it.skipIf(!hasJupyter)('rejects an invalid kernelspec instead of silently falling back', async () => {
    const rpc = launch()
    await expect(rpc.request('start_kernel', {
      kernelspec: 'dsh-kernelspec-that-does-not-exist',
      timeout_ms: 5_000,
    })).rejects.toEqual(expect.objectContaining({
      name: 'SupervisorRpcError',
      code: 'KERNELSPEC_UNTRUSTED',
    }))
    child!.stdin.end()
  }, 20_000)
})
