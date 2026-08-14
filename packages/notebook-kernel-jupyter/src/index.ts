/**
 * Jupyter kernel backend provider for the notebook seam.
 * @module @deepseek-ai/dsh-notebook-kernel-jupyter
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  NotebookKernelBackend,
  NotebookKernelExecutionEvent,
  NotebookKernelHandle,
  NotebookKernelJsonMimeValue,
  NotebookKernelMimeBundle,
  NotebookKernelMimeValue,
  NotebookKernelOutput,
  NotebookKernelOutputMutation,
  NotebookKernelStartSpec,
} from '@deepseek-ai/dsh-notebook-core'
import {
  NotebookEnvironmentError,
} from '@deepseek-ai/dsh-notebook-environment'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { JsonLineRpcConnection, SupervisorRpcError } from './connection.ts'

/** Cordis plugin name. */
export const name = 'notebook-kernel-jupyter'
/** Required notebook registry, confinement, and subprocess capabilities. */
export const inject = ['notebooks', 'notebookEnvironments', 'sandbox', 'subprocess']

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000
const DEFAULT_RESPONSE_GRACE_MS = 1_000
const DEFAULT_INSPECT_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000
const DEFAULT_GRACE_MS = 3_000
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_MAX_CELL_OUTPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_INSPECT_BYTES = 1 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MIN_RESPONSE_BYTES = 256
const MAX_STDERR_BYTES = 4 * 1024 * 1024
const MAX_CELL_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_INSPECT_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

const SAFE_ENV: NodeJS.ProcessEnv = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  PYTHONUNBUFFERED: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  JUPYTER_PATH: undefined,
  JUPYTER_CONFIG_DIR: undefined,
  JUPYTER_DATA_DIR: undefined,
  IPYTHONDIR: undefined,
}

/**
 * Build the supervisor's non-secret environment additions for one policy.
 * Windows restricted tokens cannot replace the DACL on Jupyter's connection
 * file. Workspace-write already gives the supervisor a per-session private
 * temp directory, so only that mode may use Jupyter Core's documented bypass.
 */
function supervisorEnvironment(policy: SandboxExecutionPolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...SAFE_ENV }
  for (const key of Object.keys(process.env)) {
    const upper = key.toUpperCase()
    if (upper.startsWith('JUPYTER_') || upper.startsWith('IPYTHON')) env[key] = undefined
  }
  if (process.platform === 'win32' && policy.mode === 'workspace-write') {
    env.JUPYTER_ALLOW_INSECURE_WRITES = 'true'
  }
  return env
}

/** Provider configuration. */
export interface Config {
  /** Optional working directory for the supervisor process. */
  cwd?: string
  /** Kernel startup and readiness deadline in milliseconds. */
  startupTimeoutMs?: number
  /** Cell execution deadline in milliseconds. */
  executionTimeoutMs?: number
  /** Deadline for interrupting a timed-out or output-limited Jupyter execution and observing idle. */
  interruptTimeoutMs?: number
  /** Extra host RPC response budget after supervisor-owned work deadlines elapse. */
  responseGraceMs?: number
  /** Kernel inspection deadline in milliseconds. */
  inspectTimeoutMs?: number
  /** Graceful kernel shutdown RPC deadline in milliseconds. */
  shutdownTimeoutMs?: number
  /** Supervisor process SIGTERM-to-SIGKILL grace in milliseconds. */
  graceMs?: number
  /** Largest retained supervisor stderr tail in bytes. */
  maxStderrBytes?: number
  /** Aggregate UTF-8 byte cap for one cell's outputs inside the supervisor. */
  maxCellOutputBytes?: number
  /** UTF-8 byte cap for one inspect reply inside the supervisor. */
  maxInspectBytes?: number
  /** UTF-8 byte cap for one newline-delimited supervisor response. */
  maxResponseBytes?: number
}

/** Schemastery configuration for the Jupyter notebook backend. */
export const Config: z<Config> = z.object({
  cwd: z.string().min(1),
  startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STARTUP_TIMEOUT_MS),
  executionTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_EXECUTION_TIMEOUT_MS),
  interruptTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_INTERRUPT_TIMEOUT_MS),
  responseGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RESPONSE_GRACE_MS),
  inspectTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_INSPECT_TIMEOUT_MS),
  shutdownTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  graceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_GRACE_MS),
  maxStderrBytes: z.number().step(1).min(1).max(MAX_STDERR_BYTES).default(DEFAULT_MAX_STDERR_BYTES),
  maxCellOutputBytes: z.number().step(1).min(1).max(MAX_CELL_OUTPUT_BYTES).default(DEFAULT_MAX_CELL_OUTPUT_BYTES),
  maxInspectBytes: z.number().step(1).min(1).max(MAX_INSPECT_BYTES).default(DEFAULT_MAX_INSPECT_BYTES),
  maxResponseBytes: z.number().step(1).min(MIN_RESPONSE_BYTES).max(MAX_RESPONSE_BYTES).default(DEFAULT_MAX_RESPONSE_BYTES),
})

