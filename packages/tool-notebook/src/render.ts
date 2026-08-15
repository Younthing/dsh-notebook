/** Incrementally bounded model-facing rendering for notebook documents and executions. */

import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import type {
  NotebookCellAttachments,
  NotebookDocument,
  NotebookExecuteResult,
  NotebookJsonValue,
  NotebookMimeBundle,
  NotebookMimeValue,
  NotebookOutput,
} from '@younthing/dsh-notebook-core/types'
import { notebookImageAttachmentJson } from './mime.ts'

const encoder = new TextEncoder()
const TRUNCATED = '\n[notebook content truncated]'
const TEXT_CHUNK_CODE_UNITS = 2_048

function retainedHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  pushText(retainer, text)
  return retainer.finish().text
}

function* textChunks(text: string): Generator<string> {
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + TEXT_CHUNK_CODE_UNITS, text.length)
    if (
      end < text.length
      && isHighSurrogate(text.charCodeAt(end - 1))
      && isLowSurrogate(text.charCodeAt(end))
    ) {
      end -= 1
    }
    yield text.slice(offset, end)
    offset = end
  }
}

function pushText(retainer: TextRetainer, text: string): boolean {
  for (const chunk of textChunks(text)) {
    if (retainer.push(chunk).truncated) return false
  }
  return true
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

/** Prefix writer that stops consuming input once its complete result exceeds the cap. */
class NotebookTextWriter {
  private readonly result: TextRetainer
  private readonly prefix: TextRetainer
  private readonly marker: string
  private truncated = false

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error('notebook render maxBytes must be a non-negative safe integer')
    }
    this.marker = retainedHead(TRUNCATED, maxBytes)
    const markerBytes = encoder.encode(this.marker).byteLength
    this.result = new TextRetainer({ kind: 'head', maxBytes })
    this.prefix = new TextRetainer({ kind: 'head', maxBytes: maxBytes - markerBytes })
  }

  get full(): boolean {
    return this.truncated
  }

  push(text: string): boolean {
    if (this.truncated || text.length === 0) return !this.truncated
    for (const chunk of textChunks(text)) {
      this.prefix.push(chunk)
      if (this.result.push(chunk).truncated) {
        this.truncated = true
        return false
      }
    }
    return true
  }

  finish(): string {
    return this.truncated
      ? this.prefix.finish().text + this.marker
      : this.result.finish().text
  }
}

interface JsonValueFrame {
  readonly kind: 'value'
  readonly value: NotebookJsonValue | undefined
}

interface JsonArrayFrame {
  readonly kind: 'array'
  readonly value: readonly NotebookJsonValue[]
  readonly index: number
}

interface JsonObjectFrame {
  readonly kind: 'object'
  readonly value: Readonly<Record<string, NotebookJsonValue>>
  readonly entries: Iterator<readonly [string, NotebookJsonValue]>
  readonly wroteEntry: boolean
}

type JsonFrame = JsonValueFrame | JsonArrayFrame | JsonObjectFrame

function writeJsonValue(writer: NotebookTextWriter, value: NotebookJsonValue): void {
  const active = new Set<object>()
  const frames: JsonFrame[] = [{ kind: 'value', value }]
  while (frames.length > 0 && !writer.full) {
    const frame = frames.pop()
    if (frame === undefined) break
    switch (frame.kind) {
      case 'value': {
        const candidate = frame.value
        if (candidate === null || candidate === undefined) {
          writer.push('null')
        } else if (typeof candidate === 'string') {
          writeJsonString(writer, candidate)
        } else if (typeof candidate === 'number') {
          writer.push(Number.isFinite(candidate) ? String(candidate) : 'null')
        } else if (typeof candidate === 'boolean') {
          writer.push(candidate ? 'true' : 'false')
        } else if (active.has(candidate)) {
          writeJsonString(writer, '[circular]')
        } else if (Array.isArray(candidate)) {
          active.add(candidate)
          writer.push('[')
          frames.push({ kind: 'array', value: candidate, index: 0 })
        } else {
          const object = candidate as Readonly<Record<string, NotebookJsonValue>>
          active.add(object)
          writer.push('{')
          frames.push({
            kind: 'object',
            value: object,
            entries: ownJsonEntries(object),
            wroteEntry: false,
          })
        }
        break
      }
      case 'array': {
        if (frame.index >= frame.value.length) {
          active.delete(frame.value)
          writer.push(']')
          break
        }
        if (frame.index > 0) writer.push(',')
        frames.push({ ...frame, index: frame.index + 1 })
        frames.push({ kind: 'value', value: frame.value[frame.index] })
        break
      }
      case 'object': {
        const next = frame.entries.next()
        if (next.done === true) {
          active.delete(frame.value)
          writer.push('}')
          break
        }
        if (frame.wroteEntry) writer.push(',')
        const [key, entry] = next.value
        writeJsonString(writer, key)
        writer.push(':')
        frames.push({ ...frame, wroteEntry: true })
        frames.push({ kind: 'value', value: entry })
        break
      }
    }
  }
}

