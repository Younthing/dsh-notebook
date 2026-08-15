/**
 * Bounded newline-delimited reader over one Node readable stream.
 *
 * Harness rc.7 ships this helper in `@deepseek-ai/dsh-subprocess`; the rc.6
 * baseline does not, so the notebook supervisor transport keeps its own copy
 * with the same construction and delivery contract. Every complete line
 * (trailing newline stripped, CRLF tolerated) is delivered to `onLine` in
 * arrival order; a line that would exceed `maxLineBytes` fails the reader
 * instead of buffering it. Stream failure and stream close each surface once
 * through `onFailure` / `onClose`; `close()` detaches the reader so no
 * callback fires afterwards.
 * @module @younthing/dsh-notebook-kernel-jupyter/line-reader
 */

import type { Readable } from 'node:stream'

/** Callbacks and byte limit for one bounded line reader. */
export interface BoundedLineReaderOptions {
  /** Maximum UTF-8 bytes accepted before one line-ending. */
  readonly maxLineBytes: number
  /** Deliver one complete line without its trailing newline. */
  readonly onLine: (line: string) => void
  /** Report a stream error or an overflowed line. */
  readonly onFailure: (error: Error) => void
  /** Report that the underlying stream closed before another line ended. */
  readonly onClose: () => void
  /** Build the overflow failure for one byte limit. */
  readonly overflowError: (maxBytes: number) => Error
}

/** One bounded, newline-delimited reader over a readable stream. */
export class BoundedLineReader {
  private buffer = Buffer.alloc(0)
  private settled = false
  private readonly stream: Readable
  private readonly options: BoundedLineReaderOptions

  /**
   * Attach to a readable stream and deliver bounded lines until failure or close.
   * @param stream - the readable byte stream to consume.
   * @param options - byte limit and delivery callbacks.
   */
  constructor(stream: Readable, options: BoundedLineReaderOptions) {
    if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes <= 0) {
      throw new Error('notebook line reader limit must be a positive safe integer')
    }
    this.stream = stream
    this.options = options
    stream.on('data', this.onData)
    stream.on('error', this.onError)
    stream.on('end', this.onEnd)
    stream.on('close', this.onClose)
  }

  /** Permanently detach from the stream; no further callbacks fire. */
  close(): void {
    if (this.settled) return
    this.settled = true
    this.stream.off('data', this.onData)
    this.stream.off('error', this.onError)
    this.stream.off('end', this.onEnd)
    this.stream.off('close', this.onClose)
    this.buffer = Buffer.alloc(0)
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.settled) return
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) break
      const lineBytes = newline > 0 && this.buffer[newline - 1] === 0x0d ? newline - 1 : newline
      const line = this.buffer.subarray(0, lineBytes)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length > this.options.maxLineBytes) {
        this.fail(this.options.overflowError(this.options.maxLineBytes))
        return
      }
      this.options.onLine(line.toString('utf8'))
    }
    if (this.buffer.length > this.options.maxLineBytes) {
      this.fail(this.options.overflowError(this.options.maxLineBytes))
    }
  }

  private readonly onError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onEnd = (): void => {
    this.close()
    this.options.onClose()
  }

  private readonly onClose = (): void => {
    if (this.settled) return
    this.close()
    this.options.onClose()
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.close()
    this.options.onFailure(error)
  }
}
