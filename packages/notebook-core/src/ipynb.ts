/**
 * Strict nbformat-v4 parsing and loss-preserving notebook mutations.
 * @module @younthing/dsh-notebook-core/ipynb
 */

import { createHash } from 'node:crypto'
import { CellId } from './brand.ts'
import type {
  NotebookKernelCellAttachments,
  NotebookKernelMimeBundle,
  NotebookKernelOutput,
  NotebookKernelOutputMutation,
} from './kernel-output-types.ts'
import type { NotebookExecutionStatus } from './types.ts'

/** JSON value retained from an `.ipynb` file. */
export type IpynbJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly IpynbJsonValue[]
  | IpynbJsonObject

/** JSON object retained from an `.ipynb` file. */
export interface IpynbJsonObject {
  readonly [key: string]: IpynbJsonValue
}

/** Cell kinds defined by nbformat v4. */
export type IpynbCellType = 'code' | 'markdown' | 'raw'

/** One normalized cell plus the fields needed for loss-preserving writes. */
export interface IpynbCell {
  /** Stable nbformat cell id, generated deterministically only for pre-4.5 files. */
  readonly id: CellId
  /** Native nbformat cell kind. */
  readonly cellType: IpynbCellType
  /** Joined source text. */
  readonly source: string
  /** Cell metadata retained without interpretation. */
  readonly metadata: IpynbJsonObject
  /** Markdown attachment bundles before durable raster admission. */
  readonly attachments: NotebookKernelCellAttachments
  /** Code-cell execution count; null means never executed. */
  readonly executionCount: number | null
  /** Standard nbformat outputs before durable raster admission. */
  readonly outputs: readonly NotebookKernelOutput[]
  /** Original or newly encoded nbformat output records. */
  readonly rawOutputs: readonly IpynbJsonObject[]
  /** Original cell object, including extension fields and attachments. */
  readonly raw: IpynbJsonObject
}

/** Parsed nbformat-v4 document with extension fields retained. */
export interface IpynbDocument {
  /** Original format minor version. Serialization upgrades it to at least 4.5 for cell ids. */
  readonly nbformatMinor: number
  /** Notebook metadata retained without interpretation. */
  readonly metadata: IpynbJsonObject
  /** Ordered normalized cells. */
  readonly cells: readonly IpynbCell[]
  /** Original top-level object, including extension fields. */
  readonly raw: IpynbJsonObject
}

/** Inputs for one newly inserted cell. */
export interface IpynbInsertCell {
  /** Unique nbformat cell id. */
  readonly id: CellId
  /** Native nbformat cell kind. */
  readonly cellType: IpynbCellType
  /** Initial source. */
  readonly source?: string
  /** Optional metadata; defaults to an empty object. */
  readonly metadata?: IpynbJsonObject
}

/** Completed execution persisted into one code cell. */
export interface IpynbExecution {
  /** Non-negative execution counter, or null when no terminal kernel reply arrived. */
  readonly executionCount: number | null
  /** Ordered output mutations returned by the kernel. */
  readonly mutations: readonly NotebookKernelOutputMutation[]
  /** Terminal execution status. */
  readonly status: NotebookExecutionStatus
  /** Required terminal error text for an error or cancelled status. */
  readonly error?: string
}

/** Invalid or unsupported nbformat input. */
export class IpynbFormatError extends Error {
  /**
   * @param message - precise invalid field or unsupported feature.
   * @param options - optional original JSON parse error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IpynbFormatError'
  }
}

const CELL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Parse and validate one complete nbformat-v4 document.
 * @param text - bounded UTF-8 file text supplied by the filesystem service.
 * @returns normalized cells plus original JSON fields for later writes.
 */
export function parseIpynb(text: string): IpynbDocument {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new IpynbFormatError('notebook is not valid JSON', { cause: error })
  }
  const raw = objectAt(value, '$')
  if (raw['nbformat'] !== 4) {
    throw new IpynbFormatError('$.nbformat must equal 4')
  }
  const nbformatMinor = nonNegativeInteger(raw['nbformat_minor'], '$.nbformat_minor')
  const metadata = objectAt(raw['metadata'], '$.metadata')
  const rawCells = arrayAt(raw['cells'], '$.cells')
  const seenIds = new Set<string>()
  const cells = rawCells.map((entry, index) => parseCell(entry, index, nbformatMinor, seenIds))
  return { nbformatMinor, metadata, cells, raw }
}

