import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  EnvironmentCommandRunner,
  type EnvironmentCommandSpec,
} from '../src/runner.ts'

interface HandleOptions {
  readonly stdout?: string
  readonly stderr?: string
  readonly stdoutLossy?: boolean
  readonly stderrLossy?: boolean
  readonly done?: SubprocessHandle['done']
  readonly waitForExit?: SubprocessHandle['waitForExit']
}

function reader(text: string, lossy = false): SubprocessOutputReader {
  return {
    readFrom() {
      return { text, nextOffset: Buffer.byteLength(text), lossy }
    },
  }
}

function handle(options: HandleOptions = {}) {
  const terminate = vi.fn<SubprocessHandle['terminate']>()
  const waitForExit = vi.fn<SubprocessHandle['waitForExit']>(
    options.waitForExit ?? (async () => true),
  )
  const value: SubprocessHandle = {
    pid: 1,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: reader(options.stdout ?? '', options.stdoutLossy),
      stderr: reader(options.stderr ?? '', options.stderrLossy),
    },
    done: options.done ?? Promise.resolve({ exitCode: 0, signal: null }),
    terminate,
    waitForExit,
  }
  return { value, terminate, waitForExit }
}

function command(
  signal = new AbortController().signal,
  sandboxPolicy: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: 'C:/workspace' },
): EnvironmentCommandSpec {
  return {
    argv: ['uv', '--version'],
    cwd: 'C:/workspace',
    sandboxPolicy,
    env: { UV_NO_CONFIG: '1' },
    signal,
    label: 'fixture operation',
    failureCode: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
    category: 'python',
  }
}

function setup(next: SubprocessHandle | (() => SubprocessHandle), maxOutputBytes = 64) {
  const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() =>
    typeof next === 'function' ? next() : next)
  const confine = vi.fn(() => ({
    argv: ['sandbox', '--', 'uv', '--version'],
    enforcement: 'full' as const,
    denialSignatures: ['permission denied'],
    runnerFailureRules: [],
  }))
  const warn = vi.fn()
  const ctx = {
    subprocess: { spawn },
    sandbox: { confine },
    logger: { warn },
  } as unknown as Context
  return { runner: new EnvironmentCommandRunner(ctx, maxOutputBytes, 20), spawn, confine, warn }
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

describe('EnvironmentCommandRunner', () => {
  it('runs a successful unconfined command with complete explicit process controls', async () => {
    const child = handle({ stdout: 'uv 0.11.32\n' })
    const fixture = setup(child.value)

    await expect(fixture.runner.run(command())).resolves.toEqual({ stdout: 'uv 0.11.32\n', stderr: '' })
    expect(fixture.confine).not.toHaveBeenCalled()
    const spawned = fixture.spawn.mock.calls[0]?.[0]
    expect(spawned).toMatchObject({
      argv: ['uv', '--version'],
      cwd: 'C:/workspace',
      graceMs: 20,
      env: { UV_NO_CONFIG: '1' },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 },
        stderr: { maxBytes: 64 },
      },
    })
    expect(spawned?.signal).toBeInstanceOf(AbortSignal)
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('confines restricted commands and classifies the active sandbox denial dialect', async () => {
    const child = handle({
      stderr: 'Permission denied while writing\n',
      done: Promise.resolve({ exitCode: 1, signal: null }),
    })
    const fixture = setup(child.value)
    const spec = command(undefined, { mode: 'workspace-write', workspaceRoot: 'C:/workspace' })

    await expect(fixture.runner.run(spec)).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      category: 'permission',
      retryable: false,
    })
    expect(fixture.confine).toHaveBeenCalledWith(
      ['uv', '--version'],
      { mode: 'workspace-write', workspaceRoot: 'C:/workspace' },
    )
    expect(fixture.spawn.mock.calls[0]![0].argv).toEqual(['sandbox', '--', 'uv', '--version'])
    expect(fixture.warn).toHaveBeenCalledWith('fixture operation failed: Permission denied while writing')
  })

  it('fails before spawning when the sandbox cannot confine the command', async () => {
    const fixture = setup(handle().value)
    fixture.confine.mockImplementation(() => { throw new Error('sandbox unavailable') })

    await expect(fixture.runner.run(command(
      undefined,
      { mode: 'read-only', workspaceRoot: 'C:/workspace' },
    ))).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED',
      category: 'permission',
      retryable: false,
    })
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('classifies synchronous spawn failure without publishing a handle', async () => {
    const fixture = setup(handle().value)
    fixture.spawn.mockImplementation(() => { throw new Error('spawn failed') })

    await expect(fixture.runner.run(command())).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
      category: 'python',
      retryable: true,
    })
  })

  it('terminates and joins after asynchronous process failure', async () => {
    const child = handle({ done: Promise.reject(new Error('spawn event failed')) })
    const fixture = setup(child.value)

    await expect(fixture.runner.run(command())).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
      category: 'python',
      retryable: true,
    })
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('turns a failed join and failed cleanup join into one typed failure', async () => {
    const child = handle({ waitForExit: async () => false })
    const fixture = setup(child.value)

    const error = await captureRejection(fixture.runner.run(command()))
    expect(error).toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
      category: 'python',
      retryable: true,
    })
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledTimes(2)
  })

  it('preserves caller cancellation after terminating and joining its child', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const fixture = setup(handle().value)

    await expect(fixture.runner.run(command(controller.signal))).rejects.toThrow('caller stopped')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('rejects lossy or aggregate-over-limit collected output', async () => {
    const lossy = handle({ stdout: 'tail', stdoutLossy: true })
    const stderrLossy = handle({ stderr: 'tail', stderrLossy: true })
    const aggregate = handle({ stdout: '123456', stderr: 'abcdef' })
    const children = [lossy.value, stderrLossy.value, aggregate.value]
    const fixture = setup(() => children.shift()!, 10)

    await expect(fixture.runner.run(command())).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_OUTPUT_LIMIT',
      category: 'python',
      retryable: false,
    })
    await expect(fixture.runner.run(command())).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_OUTPUT_LIMIT',
      category: 'python',
      retryable: false,
    })
    await expect(fixture.runner.run(command())).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_OUTPUT_LIMIT',
      category: 'python',
      retryable: false,
    })
  })

  it('treats uncollected successful output as empty', async () => {
    const child = handle()
    const value = { ...child.value, collected: {} }
    const fixture = setup(value)

    await expect(fixture.runner.run(command())).resolves.toEqual({ stdout: '', stderr: '' })
  })

  it('logs bounded diagnostics unless the probe explicitly suppresses them', async () => {
    const logged = handle({
      stderr: 'bounded failure\n',
      done: Promise.resolve({ exitCode: 2, signal: null }),
    })
    const quiet = handle({
      stderr: 'probe failure\n',
      done: Promise.resolve({ exitCode: 2, signal: null }),
    })
    const children = [logged.value, quiet.value]
    const fixture = setup(() => children.shift()!)

    await expect(fixture.runner.run(command())).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
      retryable: true,
    })
    await expect(fixture.runner.run({ ...command(), logFailure: false })).rejects.toMatchObject({
      code: 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED',
      retryable: true,
    })
    expect(fixture.warn).toHaveBeenCalledOnce()
    expect(fixture.warn).toHaveBeenCalledWith('fixture operation failed: bounded failure')
  })
})
