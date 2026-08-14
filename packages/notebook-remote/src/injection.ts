/** Bounded model-visible rendering of one user-initiated notebook execution. */

import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type {
  NotebookExecuteResult,
  NotebookJsonValue,
  NotebookMimeBundle,
  NotebookOutput,
} from '@deepseek-ai/dsh-notebook-core/types'

const TRUNCATION_MARKER = '\n[notebook output truncated]'
const textEncoder = new TextEncoder()

class Writer {
  private readonly parts: string[] = []
  private readonly marker: string
  private remaining: number
  truncated = false

  constructor(maxBytes: number) {
    const marker = new TextRetainer({ kind: 'head', maxBytes })
    marker.push(TRUNCATION_MARKER)
    this.marker = marker.finish().text
    this.remaining = Math.max(0, maxBytes - textEncoder.encode(this.marker).byteLength)
  }

  write(text: string): void {
    if (this.truncated || text.length === 0) return
    let offset = 0
    while (offset < text.length) {
      let end = Math.min(text.length, offset + 1024)
      if (end < text.length) {
        const last = text.charCodeAt(end - 1)
        if (last >= 0xd800 && last <= 0xdbff) end -= 1
      }
      const chunk = text.slice(offset, end)
      const bytes = textEncoder.encode(chunk)
      if (bytes.byteLength <= this.remaining) {
        this.parts.push(chunk)
        this.remaining -= bytes.byteLength
        offset = end
        continue
      }
      const retained = new TextRetainer({ kind: 'head', maxBytes: this.remaining })
      retained.push(chunk)
      this.parts.push(retained.finish().text)
      this.remaining = 0
      this.truncated = true
      return
    }
  }

  finish(): string {
    return this.parts.join('') + (this.truncated ? this.marker : '')
  }
}

function writeJsonString(writer: Writer, value: string): void {
  writer.write('"')
  for (const character of value) {
    if (writer.truncated) return
    switch (character) {
      case '"': writer.write('\\"'); break
      case '\\': writer.write('\\\\'); break
      case '\b': writer.write('\\b'); break
      case '\f': writer.write('\\f'); break
      case '\n': writer.write('\\n'); break
      case '\r': writer.write('\\r'); break
      case '\t': writer.write('\\t'); break
      default: {
        const code = character.codePointAt(0) as number
        writer.write(code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character)
      }
    }
  }
  writer.write('"')
}

function writeJson(writer: Writer, root: NotebookJsonValue): void {
  type Frame =
    | { readonly kind: 'value'; readonly value: NotebookJsonValue }
    | { readonly kind: 'array'; readonly value: readonly NotebookJsonValue[]; readonly index: number }
    | { readonly kind: 'object'; readonly entries: readonly [string, NotebookJsonValue][]; readonly index: number }
  const frames: Frame[] = [{ kind: 'value', value: root }]
  while (frames.length > 0 && !writer.truncated) {
    const frame = frames.pop()
    if (frame === undefined) break
    switch (frame.kind) {
      case 'value':
        if (frame.value === null) writer.write('null')
        else if (typeof frame.value === 'boolean' || typeof frame.value === 'number') writer.write(String(frame.value))
        else if (typeof frame.value === 'string') writeJsonString(writer, frame.value)
        else if (Array.isArray(frame.value)) {
          writer.write('[')
          frames.push({ kind: 'array', value: frame.value, index: 0 })
        } else {
          writer.write('{')
          frames.push({ kind: 'object', entries: Object.entries(frame.value), index: 0 })
        }
        break
      case 'array':
        if (frame.index >= frame.value.length) writer.write(']')
        else {
          if (frame.index > 0) writer.write(',')
          frames.push({ ...frame, index: frame.index + 1 })
          frames.push({ kind: 'value', value: frame.value[frame.index] as NotebookJsonValue })
        }
        break
      case 'object': {
        const entry = frame.entries[frame.index]
        if (entry === undefined) writer.write('}')
        else {
          if (frame.index > 0) writer.write(',')
          writeJsonString(writer, entry[0])
          writer.write(':')
          frames.push({ ...frame, index: frame.index + 1 })
          frames.push({ kind: 'value', value: entry[1] })
        }
        break
      }
    }
  }
}

function writeBundle(writer: Writer, bundle: NotebookMimeBundle): void {
  for (const [mimeType, value] of Object.entries(bundle)) {
    if (writer.truncated) return
    writer.write(`\n[${mimeType}] `)
    switch (value.type) {
      case 'text': writer.write(value.text); break
      case 'json': writeJson(writer, value.value); break
      case 'image':
        writer.write(
          `image attachment ${String(value.attachment.attachmentId)} `
          + `(${value.attachment.mediaType}, ${String(value.attachment.width)}x${String(value.attachment.height)}, `
          + `${String(value.attachment.bytes)} bytes)`,
        )
        break
      case 'base64': writer.write(`inline binary payload (${String(value.data.length)} base64 characters)`); break
    }
  }
}

function writeOutput(writer: Writer, output: NotebookOutput, index: number): void {
  switch (output.type) {
    case 'stream': writer.write(`\n\nOutput ${String(index + 1)} (${output.name})\n${output.text}`); break
    case 'display':
      writer.write(`\n\nOutput ${String(index + 1)} (display)`)
      writeBundle(writer, output.data)
      break
    case 'execute-result':
      writer.write(`\n\nOutput ${String(index + 1)} (execute result, count=${output.executionCount === null ? 'unknown' : String(output.executionCount)})`)
      writeBundle(writer, output.data)
      break
    case 'error':
      writer.write(`\n\nOutput ${String(index + 1)} (error)\n${output.name}: ${output.value}`)
      for (const line of output.traceback) writer.write(`\n${line}`)
      break
  }
}

/** Render an execution result within an exact UTF-8 byte budget. */
export function renderNotebookInjection(result: NotebookExecuteResult, maxBytes: number): string {
  const writer = new Writer(maxBytes)
  writer.write(`Notebook cell execution ${result.status}; execution count ${result.executionCount === null ? 'unknown' : String(result.executionCount)}.`)
  if (result.error !== undefined) writer.write(`\nError: ${result.error}`)
  if (result.outputs.length === 0) writer.write('\nNo output.')
  for (const [index, output] of result.outputs.entries()) writeOutput(writer, output, index)
  return writer.finish()
}