/**
 * Construct a new nbformat-4.5 notebook containing one empty code cell.
 * @param cellId - unique id minted by the notebook service.
 * @returns new in-memory document ready for guarded creation.
 */
export function createIpynb(cellId: CellId): IpynbDocument {
  validateCellId(cellId, '$.cells[0].id')
  const metadata: IpynbJsonObject = {}
  const cell = createCell({ id: cellId, cellType: 'code', source: '', metadata })
  const raw: IpynbJsonObject = {
    cells: [cell.raw],
    metadata,
    nbformat: 4,
    nbformat_minor: 5,
  }
  return { nbformatMinor: 5, metadata, cells: [cell], raw }
}

/**
 * Replace one cell source without discarding outputs, metadata, or extension fields.
 * @param document - parsed notebook document.
 * @param cellId - target cell id.
 * @param source - complete replacement source.
 * @returns immutable replacement document.
 */
export function replaceIpynbCellSource(
  document: IpynbDocument,
  cellId: CellId,
  source: string,
): IpynbDocument {
  const index = cellIndex(document, cellId)
  const current = document.cells[index] as IpynbCell
  const replacement: IpynbCell = {
    ...current,
    source,
    raw: { ...current.raw, source },
  }
  return replaceCell(document, index, replacement)
}

/**
 * Replace the notebook kernelspec name while retaining other metadata fields.
 * @param document - parsed notebook document.
 * @param kernelName - non-empty kernelspec name selected for future opens.
 * @returns immutable replacement document.
 */
export function replaceIpynbKernelName(document: IpynbDocument, kernelName: string): IpynbDocument {
  if (kernelName.length === 0) throw new IpynbFormatError('kernelName must be non-empty')
  const existing = document.metadata['kernelspec']
  const kernelspec = existing === undefined
    ? {}
    : objectAt(existing, '$.metadata.kernelspec')
  const metadata: IpynbJsonObject = {
    ...document.metadata,
    kernelspec: { ...kernelspec, name: kernelName },
  }
  return { ...document, metadata }
}

/**
 * Insert one cell at a native notebook index.
 * @param document - parsed notebook document.
 * @param index - zero-based index among all code, markdown, and raw cells.
 * @param input - id, kind, source, and metadata.
 * @returns immutable replacement document.
 */
export function insertIpynbCell(
  document: IpynbDocument,
  index: number,
  input: IpynbInsertCell,
): IpynbDocument {
  if (!Number.isSafeInteger(index) || index < 0 || index > document.cells.length) {
    throw new IpynbFormatError(`cell insertion index ${String(index)} is out of range`)
  }
  validateCellId(input.id, 'inserted cell id')
  if (document.cells.some(cell => cell.id === input.id)) {
    throw new IpynbFormatError(`cell id ${JSON.stringify(input.id)} is already present`)
  }
  const cell = createCell({
    id: input.id,
    cellType: input.cellType,
    source: input.source ?? '',
    metadata: input.metadata ?? {},
  })
  const cells = [...document.cells]
  cells.splice(index, 0, cell)
  return { ...document, cells }
}

/**
 * Replace one code cell's execution count and outputs.
 * @param document - parsed notebook document.
 * @param cellId - target code-cell id.
 * @param execution - completed execution to persist.
 * @returns immutable replacement document.
 */