function* ownJsonEntries(
  value: Readonly<Record<string, NotebookJsonValue>>,
): Generator<readonly [string, NotebookJsonValue]> {
  for (const key in value) {
    const entry = value[key]
    if (Object.hasOwn(value, key) && entry !== undefined) yield [key, entry]
  }
}

function writeJsonString(writer: NotebookTextWriter, value: string): void {
  if (!writer.push('"')) return
  let plain = ''
  for (const character of value) {
    const escaped = escapedJsonCharacter(character)
    if (escaped !== undefined) {
      if (!writer.push(plain) || !writer.push(escaped)) return
      plain = ''
    } else {
      plain += character
      if (plain.length >= TEXT_CHUNK_CODE_UNITS) {
        if (!writer.push(plain)) return
        plain = ''
      }
    }
  }
  if (!writer.push(plain)) return
  writer.push('"')
}

function escapedJsonCharacter(character: string): string | undefined {
  switch (character) {
    case '"': return '\\"'
    case '\\': return '\\\\'
    case '\b': return '\\b'
    case '\f': return '\\f'
    case '\n': return '\\n'
    case '\r': return '\\r'
    case '\t': return '\\t'
    default: {
      const codePoint = character.charCodeAt(0)
      if (codePoint < 0x20 || (character.length === 1 && codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return `\\u${codePoint.toString(16).padStart(4, '0')}`
      }
      return undefined
    }
  }
}

function writeMimeValue(writer: NotebookTextWriter, value: NotebookMimeValue): void {
  switch (value.type) {
    case 'text':
      writer.push(value.text)
      break
    case 'json':
      writeJsonValue(writer, value.value)
      break
    case 'image': {
      writer.push('attachment ')
      writeJsonValue(writer, notebookImageAttachmentJson(value.attachment))
      break
    }
    case 'base64':
      writer.push(value.data)
      break
    default:
      assertNever(value)
  }
}

function writeMimeBundle(writer: NotebookTextWriter, bundle: NotebookMimeBundle): void {
  let count = 0
  for (const mimeType in bundle) {
    if (!Object.hasOwn(bundle, mimeType) || writer.full) continue
    count += 1
    writer.push('\n[mime ')
    writeJsonString(writer, mimeType)
    writer.push(']\n')
    const value = bundle[mimeType]
    if (value !== undefined) writeMimeValue(writer, value)
  }
  if (count === 0) writer.push('\n[empty MIME bundle]')
}

function writeMetadata(writer: NotebookTextWriter, metadata: NotebookJsonValue): void {
  writer.push('\nmetadata=')
  writeJsonValue(writer, metadata)
}

function writeOutput(writer: NotebookTextWriter, output: NotebookOutput): void {
  switch (output.type) {
    case 'stream':
      writer.push(`\n[stream ${output.name}]\n`)
      writer.push(output.text)
      break
    case 'display':
      writer.push('\n[display')
      if (output.displayId !== undefined) {
        writer.push(' id=')
        writeJsonString(writer, output.displayId)
      }
      writer.push(']')
      writeMimeBundle(writer, output.data)
      writeMetadata(writer, output.metadata)
      break
    case 'execute-result':
      writer.push(`\n[execute-result count=${String(output.executionCount)}`)
      if (output.displayId !== undefined) {
        writer.push(' id=')
        writeJsonString(writer, output.displayId)
      }
      writer.push(']')
      writeMimeBundle(writer, output.data)
      writeMetadata(writer, output.metadata)
      break
    case 'error':
      writer.push('\n[error ')
      writeJsonString(writer, output.name)
      writer.push(']\n')
      writer.push(output.value)
      for (const line of output.traceback) {
        if (!writer.push('\n')) break
        if (!writer.push(line)) break
      }
      break
    default:
      assertNever(output)
  }
}

function writeAttachments(writer: NotebookTextWriter, attachments: NotebookCellAttachments): void {
  for (const name in attachments) {
    if (!Object.hasOwn(attachments, name) || writer.full) continue
    writer.push('\nattachment ')
    writeJsonString(writer, name)
    const bundle = attachments[name]
    if (bundle !== undefined) writeMimeBundle(writer, bundle)
  }
}

function writeOutputs(writer: NotebookTextWriter, outputs: readonly NotebookOutput[]): void {
  if (outputs.length === 0) {
    writer.push('\n[no output]')
    return
  }
  for (const output of outputs) {
    if (writer.full) return
    writeOutput(writer, output)
  }
}

/**
 * Bound one complete model-facing notebook string without splitting UTF-8.
 * @param text - complete text before retention.
 * @param maxBytes - non-negative inclusive UTF-8 byte cap.
 * @returns retained text with a truncation marker when the marker fits.
 */
export function boundNotebookText(text: string, maxBytes: number): string {
  const writer = new NotebookTextWriter(maxBytes)
  writer.push(text)
  return writer.finish()
}

/**
 * Render one JSON-safe notebook acknowledgement without first serializing it in full.
 * @param value - JSON value returned by a notebook operation.
 * @param maxBytes - complete UTF-8 byte cap.
 * @returns bounded JSON prefix with a truncation marker when needed.
 */
export function renderNotebookJson(value: NotebookJsonValue, maxBytes: number): string {
  const writer = new NotebookTextWriter(maxBytes)
  writeJsonValue(writer, value)
  return writer.finish()
}

/**
 * Render one folded notebook under the complete-result byte cap.
 * @param document - folded notebook document.
 * @param maxBytes - complete UTF-8 byte cap.
 * @returns bounded model-facing document text.
 */
export function renderNotebookDocument(document: NotebookDocument, maxBytes: number): string {
  const writer = new NotebookTextWriter(maxBytes)
  writer.push('notebook id=')
  writeJsonString(writer, document.id)
  writer.push(' path=')
  writeJsonString(writer, document.path)
  const kernel = document.kernel
  if (kernel === undefined) {
    writer.push(' environment=detached')
  } else {
    writer.push(' environment=')
    writeJsonString(writer, kernel.environmentId)
    writer.push(' backend=')
    writeJsonString(writer, kernel.backend)
    if (kernel.kernelName !== undefined) {
      writer.push(' kernelName=')
      writeJsonString(writer, kernel.kernelName)
    }
    writer.push(` generation=${String(kernel.generation)}`)
  }
  writer.push(` nbformat=4.${String(document.nbformatMinor)}`)
  for (let index = 0; index < document.cells.length && !writer.full; index += 1) {
    const cell = document.cells[index]
    if (cell === undefined) continue
    writer.push(`\n\n#${String(index)} ${cell.cellType} id=`)
    writeJsonString(writer, cell.id)
    if (cell.status !== undefined) writer.push(` status=${cell.status}`)
    if (cell.executionCount !== undefined) writer.push(` executionCount=${String(cell.executionCount)}`)
    writer.push('\nsource:\n')
    writer.push(cell.source)
    writeMetadata(writer, cell.metadata)
    writeAttachments(writer, cell.attachments)
    writer.push('\noutputs:')
    writeOutputs(writer, cell.outputs)
  }
  if (!writer.full) {
    writer.push('\n\ndocument')
    writeMetadata(writer, document.metadata)
  }
  return writer.finish()
}

/**
 * Render one terminal execution outcome under the complete-result byte cap.
 * @param result - terminal notebook execution outcome.
 * @param maxBytes - complete UTF-8 byte cap.
 * @returns bounded status, execution count, error, and structured output summary.
 */
export function renderNotebookExecution(
  result: Pick<NotebookExecuteResult, 'status' | 'outputs' | 'error' | 'executionCount'>,
  maxBytes: number,
): string {
  const writer = new NotebookTextWriter(maxBytes)
  switch (result.status) {
    case 'ok':
      writer.push('Notebook cell completed successfully.')
      break
    case 'error':
      writer.push('Notebook cell failed.')
      break
    case 'cancelled':
      writer.push('Notebook cell was cancelled.')
      break
    default:
      assertNever(result.status)
  }
  writer.push(` executionCount=${String(result.executionCount)}`)
  if (result.error !== undefined) {
    writer.push('\nerror: ')
    writer.push(result.error)
  }
  writer.push('\noutputs:')
  writeOutputs(writer, result.outputs)
  return writer.finish()
}

function assertNever(value: never): never {
  throw new Error(`unknown notebook rendering value ${JSON.stringify(value)}`)
}