type ResolvedConfig = Required<Omit<Config, 'cwd'>> & Pick<Config, 'cwd'>

interface JupyterKernelHandle {
  readonly rpc: JsonLineRpcConnection
  readonly child: SubprocessHandle
  stopping?: Promise<void>
}

interface SupervisorStartResult {
  readonly status: 'ok'
  readonly backend: 'jupyter_client'
}

interface SupervisorExecutionError {
  readonly code: string
  readonly message: string
}

type SupervisorExecutionResult =
  | {
    readonly status: 'ok'
    readonly mutations: readonly NotebookKernelOutputMutation[]
    readonly executionCount: number
  }
  | {
    readonly status: 'error'
    readonly mutations: readonly NotebookKernelOutputMutation[]
    readonly executionCount: number
    readonly error: SupervisorExecutionError
  }

interface SupervisorInspectResult {
  readonly status: 'ok'
  readonly found: boolean
  readonly text: string
}

const SUPERVISOR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../supervisor/dsh_notebook_supervisor.py',
)

/** Jupyter process provider retained by the notebook registry. */
export class JupyterKernelBackend implements NotebookKernelBackend {
  readonly type = 'jupyter'

  /**
   * @param ctx - confinement and subprocess services in one execution world.
   * @param config - fully resolved process and protocol limits.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    executionRpcTimeout(config)
    for (const [name, value, max] of [
      ['maxStderrBytes', config.maxStderrBytes, MAX_STDERR_BYTES],
      ['maxCellOutputBytes', config.maxCellOutputBytes, MAX_CELL_OUTPUT_BYTES],
      ['maxInspectBytes', config.maxInspectBytes, MAX_INSPECT_BYTES],
      ['maxResponseBytes', config.maxResponseBytes, MAX_RESPONSE_BYTES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
        throw new Error(`jupyter ${name} must be a positive safe integer no greater than ${max}`)
      }
    }
    if (config.maxResponseBytes < MIN_RESPONSE_BYTES) {
      throw new Error(`jupyter maxResponseBytes must be at least ${MIN_RESPONSE_BYTES}`)
    }
  }

  async start(spec: NotebookKernelStartSpec): Promise<JupyterKernelHandle> {
    spec.signal.throwIfAborted()
    const launch = await this.ctx.notebookEnvironments.resolveLaunch({
      workspaceRoot: spec.sandboxPolicy.workspaceRoot,
      sandboxPolicy: spec.sandboxPolicy,
      environmentId: spec.environmentId,
      signal: spec.signal,
    })
    spec.signal.throwIfAborted()
    const cwd = this.config.cwd ?? spec.cwd ?? spec.sandboxPolicy.workspaceRoot
    const kernelName = spec.kernelName ?? launch.kernelName
    let child: SubprocessHandle
    try {
      const supervisorArgv = [launch.pythonExecutable, SUPERVISOR_PATH]
      const argv = confine(this.ctx, supervisorArgv, spec.sandboxPolicy)
      child = this.ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: this.config.maxStderrBytes },
        },
        graceMs: this.config.graceMs,
        // LocalSubprocessRuntime starts with its canonical credential/DSH scrub;
        // this map adds only non-secret deterministic process controls.
        env: supervisorEnvironment(spec.sandboxPolicy),
      })
    } catch (error) {
      throw kernelStartError(error, kernelName)
    }
    let rpc: JsonLineRpcConnection | undefined
    try {
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('jupyter supervisor requires piped stdin and stdout')
      }
      rpc = new JsonLineRpcConnection(child.stdin, child.stdout, {
        processDone: child.done,
        requestTimeoutMs: executionRpcTimeout(this.config),
        maxResponseBytes: this.config.maxResponseBytes,
      })
      const result = await rpc.request(
        'start_kernel',
        {
          kernelspec: kernelName,
          allow_interpreter_fallback: false,
          timeout_ms: this.config.startupTimeoutMs,
          max_response_bytes: this.config.maxResponseBytes,
        },
        { signal: spec.signal, timeoutMs: rpcTimeout('startup', this.config.startupTimeoutMs, this.config.responseGraceMs) },
      )
      parseStartResult(result)
      return { rpc, child }
    } catch (error) {
      rpc?.close(asError(error))
      logSupervisorStderr(this.ctx, child)
      const failure = kernelStartError(error, kernelName)
      const cleanup = terminateAndJoin(child)
      try {
        await cleanup
      } catch (cleanupError) {
        throw new NotebookEnvironmentError(
          'The Jupyter kernel failed to start and its supervisor did not stop cleanly.',
          'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED',
          'kernel-start',
          true,
          { cause: new AggregateError([error, cleanupError], 'jupyter supervisor startup and cleanup failed') },
        )
      }
      spec.signal.throwIfAborted()
      throw failure
    }
  }

  async *execute(
    handle: NotebookKernelHandle,
    source: string,
    signal: AbortSignal,
  ): AsyncIterable<NotebookKernelExecutionEvent> {
    signal.throwIfAborted()
    const live = handle as JupyterKernelHandle
    let result: SupervisorExecutionResult
    try {
      const response = await live.rpc.request(
        'execute',
        {
          source,
          timeout_ms: this.config.executionTimeoutMs,
          interrupt_timeout_ms: this.config.interruptTimeoutMs,
          max_output_bytes: this.config.maxCellOutputBytes,
          max_response_bytes: this.config.maxResponseBytes,
        },
        { signal, timeoutMs: executionRpcTimeout(this.config) },
      )
      result = parseExecutionResult(response)
    } catch (error) {
      try {
        await stopHandle(live, asError(error))
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'jupyter execution and cleanup failed')
      }
      signal.throwIfAborted()
      throw error
    }
    for (const mutation of result.mutations) yield { type: 'output', mutation }
    if (result.status === 'error') {
      yield {
        type: 'complete',
        status: 'error',
        error: result.error.message,
        executionCount: result.executionCount,
      }
      return
    }
    yield { type: 'complete', status: 'ok', executionCount: result.executionCount }
  }

  async inspect(handle: NotebookKernelHandle, name: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const live = handle as JupyterKernelHandle
    try {
      const response = await live.rpc.request(
        'inspect',
        {
          name,
          timeout_ms: this.config.inspectTimeoutMs,
          max_output_bytes: this.config.maxInspectBytes,
          max_response_bytes: this.config.maxResponseBytes,
        },
        { signal, timeoutMs: rpcTimeout('inspect', this.config.inspectTimeoutMs, this.config.responseGraceMs) },
      )
      return parseInspectResult(response).text
    } catch (error) {
      try {
        await stopHandle(live, asError(error))
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'jupyter inspection and cleanup failed')
      }
      signal.throwIfAborted()
      throw error
    }
  }

  async shutdown(handle: NotebookKernelHandle, signal: AbortSignal): Promise<void> {
    const live = handle as JupyterKernelHandle
    let rpcFailure: unknown
    try {
      if (!live.rpc.failed) {
        await live.rpc.request(
          'shutdown',
          { max_response_bytes: this.config.maxResponseBytes },
          { signal, timeoutMs: rpcTimeout('shutdown', this.config.shutdownTimeoutMs, this.config.responseGraceMs) },
        )
      }
    } catch (error) {
      rpcFailure = error
    }
    try {
      await stopHandle(live, new Error('notebook kernel shut down'))
    } catch (cleanupError) {
      if (rpcFailure !== undefined) {
        throw new AggregateError([rpcFailure, cleanupError], 'jupyter kernel shutdown and cleanup failed')
      }
      throw cleanupError
    }
    if (rpcFailure !== undefined) throw asError(rpcFailure)
  }
}

/**
 * Register the Jupyter kernel backend on `ctx.notebooks`.
 * @param ctx - Cordis context carrying notebook, sandbox, and subprocess services.
 * @param config - optional provider configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.notebooks.registerBackend(new JupyterKernelBackend(ctx, resolveConfig(config)))
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    executionTimeoutMs: config.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    interruptTimeoutMs: config.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS,
    responseGraceMs: config.responseGraceMs ?? DEFAULT_RESPONSE_GRACE_MS,
    inspectTimeoutMs: config.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    maxStderrBytes: config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    maxCellOutputBytes: config.maxCellOutputBytes ?? DEFAULT_MAX_CELL_OUTPUT_BYTES,
    maxInspectBytes: config.maxInspectBytes ?? DEFAULT_MAX_INSPECT_BYTES,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    ...config.cwd === undefined ? {} : { cwd: config.cwd },
  }
}

function executionRpcTimeout(config: ResolvedConfig): number {
  return rpcTimeout(
    'execution',
    config.executionTimeoutMs,
    config.interruptTimeoutMs,
    config.responseGraceMs,
  )
}

function rpcTimeout(label: string, ...parts: readonly number[]): number {
  const timeoutMs = parts.reduce((total, part) => total + part, 0)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`jupyter ${label} RPC timeout components must total no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return timeoutMs
}

function confine(ctx: Context, argv: readonly string[], policy: SandboxExecutionPolicy): readonly string[] {
  if (policy.mode === 'danger-full-access') return argv
  return ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
}

async function stopHandle(handle: JupyterKernelHandle, reason: Error): Promise<void> {
  handle.stopping ??= (async () => {
    handle.rpc.close(reason)
    await terminateAndJoin(handle.child)
  })()
  await handle.stopping
}

async function terminateAndJoin(child: SubprocessHandle): Promise<void> {
  child.terminate()
  const stopped = await child.waitForExit()
  if (!stopped) throw new Error('jupyter supervisor process tree did not stop')
}

function parseStartResult(value: unknown): SupervisorStartResult {
  const record = objectRecord(value, 'start_kernel result')
  if (record.status !== 'ok') throw new Error('invalid start_kernel status')
  if (record.backend !== 'jupyter_client') throw new Error('invalid start_kernel backend')
  return record as unknown as SupervisorStartResult
}

function parseExecutionResult(value: unknown): SupervisorExecutionResult {
  const record = objectRecord(value, 'execute result')
  if (record.status !== 'ok' && record.status !== 'error') throw new Error('invalid execute status')
  if (!Array.isArray(record.mutations)) throw new Error('invalid execute mutations')
  const mutations = record.mutations.map(parseOutputMutation)
  const executionCount = parseExecutionCount(record.executionCount, 'execute result executionCount')
  if (record.status === 'ok') return { status: 'ok', mutations, executionCount }
  const error = objectRecord(record.error, 'execute error')
  if (typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new Error('invalid execute error fields')
  }
  return {
    status: 'error',
    mutations,
    executionCount,
    error: { code: error.code, message: error.message },
  }
}

function parseOutputMutation(value: unknown): NotebookKernelOutputMutation {
  const mutation = objectRecord(value, 'notebook output mutation')
  switch (mutation.operation) {
    case 'append':
      return { operation: 'append', output: parseKernelOutput(mutation.output) }
    case 'clear':
      if (typeof mutation.wait !== 'boolean') throw new Error('invalid clear output wait flag')
      return { operation: 'clear', wait: mutation.wait }
    case 'update-display': {
      if (typeof mutation.displayId !== 'string' || mutation.displayId.length === 0) {
        throw new Error('invalid update display id')
      }
      return {
        operation: 'update-display',
        displayId: mutation.displayId,
        data: parseMimeBundle(mutation.data),
        metadata: parseJsonObject(mutation.metadata, 'update display metadata'),
      }
    }
    default:
      throw new Error('invalid notebook output mutation operation')
  }
}

function parseKernelOutput(value: unknown): NotebookKernelOutput {
  const output = objectRecord(value, 'notebook kernel output')
  switch (output.type) {
    case 'stream':
      if ((output.name !== 'stdout' && output.name !== 'stderr') || typeof output.text !== 'string') {
        throw new Error('invalid notebook stream output')
      }
      return { type: 'stream', name: output.name, text: output.text }
    case 'display':
      return {
        type: 'display',
        data: parseMimeBundle(output.data),
        metadata: parseJsonObject(output.metadata, 'display metadata'),
        ...parseDisplayId(output.displayId),
      }
    case 'execute-result':
      return {
        type: 'execute-result',
        data: parseMimeBundle(output.data),
        metadata: parseJsonObject(output.metadata, 'execute result metadata'),
        executionCount: output.executionCount === null
          ? null
          : parseExecutionCount(output.executionCount, 'execute result output executionCount'),
        ...parseDisplayId(output.displayId),
      }
    case 'error': {
      if (typeof output.name !== 'string' || typeof output.value !== 'string') {
        throw new Error('invalid notebook error output fields')
      }
      if (!Array.isArray(output.traceback) || !output.traceback.every(line => typeof line === 'string')) {
        throw new Error('invalid notebook error traceback')
      }
      return { type: 'error', name: output.name, value: output.value, traceback: output.traceback }
    }
    default:
      throw new Error('invalid notebook kernel output type')
  }
}

function parseDisplayId(value: unknown): { readonly displayId?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid notebook display id')
  return { displayId: value }
}

function parseMimeBundle(value: unknown): NotebookKernelMimeBundle {
  const bundle = objectRecord(value, 'notebook MIME bundle')
  const entries: [string, NotebookKernelMimeValue][] = []
  for (const [mimeType, payload] of Object.entries(bundle)) {
    if (mimeType.length === 0) throw new Error('invalid empty notebook MIME type')
    entries.push([mimeType, parseMimeValue(payload)])
  }
  return Object.fromEntries(entries)
}

function parseMimeValue(value: unknown): NotebookKernelMimeValue {
  const payload = objectRecord(value, 'notebook MIME value')
  switch (payload.type) {
    case 'text':
      if (typeof payload.text !== 'string') throw new Error('invalid notebook text MIME value')
      return { type: 'text', text: payload.text }
    case 'json':
      return { type: 'json', value: parseJsonValue(payload.value) }
    case 'base64':
      if (typeof payload.data !== 'string' || !isCanonicalBase64(payload.data)) {
        throw new Error('invalid notebook base64 MIME value')
      }
      return { type: 'base64', data: payload.data }
    default:
      throw new Error('invalid notebook MIME value type')
  }
}

type KernelJsonValue = NotebookKernelJsonMimeValue['value']

function parseJsonValue(value: unknown): KernelJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    /* v8 ignore next -- JSON.parse cannot produce NaN or infinity; this guard documents the retained JSON-value invariant. */
    if (!Number.isFinite(value)) throw new Error('invalid non-finite notebook JSON number')
    return value
  }
  if (Array.isArray(value)) return value.map(parseJsonValue)
  return parseJsonObject(value, 'notebook JSON object')
}