export function replaceIpynbCellExecution(
  document: IpynbDocument,
  cellId: CellId,
  execution: IpynbExecution,
): IpynbDocument {
  const index = cellIndex(document, cellId)
  const current = document.cells[index] as IpynbCell
  if (current.cellType !== 'code') {
    throw new IpynbFormatError(`cell ${JSON.stringify(cellId)} is not a code cell`)
  }
  if (
    execution.executionCount !== null
    && (!Number.isSafeInteger(execution.executionCount) || execution.executionCount < 0)
  ) {
    throw new IpynbFormatError('executionCount must be a non-negative safe integer')
  }
  if (execution.status !== 'ok' && (execution.error === undefined || execution.error.length === 0)) {
    throw new IpynbFormatError('a failed execution requires non-empty error text')
  }
  if (execution.status === 'ok' && execution.error !== undefined) {
    throw new IpynbFormatError('a successful execution cannot carry error text')
  }
  const cells: IpynbCell[] = document.cells.map(cell => ({
    ...cell,
    outputs: [...cell.outputs],
    rawOutputs: [...cell.rawOutputs],
  }))
  const target = cells[index] as IpynbCell
  let outputs: NotebookKernelOutput[] = []
  let rawOutputs: IpynbJsonObject[] = []
  let pendingClear = false
  for (const mutation of execution.mutations) {
    switch (mutation.operation) {
      case 'append':
        if (pendingClear) {
          outputs = []
          rawOutputs = []
          pendingClear = false
        }
        outputs.push(mutation.output)
        rawOutputs.push(encodeOutput(mutation.output))
        break
      case 'clear':
        if (typeof mutation.wait !== 'boolean') throw new IpynbFormatError('clear_output wait must be boolean')
        if (mutation.wait) pendingClear = true
        else {
          outputs = []
          rawOutputs = []
          pendingClear = false
        }
        break
      case 'update-display': {
        if (mutation.displayId.length === 0) throw new IpynbFormatError('display update id must be non-empty')
        if (pendingClear) {
          outputs = []
          rawOutputs = []
          pendingClear = false
        }
        const update = (output: NotebookKernelOutput): NotebookKernelOutput => {
          if (
            (output.type !== 'display' && output.type !== 'execute-result')
            || output.displayId !== mutation.displayId
          ) return output
          return { ...output, data: mutation.data, metadata: mutation.metadata }
        }
        outputs = outputs.map(update)
        rawOutputs = rawOutputs.map(raw => updateRawDisplay(raw, mutation))
        for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
          if (cellIndex === index) continue
          const cell = cells[cellIndex]
          if (cell === undefined) continue
          cells[cellIndex] = {
            ...cell,
            outputs: cell.outputs.map(update),
            rawOutputs: cell.rawOutputs.map(raw => updateRawDisplay(raw, mutation)),
          }
        }
        break
      }
      default:
        assertNever(mutation)
    }
  }
  if (execution.status !== 'ok' && !outputs.some(output => output.type === 'error')) {
    const output = errorOutput(execution.error as string)
    outputs.push(output)
    rawOutputs.push(encodeOutput(output))
  }
  const replacement: IpynbCell = {
    ...target,
    executionCount: execution.executionCount ?? target.executionCount,
    outputs,
    rawOutputs,
    raw: {
      ...target.raw,
      execution_count: execution.executionCount ?? target.executionCount,
      outputs: rawOutputs,
    },
  }
  cells[index] = replacement
  return { ...document, cells }
}

/**
 * Serialize a document as canonical, newline-terminated nbformat JSON.
 * @param document - document returned by this module's constructors or mutations.
 * @returns complete `.ipynb` file text.
 */
export function serializeIpynb(document: IpynbDocument): string {
  const raw: IpynbJsonObject = {
    ...document.raw,
    cells: document.cells.map(cellToRaw),
    metadata: document.metadata,
    nbformat: 4,
    nbformat_minor: Math.max(5, document.nbformatMinor),
  }
  return `${JSON.stringify(raw, undefined, 2)}\n`
}

