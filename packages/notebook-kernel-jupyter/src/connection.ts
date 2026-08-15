/**
 * Newline-delimited JSON-RPC client for the Python notebook supervisor.
 * @module @younthing/dsh-notebook-kernel-jupyter/connection
 */

import type { Readable, Writable } from 'node:stream'
import { BoundedLineReader } from './line-reader.ts'

interface JsonRpcResponse {
  readonly id?: unknown
  readonly result?: unknown
  readonly error?: unknown
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

/** Process and timeout facts required by one supervisor transport. */
export interface JsonLineRpcConnectionOptions {
  /** Settles when the owned supervisor process closes; rejection means spawn failure. */
  readonly processDone: Promise<unknown>
  /** Default positive request deadline in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum UTF-8 bytes accepted before one supervisor response newline. */
  readonly maxResponseBytes: number
}

/** Per-request cancellation and optional deadline override. */
export interface JsonLineRpcRequestOptions {
  /** Cancels this request while the provider tears down the executing process. */
  readonly signal?: AbortSignal
  /** Positive request deadline in milliseconds, overriding the connection default. */
  readonly timeoutMs?: number
}

/** Structured error returned by the Python supervisor. */
export class SupervisorRpcError extends Error {
  /** Stable supervisor error category when supplied. */
  readonly code: string | undefined
  /** Optional JSON-safe diagnostic details. */
  readonly details: unknown

  /**
   * @param message - human-readable failure.
   * @param code - stable error category.
   * @param details - optional JSON-safe diagnostics.
   */
  constructor(message: string, code?: string, details?: unknown) {
    super(message)
    this.name = 'SupervisorRpcError'
    this.code = code
    this.details = details
  }
}

/** A supervisor request exceeded its configured deadline. */
export class SupervisorRpcTimeoutError extends Error {
  /**
   * @param method - timed-out RPC method.
   * @param timeoutMs - elapsed deadline.
   */
  constructor(method: string, timeoutMs: number) {
    super(`notebook supervisor RPC "${method}" timed out after ${timeoutMs}ms`)
    this.name = 'SupervisorRpcTimeoutError'
  }
}

/** Client for one supervisor process speaking JSON lines over stdio. */
export class JsonLineRpcConnection {
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly reader: BoundedLineReader
  private closeReason: Error | undefined

  /**
   * Attach to one supervisor process and observe every transport-close path.
   * @param stdin - child stdin writable stream.
   * @param stdout - child stdout readable stream.
   * @param options - process-close promise and default request deadline.
   */
  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly options: JsonLineRpcConnectionOptions,
  ) {
    assertPositiveTimeout(options.requestTimeoutMs)
    assertPositiveByteLimit(options.maxResponseBytes)
    this.reader = new BoundedLineReader(
      stdout,
      {
        maxLineBytes: options.maxResponseBytes,
        onLine: this.onLine,
        onFailure: this.onStdoutError,
        onClose: this.onStdoutClose,
        overflowError: maxBytes => new Error(`notebook supervisor response exceeded ${maxBytes} bytes`),
      },
    )
    this.stdin.on('error', this.onStdinError)
    void options.processDone.then(
      () => { this.fail(new Error('notebook supervisor exited')) },
      (error: unknown) => { this.fail(asError(error)) },
    )
  }

  /** Whether a fatal transport, framing, timeout, or process-close failure has occurred. */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * Invoke one supervisor method and await its result.
   * @param method - RPC method name.
   * @param params - method parameters.
   * @param options - request cancellation and deadline override.
   * @returns parsed result payload.
   */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: JsonLineRpcRequestOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs
    assertPositiveTimeout(timeoutMs)
    try {
      options.signal?.throwIfAborted()
    } catch (error) {
      return Promise.reject(asError(error))
    }
    if (this.closeReason !== undefined) return Promise.reject(this.closeReason)

    const id = ++this.nextId
    const payload = `${JSON.stringify({ id, method, params })}\n`
    const promise = new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.settle(id, asError(options.signal?.reason ?? new Error('notebook supervisor RPC aborted')))
      }
      const timer = setTimeout(() => {
        const error = new SupervisorRpcTimeoutError(method, timeoutMs)
        this.settle(id, error)
        this.fail(error)
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, {
        resolve: (value) => { resolve(value as T) },
        reject,
        cleanup,
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      // Abort may race the preflight check and listener registration. Re-read
      // after registration, then avoid writing a request already settled by cancellation.
      if (options.signal?.aborted === true) onAbort()
      if (!this.pending.has(id)) return

      const onWrite = (error?: Error | null): void => {
        if (error === undefined || error === null) return
        this.fail(error)
      }
      try {
        this.stdin.write(payload, onWrite)
      } catch (error) {
        this.fail(asError(error))
      }
    })
    // A caller may abandon an aborted request while provider teardown closes the process.
    promise.catch(() => {})
    return promise
  }

  /**
   * Ask the supervisor to stop its kernel. Process termination and joining remain provider-owned.
   * @param signal - shutdown cancellation/deadline signal.
   */
  async shutdown(signal?: AbortSignal): Promise<void> {
    await this.request('shutdown', {}, signal === undefined ? {} : { signal })
  }

  /**
   * Permanently close the transport and reject every outstanding request.
   * @param reason - terminal connection reason.
   */
  close(reason: Error = new Error('notebook supervisor connection closed')): void {
    this.fail(reason)
    this.reader.close()
  }

  private readonly onLine = (line: string): void => {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      this.fail(new Error(`invalid JSON from notebook supervisor: ${asError(error).message}`))
      return
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.fail(new Error('invalid notebook supervisor response object'))
      return
    }
    const parsed = value as JsonRpcResponse
    if (typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id)) {
      this.fail(new Error('invalid notebook supervisor response id'))
      return
    }
    const pending = this.pending.get(parsed.id)
    if (pending === undefined) return
    if (parsed.error !== undefined) {
      const error = parseRpcError(parsed.error)
      this.settle(parsed.id, error)
      return
    }
    this.settle(parsed.id, undefined, parsed.result)
  }

  private readonly onStdoutClose = (): void => {
    this.fail(new Error('notebook supervisor stdout closed'))
  }

  private readonly onStdoutError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onStdinError = (error: Error): void => {
    this.fail(error)
  }

  private settle(id: number, error?: Error, value?: unknown): void {
    const pending = this.pending.get(id)
    /* v8 ignore next -- callers obtain ids from this map or check membership; this closes a timeout/transport race. */
    if (pending === undefined) return
    this.pending.delete(id)
    pending.cleanup()
    if (error !== undefined) pending.reject(error)
    else pending.resolve(value)
  }

  private fail(error: Error): void {
    if (this.closeReason === undefined) this.closeReason = error
    this.reader.close()
    const reason = this.closeReason
    const ids = [...this.pending.keys()]
    for (const id of ids) this.settle(id, reason)
  }
}

function parseRpcError(value: unknown): SupervisorRpcError {
  if (value === null || typeof value !== 'object') {
    return new SupervisorRpcError('notebook supervisor RPC failed')
  }
  const record = value as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : 'notebook supervisor RPC failed'
  const code = typeof record.code === 'string' ? record.code : undefined
  return new SupervisorRpcError(message, code, record.details)
}

function assertPositiveTimeout(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('notebook supervisor request timeout must be a positive finite number')
  }
}

function assertPositiveByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('notebook supervisor response limit must be a positive safe integer')
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