function parseJsonObject(value: unknown, name: string): Record<string, KernelJsonValue> {
  const record = objectRecord(value, name)
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, parseJsonValue(entry)]))
}

function parseExecutionCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${name}`)
  }
  return value
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function parseInspectResult(value: unknown): SupervisorInspectResult {
  const record = objectRecord(value, 'inspect result')
  if (record.status !== 'ok' || typeof record.found !== 'boolean' || typeof record.text !== 'string') {
    throw new Error('invalid inspect result fields')
  }
  return { status: 'ok', found: record.found, text: record.text }
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${name}`)
  }
  return value as Record<string, unknown>
}

function logSupervisorStderr(ctx: Context, child: SubprocessHandle): void {
  const stderr = child.collected.stderr?.readFrom(0).text.trim() ?? ''
  if (stderr !== '') ctx.logger.warn(`jupyter supervisor startup failed: ${stderr}`)
}

function kernelStartError(error: unknown, kernelName: string): NotebookEnvironmentError {
  if (error instanceof NotebookEnvironmentError) return error
  const code = error instanceof SupervisorRpcError ? error.code : undefined
  if (code === 'JUPYTER_DEPENDENCY_UNAVAILABLE' || code === 'JUPYTER_IMPORT_FAILED') {
    return new NotebookEnvironmentError(
      'The selected environment does not contain a usable jupyter_client installation.',
      'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED',
      'dependency',
      true,
      { cause: error },
    )
  }
  if (code === 'KERNELSPEC_MISSING' || code === 'KERNELSPEC_UNTRUSTED') {
    return new NotebookEnvironmentError(
      `The selected environment does not provide the ${JSON.stringify(kernelName)} kernelspec.`,
      'NOTEBOOK_ENVIRONMENT_KERNELSPEC_MISSING',
      'kernelspec',
      true,
      { cause: error },
    )
  }
  return new NotebookEnvironmentError(
    'The Jupyter kernel could not be started.',
    'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED',
    'kernel-start',
    true,
    { cause: error },
  )
}

function asError(value: unknown): Error {
  /* v8 ignore next -- typed RPC and subprocess calls reject with Error; this guards foreign implementations. */
  return value instanceof Error ? value : new Error(String(value))
}

export {
  JsonLineRpcConnection,
  SupervisorRpcError,
  SupervisorRpcTimeoutError,
} from './connection.ts'