function parseCell(
  value: IpynbJsonValue,
  index: number,
  nbformatMinor: number,
  seenIds: Set<string>,
): IpynbCell {
  const path = `$.cells[${index}]`
  const raw = objectAt(value, path)
  const cellType = raw['cell_type']
  if (cellType !== 'code' && cellType !== 'markdown' && cellType !== 'raw') {
    throw new IpynbFormatError(`${path}.cell_type is unsupported: ${JSON.stringify(cellType)}`)
  }
  const source = multilineAt(raw['source'], `${path}.source`)
  const metadata = objectAt(raw['metadata'], `${path}.metadata`)
  const idValue = raw['id']
  let id: CellId
  if (idValue === undefined) {
    if (nbformatMinor >= 5) throw new IpynbFormatError(`${path}.id is required by nbformat 4.${nbformatMinor}`)
    id = legacyCellId(index, cellType, source, seenIds)
  } else {
    if (typeof idValue !== 'string') throw new IpynbFormatError(`${path}.id must be a string`)
    validateCellId(idValue, `${path}.id`)
    id = CellId(idValue)
  }
  if (seenIds.has(id)) throw new IpynbFormatError(`duplicate notebook cell id ${JSON.stringify(id)}`)
  seenIds.add(id)

  const parsedAttachments = raw['attachments'] === undefined
    ? {}
    : parseAttachments(raw['attachments'], `${path}.attachments`)
  const attachments = cellType === 'markdown' ? parsedAttachments : {}

  if (cellType !== 'code') {
    return {
      id,
      cellType,
      source,
      metadata,
      attachments,
      executionCount: null,
      outputs: [],
      rawOutputs: [],
      raw,
    }
  }

  const executionValue = raw['execution_count']
  const executionCount = executionValue === null
    ? null
    : nonNegativeInteger(executionValue, `${path}.execution_count`)
  const outputValues = arrayAt(raw['outputs'], `${path}.outputs`)
  const rawOutputs: IpynbJsonObject[] = []
  const outputs: NotebookKernelOutput[] = []
  for (const [outputIndex, outputValue] of outputValues.entries()) {
    const parsed = parseOutput(outputValue, `${path}.outputs[${outputIndex}]`)
    rawOutputs.push(parsed.raw)
    outputs.push(...parsed.outputs)
  }
  return {
    id,
    cellType,
    source,
    metadata,
    attachments,
    executionCount,
    outputs,
    rawOutputs,
    raw,
  }
}

function parseOutput(
  value: IpynbJsonValue,
  path: string,
): { readonly raw: IpynbJsonObject; readonly outputs: readonly NotebookKernelOutput[] } {
  const raw = objectAt(value, path)
  const outputType = raw['output_type']
  if (typeof outputType !== 'string' || outputType.length === 0) {
    throw new IpynbFormatError(`${path}.output_type must be a non-empty string`)
  }
  switch (outputType) {
    case 'stream': {
      if (raw['name'] !== 'stdout' && raw['name'] !== 'stderr') {
        throw new IpynbFormatError(`${path}.name must be "stdout" or "stderr"`)
      }
      return {
        raw,
        outputs: [{ type: 'stream', name: raw['name'], text: multilineAt(raw['text'], `${path}.text`) }],
      }
    }
    case 'display_data': {
      const metadata = objectAt(raw['metadata'], `${path}.metadata`)
      const displayId = parseDisplayId(raw['transient'], `${path}.transient`)
      return {
        raw,
        outputs: [{
          type: 'display',
          data: parseMimeBundle(raw['data'], `${path}.data`),
          metadata,
          ...(displayId === undefined ? {} : { displayId }),
        }],
      }
    }
    case 'execute_result': {
      const executionCount = nullableNonNegativeInteger(raw['execution_count'], `${path}.execution_count`)
      const metadata = objectAt(raw['metadata'], `${path}.metadata`)
      const displayId = parseDisplayId(raw['transient'], `${path}.transient`)
      return {
        raw,
        outputs: [{
          type: 'execute-result',
          data: parseMimeBundle(raw['data'], `${path}.data`),
          metadata,
          executionCount,
          ...(displayId === undefined ? {} : { displayId }),
        }],
      }
    }
    case 'error': {
      const ename = stringAt(raw['ename'], `${path}.ename`)
      const evalue = stringAt(raw['evalue'], `${path}.evalue`)
      const traceback = arrayAt(raw['traceback'], `${path}.traceback`).map((line, lineIndex) =>
        stringAt(line, `${path}.traceback[${lineIndex}]`))
      return { raw, outputs: [{ type: 'error', name: ename, value: evalue, traceback }] }
    }
    default:
      // Forward-compatible output records remain in rawOutputs and are not
      // reinterpreted as a standard nbformat record.
      return { raw, outputs: [] }
  }
}

