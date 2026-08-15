import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { BoundedLineReader } from '../src/line-reader.ts'

function reader(
  stream: PassThrough,
  maxLineBytes = 64,
): { lines: string[]; failures: Error[]; closed: { count: number }; read: BoundedLineReader } {
  const lines: string[] = []
  const failures: Error[] = []
  const closed = { count: 0 }
  const read = new BoundedLineReader(stream, {
    maxLineBytes,
    onLine: line => { lines.push(line) },
    onFailure: error => { failures.push(error) },
    onClose: () => { closed.count += 1 },
    overflowError: maxBytes => new Error(`overflow at ${String(maxBytes)}`),
  })
  return { lines, failures, closed, read }
}

describe('BoundedLineReader', () => {
  it('rejects a non-positive byte limit', () => {
    const stream = new PassThrough()
    expect(() => new BoundedLineReader(stream, {
      maxLineBytes: 0,
      onLine: () => {},
      onFailure: () => {},
      onClose: () => {},
      overflowError: () => new Error('overflow'),
    })).toThrow('notebook line reader limit must be a positive safe integer')
  })

  it('delivers every line across chunk boundaries and strips CRLF', () => {
    const stream = new PassThrough()
    const { lines } = reader(stream)
    stream.write('first\r\nsecond\nthird\r\n')
    stream.write('fourth\n')
    expect(lines).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('fails before buffering a line beyond the byte cap', () => {
    const stream = new PassThrough()
    const { failures } = reader(stream, 4)
    stream.write(Buffer.alloc(5, 0x78))
    expect(failures.map(error => error.message)).toEqual(['overflow at 4'])
  })

  it('fails on an over-long line even when a newline follows', () => {
    const stream = new PassThrough()
    const { failures } = reader(stream, 3)
    stream.write('toolong\n')
    expect(failures.map(error => error.message)).toEqual(['overflow at 3'])
  })

  it('reports stream errors through onFailure exactly once', async () => {
    const stream = new PassThrough()
    const { failures, closed } = reader(stream)
    stream.destroy(new Error('read failed'))
    await new Promise(resolve => setImmediate(resolve))
    expect(failures.map(error => error.message)).toEqual(['read failed'])
    expect(closed.count).toBe(0)
  })

  it('reports stream close through onClose exactly once', async () => {
    const stream = new PassThrough()
    const { closed } = reader(stream)
    const done = new Promise<void>(resolve => { stream.once('close', () => { resolve() }) })
    stream.end()
    await done
    expect(closed.count).toBe(1)
  })

  it('ignores callbacks after close()', () => {
    const stream = new PassThrough()
    const { lines, failures, closed, read } = reader(stream)
    read.close()
    stream.write('after-close\n')
    stream.end()
    expect(lines).toEqual([])
    expect(failures).toEqual([])
    expect(closed.count).toBe(0)
  })
})