function parseMimeBundle(value: IpynbJsonValue | undefined, path: string): NotebookKernelMimeBundle {
  const bundle = objectAt(value, path)
  const parsed: Array<[string, NotebookKernelMimeBundle[string]]> = []
  for (const [mimeType, payload] of Object.entries(bundle)) {
    const payloadPath = `${path}[${JSON.stringify(mimeType)}]`
    validateMimePayload(mimeType, payload, payloadPath)
    if (isJsonMime(mimeType)) {
      parsed.push([mimeType, { type: 'json', value: payload }])
    } else if (isBinaryMime(mimeType)) {
      parsed.push([mimeType, { type: 'base64', data: multilineValue(payload, payloadPath) }])
    } else {
      parsed.push([mimeType, { type: 'text', text: multilineValue(payload, payloadPath) }])
    }
  }
  return Object.fromEntries(parsed)
}

function parseAttachments(value: IpynbJsonValue, path: string): NotebookKernelCellAttachments {
  const attachments = objectAt(value, path)
  const parsed: Array<[string, NotebookKernelMimeBundle]> = []
  for (const [name, bundleValue] of Object.entries(attachments)) {
    if (name.length === 0) throw new IpynbFormatError(`${path} contains an empty attachment name`)
    const bundlePath = `${path}[${JSON.stringify(name)}]`
    parsed.push([name, parseMimeBundle(bundleValue, bundlePath)])
  }
  return Object.fromEntries(parsed)
}

function validateMimePayload(mimeType: string, value: IpynbJsonValue | undefined, path: string): void {
  if (mimeType.length === 0) throw new IpynbFormatError(`${path} has an empty MIME type`)
  if (value === undefined) throw new IpynbFormatError(`${path} is missing a MIME payload`)
  if (isJsonMime(mimeType)) return
  if (typeof value === 'string') return
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return
  throw new IpynbFormatError(`${path} must be a string or string array`)
}

function multilineValue(value: IpynbJsonValue, path: string): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) return value.join('')
  throw new IpynbFormatError(`${path} must be a string or string array`)
}

function isJsonMime(mimeType: string): boolean {
  return mimeType === 'application/json' || mimeType.endsWith('+json')
}

function isBinaryMime(mimeType: string): boolean {
  return mimeType === 'image/png'
    || mimeType === 'image/jpeg'
    || mimeType === 'image/webp'
    || mimeType === 'image/gif'
    || mimeType === 'application/pdf'
}

function parseDisplayId(value: IpynbJsonValue | undefined, path: string): string | undefined {
  if (value === undefined) return undefined
  const transient = objectAt(value, path)
  const displayId = transient['display_id']
  if (displayId === undefined) return undefined
  if (typeof displayId !== 'string' || displayId.length === 0) {
    throw new IpynbFormatError(`${path}.display_id must be a non-empty string`)
  }
  return displayId
}

function encodeOutput(output: NotebookKernelOutput): IpynbJsonObject {
  switch (output.type) {
    case 'stream':
      return { name: output.name, output_type: 'stream', text: output.text }
    case 'display':
      return {
        data: encodeMimeBundle(output.data),
        metadata: output.metadata,
        output_type: 'display_data',
        ...(output.displayId === undefined ? {} : { transient: { display_id: output.displayId } }),
      }
    case 'execute-result':
      return {
        data: encodeMimeBundle(output.data),
        execution_count: output.executionCount,
        metadata: output.metadata,
        output_type: 'execute_result',
        ...(output.displayId === undefined ? {} : { transient: { display_id: output.displayId } }),
      }
    case 'error':
      return {
        ename: output.name,
        evalue: output.value,
        output_type: 'error',
        traceback: [...output.traceback],
      }
    default:
      return assertNever(output)
  }
}

function encodeMimeBundle(bundle: NotebookKernelMimeBundle): IpynbJsonObject {
  const raw: Array<[string, IpynbJsonValue]> = []
  for (const [mimeType, value] of Object.entries(bundle)) {
    if (mimeType.length === 0) throw new IpynbFormatError('notebook output MIME type must be non-empty')
    switch (value.type) {
      case 'text':
        raw.push([mimeType, value.text])
        break
      case 'json':
        raw.push([mimeType, value.value])
        break
      case 'base64':
        raw.push([mimeType, value.data])
        break
      default:
        assertNever(value)
    }
  }
  return Object.fromEntries(raw)
}

function updateRawDisplay(
  raw: IpynbJsonObject,
  mutation: Extract<NotebookKernelOutputMutation, { readonly operation: 'update-display' }>,
): IpynbJsonObject {
  if (raw['output_type'] !== 'display_data' && raw['output_type'] !== 'execute_result') return raw
  const transient = raw['transient']
  if (transient === undefined) return raw
  const transientObject = objectAt(transient, 'notebook output transient')
  if (transientObject['display_id'] !== mutation.displayId) return raw
  return { ...raw, data: encodeMimeBundle(mutation.data), metadata: mutation.metadata }
}

function errorOutput(error: string): NotebookKernelOutput {
  const separator = error.indexOf(':')
  const candidate = separator > 0 ? error.slice(0, separator).trim() : ''
  const ename = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(candidate) ? candidate : 'Error'
  const evalue = ename === 'Error' ? error : error.slice(separator + 1).trim()
  return { type: 'error', name: ename, value: evalue, traceback: [] }
}

function createCell(input: Required<IpynbInsertCell>): IpynbCell {
  const raw: IpynbJsonObject = {
    cell_type: input.cellType,
    id: input.id,
    metadata: input.metadata,
    source: input.source,
    ...(input.cellType === 'code' ? { execution_count: null, outputs: [] } : {}),
  }
  return {
    id: input.id,
    cellType: input.cellType,
    source: input.source,
    metadata: input.metadata,
    attachments: {},
    executionCount: null,
    outputs: [],
    rawOutputs: [],
    raw,
  }
}

function cellToRaw(cell: IpynbCell): IpynbJsonObject {
  return {
    ...cell.raw,
    cell_type: cell.cellType,
    id: cell.id,
    metadata: cell.metadata,
    source: cell.source,
    ...(cell.cellType === 'code'
      ? { execution_count: cell.executionCount, outputs: cell.rawOutputs }
      : {}),
  }
}

function replaceCell(document: IpynbDocument, index: number, replacement: IpynbCell): IpynbDocument {
  const cells = [...document.cells]
  cells[index] = replacement
  return { ...document, cells }
}

function cellIndex(document: IpynbDocument, cellId: CellId): number {
  const index = document.cells.findIndex(cell => cell.id === cellId)
  if (index === -1) throw new IpynbFormatError(`unknown notebook cell ${JSON.stringify(cellId)}`)
  return index
}

function legacyCellId(
  index: number,
  cellType: IpynbCellType,
  source: string,
  seenIds: ReadonlySet<string>,
): CellId {
  for (let attempt = 0; ; attempt++) {
    const digest = createHash('sha256')
      .update(`${String(index)}\0${cellType}\0${source}\0${String(attempt)}`)
      .digest('hex')
      .slice(0, 32)
    const candidate = `dsh-${index.toString(36)}-${digest}`
    if (!seenIds.has(candidate)) return CellId(candidate)
  }
}

function validateCellId(value: string, path: string): void {
  if (!CELL_ID_PATTERN.test(value)) {
    throw new IpynbFormatError(`${path} must contain 1-64 ASCII letters, digits, hyphens, or underscores`)
  }
}

function objectAt(value: unknown, path: string): IpynbJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IpynbFormatError(`${path} must be an object`)
  }
  return value as IpynbJsonObject
}

function arrayAt(value: unknown, path: string): readonly IpynbJsonValue[] {
  if (!Array.isArray(value)) throw new IpynbFormatError(`${path} must be an array`)
  return value as readonly IpynbJsonValue[]
}

function stringAt(value: IpynbJsonValue | undefined, path: string): string {
  if (typeof value !== 'string') throw new IpynbFormatError(`${path} must be a string`)
  return value
}

function multilineAt(value: IpynbJsonValue | undefined, path: string): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(part => typeof part === 'string')) {
    return value.join('')
  }
  throw new IpynbFormatError(`${path} must be a string or string array`)
}

function nonNegativeInteger(value: IpynbJsonValue | undefined, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new IpynbFormatError(`${path} must be a non-negative safe integer`)
  }
  return value
}

function nullableNonNegativeInteger(value: IpynbJsonValue | undefined, path: string): number | null {
  return value === null ? null : nonNegativeInteger(value, path)
}

function assertNever(value: never): never {
  throw new IpynbFormatError(`unsupported notebook output value ${JSON.stringify(value)}`)
}
