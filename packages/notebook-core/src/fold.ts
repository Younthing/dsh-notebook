/**
 * Pure fold over durable notebook session events.
 * @module @younthing/dsh-notebook-core/fold
 */

import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AttachmentId, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { CellId, ExecutionId, NotebookId } from './brand.ts'
import type {
  FoldedNotebooks,
  NotebookCell,
  NotebookDocument,
  NotebookJsonValue,
  NotebookMimeBundle,
  NotebookOutput,
  NotebookOutputMutation,
} from './types.ts'

/** Thrown when a notebook event stream violates fold invariants. */
export class NotebookLogError extends Error {
  /** @param message - precise invalid transition or durable field. */
  constructor(message: string) {
    super(message)
    this.name = 'NotebookLogError'
  }
}

type MutableNotebook = {
  -readonly [Key in keyof Omit<NotebookDocument, 'cells'>]: Omit<NotebookDocument, 'cells'>[Key]
} & { cells: NotebookCell[] }

interface ActiveExecution {
  readonly notebookId: NotebookId
  readonly cellId: CellId
  readonly executionId: ExecutionId
  outputs: NotebookOutput[]
  pendingClear: boolean
}

/**
 * Fold notebook events after an optional fork seed boundary.
 * @param events - complete ordered session log or candidate-extended log.
 * @param seedLength - inherited prefix length excluded from child ownership.
 * @returns immutable notebook documents with live or terminal execution state.
 */
export function foldNotebooks(events: readonly SessionEvent[], seedLength = 0): FoldedNotebooks {
  if (!Number.isSafeInteger(seedLength) || seedLength < 0 || seedLength > events.length) {
    throw new NotebookLogError('notebook seedLength must be within the supplied event log')
  }
  const order: NotebookId[] = []
  const byId = new Map<NotebookId, MutableNotebook>()
  const activeById = new Map<ExecutionId, ActiveExecution>()
  const activeByNotebook = new Map<NotebookId, ExecutionId>()
  const seenExecutionIds = new Set<ExecutionId>()

  for (const event of events.slice(seedLength)) {
    switch (event.type) {
      case 'notebook/open': {
        const data = event.data
        assertNonEmpty('notebookId', data.notebookId)
        assertWorkspaceNotebookPath(data.path)
        assertNonEmpty('fileVersion', data.fileVersion)
        assertNonNegativeInteger('nbformatMinor', data.nbformatMinor)
        assertJsonObject('notebook metadata', data.metadata)
        if (byId.has(data.notebookId)) {
          throw new NotebookLogError(`notebook id ${JSON.stringify(data.notebookId)} was opened twice`)
        }
        order.push(data.notebookId)
        byId.set(data.notebookId, {
          id: data.notebookId,
          path: data.path,
          fileVersion: data.fileVersion,
          nbformatMinor: data.nbformatMinor,
          metadata: data.metadata,
          cells: [],
        })
        break
      }
      case 'notebook/cell': {
        const data = event.data
        const notebook = expectNotebook(byId, data.notebookId)
        assertNonEmpty('cellId', data.cellId)
        assertCellType(data.cellType)
        assertNonEmpty('fileVersion', data.fileVersion)
        if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index > notebook.cells.length) {
          throw new NotebookLogError(`notebook cell index ${String(data.index)} is out of range`)
        }
        switch (data.operation) {
          case 'create': {
            if (notebook.cells.some(cell => cell.id === data.cellId)) {
              throw new NotebookLogError(`notebook cell id ${JSON.stringify(data.cellId)} was reused`)
            }
            assertJsonObject('notebook cell metadata', data.metadata)
            const attachments = validateAttachments(data.cellType, data.attachments)
            notebook.cells.splice(data.index, 0, {
              id: data.cellId,
              cellType: data.cellType,
              source: data.source,
              metadata: data.metadata,
              attachments,
              outputs: validateImportedOutputs(data.cellType, data.outputs),
              ...validateImportedExecutionCount(data.cellType, data.executionCount),
            })
            break
          }
          case 'update': {
            const actualIndex = notebook.cells.findIndex(entry => entry.id === data.cellId)
            const cell = notebook.cells[actualIndex]
            if (cell === undefined) {
              throw new NotebookLogError(`notebook cell update targets unknown id ${JSON.stringify(data.cellId)}`)
            }
            if (actualIndex !== data.index) {
              throw new NotebookLogError(`notebook cell update index ${String(data.index)} does not match ${String(actualIndex)}`)
            }
            if (cell.cellType !== data.cellType) {
              throw new NotebookLogError('notebook cell update cannot change cellType')
            }
            if (
              data.executionCount !== undefined
              || data.outputs !== undefined
              || data.metadata !== undefined
              || data.attachments !== undefined
            ) {
              throw new NotebookLogError('notebook cell update cannot carry imported cell state')
            }
            cell.source = data.source
            break
          }
          case 'delete': {
            const target = notebook.cells[data.index]
            if (target === undefined || target.id !== data.cellId) {
              throw new NotebookLogError(`notebook cell delete index ${String(data.index)} does not reference ${JSON.stringify(data.cellId)}`)
            }
            notebook.cells.splice(data.index, 1)
            break
          }
          case 'move': {
            const fromIndex = data.fromIndex
            const toIndex = data.toIndex
            if (fromIndex === undefined || toIndex === undefined) {
              throw new NotebookLogError('notebook cell move must carry fromIndex and toIndex')
            }
            if (!Number.isSafeInteger(fromIndex) || fromIndex < 0 || fromIndex >= notebook.cells.length) {
              throw new NotebookLogError(`notebook cell move fromIndex ${String(fromIndex)} is out of range`)
            }
            if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= notebook.cells.length) {
              throw new NotebookLogError(`notebook cell move toIndex ${String(toIndex)} is out of range`)
            }
            const source = notebook.cells[fromIndex]
            if (source === undefined || source.id !== data.cellId) {
              throw new NotebookLogError(`notebook cell move fromIndex ${String(fromIndex)} does not reference ${JSON.stringify(data.cellId)}`)
            }
            notebook.cells.splice(fromIndex, 1)
            notebook.cells.splice(toIndex, 0, source)
            break
          }
          default:
            throw new NotebookLogError(`unknown notebook cell operation ${JSON.stringify(data.operation)}`)
        }
        notebook.fileVersion = data.fileVersion
        break
      }
      case 'notebook/execute': {
        const data = event.data
        assertNonEmpty('executionId', data.executionId)
        const initiator: unknown = data.initiator
        if (initiator !== 'agent' && initiator !== 'user') {
          throw new NotebookLogError(`unknown notebook execution initiator ${JSON.stringify(initiator)}`)
        }
        if (seenExecutionIds.has(data.executionId)) {
          throw new NotebookLogError(`notebook execution id ${JSON.stringify(data.executionId)} was reused`)
        }
        if (activeByNotebook.has(data.notebookId)) {
          throw new NotebookLogError(`notebook ${JSON.stringify(data.notebookId)} started concurrent executions`)
        }
        const cell = expectCell(byId, data.notebookId, data.cellId)
        if (cell.cellType !== 'code') throw new NotebookLogError('only a code cell can be executed')
        cell.outputs = []
        cell.status = 'running'
        delete cell.error
        const execution: ActiveExecution = {
          notebookId: data.notebookId,
          cellId: data.cellId,
          executionId: data.executionId,
          outputs: [],
          pendingClear: false,
        }
        seenExecutionIds.add(data.executionId)
        activeById.set(data.executionId, execution)
        activeByNotebook.set(data.notebookId, data.executionId)
        break
      }
      case 'notebook/output': {
        const data = event.data
        const execution = expectActiveExecution(activeById, data.notebookId, data.cellId, data.executionId)
        const notebook = expectNotebook(byId, data.notebookId)
        const mutation = validateOutputMutation(data.mutation)
        applyOutputMutation(notebook, execution, mutation)
        const cell = expectCell(byId, data.notebookId, data.cellId)
        cell.outputs = [...execution.outputs]
        break
      }
      case 'notebook/execute-end': {
        const data = event.data
        const execution = expectActiveExecution(activeById, data.notebookId, data.cellId, data.executionId)
        const notebook = expectNotebook(byId, data.notebookId)
        const cell = expectCell(byId, data.notebookId, data.cellId)
        const status: unknown = data.status
        if (status !== 'ok' && status !== 'error' && status !== 'cancelled') {
          throw new NotebookLogError(`unknown notebook execution status ${JSON.stringify(status)}`)
        }
        if (data.executionCount !== null) assertNonNegativeInteger('executionCount', data.executionCount)
        assertNonEmpty('fileVersion', data.fileVersion)
        const error: unknown = data.error
        cell.outputs = [...execution.outputs]
        cell.status = status
        if (data.executionCount !== null) cell.executionCount = data.executionCount
        if (status === 'ok') {
          if (error !== undefined) {
            throw new NotebookLogError('notebook execute-end ok status cannot carry error text')
          }
          delete cell.error
        } else {
          if (typeof error !== 'string' || error.length === 0) {
            throw new NotebookLogError('notebook failed execute-end requires non-empty error text')
          }
          cell.error = error
        }
        notebook.fileVersion = data.fileVersion
        activeById.delete(data.executionId)
        activeByNotebook.delete(data.notebookId)
        break
      }
      case 'notebook/kernel': {
        const data = event.data
        const notebook = expectNotebook(byId, data.notebookId)
        if (activeByNotebook.has(data.notebookId)) {
          throw new NotebookLogError('notebook kernel cannot change during an active execution')
        }
        const initiator: unknown = data.initiator
        if (initiator !== 'agent' && initiator !== 'user') {
          throw new NotebookLogError(`unknown notebook kernel initiator ${JSON.stringify(initiator)}`)
        }
        assertNonEmpty('environmentId', data.environmentId)
        assertNonEmpty('backend', data.backend)
        assertOptionalNonEmpty('kernelName', data.kernelName)
        assertNonEmpty('fileVersion', data.fileVersion)
        if (data.fileVersion !== notebook.fileVersion) {
          throw new NotebookLogError('notebook kernel must reference the current fileVersion')
        }
        const previousGeneration = notebook.kernel?.generation ?? 0
        if (data.generation !== previousGeneration + 1) {
          throw new NotebookLogError('notebook kernel generation must increase by exactly one')
        }
        notebook.kernel = {
          environmentId: data.environmentId,
          backend: data.backend,
          ...(data.kernelName === undefined ? {} : { kernelName: data.kernelName }),
          generation: data.generation,
        }
        break
      }
      case 'notebook/reload': {
        const data = event.data
        const notebook = expectNotebook(byId, data.notebookId)
        if (activeByNotebook.has(data.notebookId)) {
          throw new NotebookLogError('notebook cannot reload during an active execution')
        }
        const initiator: unknown = data.initiator
        if (initiator !== 'agent' && initiator !== 'user') {
          throw new NotebookLogError(`unknown notebook reload initiator ${JSON.stringify(initiator)}`)
        }
        assertNonEmpty('fileVersion', data.fileVersion)
        assertNonNegativeInteger('nbformatMinor', data.nbformatMinor)
        assertJsonObject('notebook metadata', data.metadata)
        const cellsValue: unknown = data.cells
        if (!Array.isArray(cellsValue)) throw new NotebookLogError('notebook reload cells must be an array')
        const seen = new Set<CellId>()
        const cells = (cellsValue as readonly unknown[]).map((cell) => {
          const parsed = validateCellSnapshot(cell)
          if (seen.has(parsed.id)) {
            throw new NotebookLogError(`notebook reload cell id ${JSON.stringify(parsed.id)} was reused`)
          }
          seen.add(parsed.id)
          return parsed
        })
        notebook.fileVersion = data.fileVersion
        notebook.nbformatMinor = data.nbformatMinor
        notebook.metadata = data.metadata
        notebook.cells = cells
        break
      }
      default:
        // SessionEventMap is merge-extensible; unrelated durable events are ignored.
        break
    }
  }

  return Object.freeze({
    notebooks: Object.freeze(order.map((notebookId) => {
      const notebook = byId.get(notebookId)
      if (notebook === undefined) throw new NotebookLogError('folded notebook is missing')
      return freezeNotebook(notebook)
    })),
  })
}

function applyOutputMutation(
  notebook: MutableNotebook,
  execution: ActiveExecution,
  mutation: NotebookOutputMutation,
): void {
  switch (mutation.operation) {
    case 'append':
      if (execution.pendingClear) {
        execution.outputs = []
        execution.pendingClear = false
      }
      execution.outputs.push(mutation.output)
      return
    case 'clear':
      if (mutation.wait) execution.pendingClear = true
      else {
        execution.outputs = []
        execution.pendingClear = false
      }
      return
    case 'update-display': {
      if (execution.pendingClear) {
        execution.outputs = []
        execution.pendingClear = false
      }
      const update = (output: NotebookOutput): NotebookOutput => {
        if (
          (output.type !== 'display' && output.type !== 'execute-result')
          || output.displayId !== mutation.displayId
        ) return output
        return { ...output, data: mutation.data, metadata: mutation.metadata }
      }
      execution.outputs = execution.outputs.map(update)
      for (const cell of notebook.cells) cell.outputs = cell.outputs.map(update)
      return
    }
    default:
      return assertNever(mutation)
  }
}

function validateOutputMutation(value: unknown): NotebookOutputMutation {
  const mutation = objectRecord(value, 'notebook output mutation must be an object')
  switch (mutation['operation']) {
    case 'append':
      return { operation: 'append', output: validateOutput(mutation['output']) }
    case 'clear':
      if (typeof mutation['wait'] !== 'boolean') {
        throw new NotebookLogError('notebook clear output wait must be boolean')
      }
      return { operation: 'clear', wait: mutation['wait'] }
    case 'update-display': {
      const displayId = mutation['displayId']
      const metadata = mutation['metadata']
      assertNonEmpty('displayId', displayId)
      assertJsonObject('display metadata', metadata)
      return {
        operation: 'update-display',
        displayId,
        data: validateBundle(mutation['data']),
        metadata,
      }
    }
    default:
      throw new NotebookLogError(`unsupported notebook output mutation ${JSON.stringify(mutation['operation'])}`)
  }
}

function validateOutput(value: unknown): NotebookOutput {
  const output = objectRecord(value, 'notebook output must be an object')
  switch (output['type']) {
    case 'stream': {
      const name = output['name']
      const text = output['text']
      if (name !== 'stdout' && name !== 'stderr') {
        throw new NotebookLogError('notebook stream name must be stdout or stderr')
      }
      if (typeof text !== 'string') throw new NotebookLogError('notebook stream text must be a string')
      return { type: 'stream', name, text }
    }
    case 'display': {
      const metadata = output['metadata']
      const displayId = output['displayId']
      assertJsonObject('display metadata', metadata)
      assertOptionalNonEmpty('displayId', displayId)
      return {
        type: 'display',
        data: validateBundle(output['data']),
        metadata,
        ...(displayId === undefined ? {} : { displayId }),
      }
    }
    case 'execute-result': {
      const metadata = output['metadata']
      const displayId = output['displayId']
      const executionCount = output['executionCount']
      assertJsonObject('execute-result metadata', metadata)
      assertOptionalNonEmpty('displayId', displayId)
      if (executionCount !== null) assertNonNegativeInteger('output executionCount', executionCount)
      return {
        type: 'execute-result',
        data: validateBundle(output['data']),
        metadata,
        executionCount,
        ...(displayId === undefined ? {} : { displayId }),
      }
    }
    case 'error': {
      const name = output['name']
      const errorValue = output['value']
      const traceback = output['traceback']
      assertNonEmpty('error name', name)
      if (typeof errorValue !== 'string') throw new NotebookLogError('notebook error value must be a string')
      if (!isStringArray(traceback)) {
        throw new NotebookLogError('notebook error traceback must be a string array')
      }
      return { type: 'error', name, value: errorValue, traceback: [...traceback] }
    }
    default:
      throw new NotebookLogError(`unsupported notebook output mutation ${JSON.stringify(output['type'])}`)
  }
}

function validateBundle(value: unknown): NotebookMimeBundle {
  const bundle = objectRecord(value, 'notebook MIME bundle must be an object')
  const result: Array<[string, NotebookMimeBundle[string]]> = []
  for (const [mimeType, value] of Object.entries(bundle)) {
    if (mimeType.length === 0) throw new NotebookLogError('notebook MIME type must be non-empty')
    const payload = objectRecord(
      value,
      `notebook MIME ${JSON.stringify(mimeType)} value must be an object`,
    )
    switch (payload['type']) {
      case 'text':
        if (typeof payload['text'] !== 'string') {
          throw new NotebookLogError('notebook text MIME value must be a string')
        }
        result.push([mimeType, { type: 'text', text: payload['text'] }])
        break
      case 'json':
        if (!isJsonValue(payload['value'])) throw new NotebookLogError('notebook JSON MIME value must be JSON')
        result.push([mimeType, { type: 'json', value: payload['value'] as NotebookJsonValue }])
        break
      case 'base64':
        if (typeof payload['data'] !== 'string' || !canonicalBase64(payload['data'])) {
          throw new NotebookLogError('notebook binary MIME value must be canonical base64')
        }
        result.push([mimeType, { type: 'base64', data: payload['data'] }])
        break
      case 'image': {
        const ref = objectRecord(payload['attachment'], 'notebook image reference must be an object')
        const attachmentId = ref['attachmentId']
        const mediaType = ref['mediaType']
        const bytes = ref['bytes']
        const width = ref['width']
        const height = ref['height']
        const name = ref['name']
        assertNonEmpty('attachmentId', attachmentId)
        assertImageMediaType(mediaType)
        assertNonNegativeInteger('attachment bytes', bytes)
        assertNonNegativeInteger('attachment width', width)
        assertNonNegativeInteger('attachment height', height)
        if (name !== undefined && typeof name !== 'string') {
          throw new NotebookLogError('notebook image attachment name must be a string')
        }
        result.push([mimeType, {
          type: 'image',
          attachment: {
            attachmentId: attachmentId as AttachmentId,
            mediaType,
            bytes,
            width,
            height,
            ...(name === undefined ? {} : { name }),
          },
        }])
        break
      }
      default:
        throw new NotebookLogError(`unsupported notebook MIME value ${JSON.stringify(payload['type'])}`)
    }
  }
  return Object.fromEntries(result)
}

function validateImportedOutputs(
  cellType: 'code' | 'markdown' | 'raw',
  outputs: unknown,
): readonly NotebookOutput[] {
  if (outputs === undefined) return []
  if (cellType !== 'code') throw new NotebookLogError('only a code cell can carry imported outputs')
  if (!Array.isArray(outputs)) throw new NotebookLogError('notebook imported outputs must be an array')
  return (outputs as readonly unknown[]).map(validateOutput)
}

function validateImportedExecutionCount(
  cellType: 'code' | 'markdown' | 'raw',
  executionCount: unknown,
): { executionCount?: number } {
  if (executionCount === undefined) return {}
  if (cellType !== 'code') throw new NotebookLogError('only a code cell can carry an imported execution count')
  assertNonNegativeInteger('imported executionCount', executionCount)
  return { executionCount }
}

function validateAttachments(
  cellType: 'code' | 'markdown' | 'raw',
  attachments: unknown,
): NotebookCell['attachments'] {
  if (attachments === undefined) return {}
  const record = objectRecord(attachments, 'notebook cell attachments must be an object')
  if (cellType !== 'markdown' && Object.keys(record).length > 0) {
    throw new NotebookLogError('only a markdown cell can carry attachments')
  }
  const result: Array<[string, NotebookMimeBundle]> = []
  for (const [name, bundle] of Object.entries(record)) {
    if (name.length === 0) throw new NotebookLogError('notebook attachment name must be non-empty')
    result.push([name, validateBundle(bundle)])
  }
  return Object.fromEntries(result)
}

function validateCellSnapshot(value: unknown): NotebookCell {
  if (value === null || typeof value !== 'object') {
    throw new NotebookLogError('notebook reload cell must be an object')
  }
  const record = value as Record<string, unknown>
  const id = record['id']
  const cellType = record['cellType']
  const source = record['source']
  const metadata = record['metadata']
  assertNonEmpty('cellId', id)
  assertCellType(cellType)
  if (typeof source !== 'string') throw new NotebookLogError('notebook reload cell source must be a string')
  assertJsonObject('notebook cell metadata', metadata)
  return {
    id: id as CellId,
    cellType,
    source,
    metadata,
    attachments: validateAttachments(cellType, record['attachments']),
    outputs: validateSnapshotOutputs(cellType, record['outputs']),
    ...validateImportedExecutionCount(cellType, record['executionCount']),
  }
}

function validateSnapshotOutputs(
  cellType: 'code' | 'markdown' | 'raw',
  outputs: unknown,
): readonly NotebookOutput[] {
  if (!Array.isArray(outputs)) throw new NotebookLogError('notebook reload outputs must be an array')
  if (cellType !== 'code') {
    if (outputs.length > 0) throw new NotebookLogError('only a code cell can carry imported outputs')
    return []
  }
  return (outputs as readonly unknown[]).map(validateOutput)
}

function expectNotebook(byId: Map<NotebookId, MutableNotebook>, notebookId: NotebookId): MutableNotebook {
  assertNonEmpty('notebookId', notebookId)
  const notebook = byId.get(notebookId)
  if (notebook === undefined) throw new NotebookLogError(`notebook event targets unknown id ${JSON.stringify(notebookId)}`)
  return notebook
}

function expectCell(
  byId: Map<NotebookId, MutableNotebook>,
  notebookId: NotebookId,
  cellId: CellId,
): NotebookCell {
  const notebook = expectNotebook(byId, notebookId)
  const cell = notebook.cells.find(entry => entry.id === cellId)
  if (cell === undefined) throw new NotebookLogError(`notebook event targets unknown cell ${JSON.stringify(cellId)}`)
  return cell
}

function expectActiveExecution(
  activeById: Map<ExecutionId, ActiveExecution>,
  notebookId: NotebookId,
  cellId: CellId,
  executionId: ExecutionId,
): ActiveExecution {
  const active = activeById.get(executionId)
  if (active === undefined) {
    throw new NotebookLogError(`notebook output targets execution ${JSON.stringify(executionId)} without execute`)
  }
  if (active.notebookId !== notebookId || active.cellId !== cellId) {
    throw new NotebookLogError('notebook output targets a different active execution')
  }
  return active
}

function freezeNotebook(notebook: MutableNotebook): NotebookDocument {
  return Object.freeze({
    id: notebook.id,
    path: notebook.path,
    ...(notebook.kernel === undefined ? {} : {
      kernel: Object.freeze({ ...notebook.kernel }),
    }),
    fileVersion: notebook.fileVersion,
    nbformatMinor: notebook.nbformatMinor,
    metadata: Object.freeze(notebook.metadata),
    cells: Object.freeze(notebook.cells.map(cell => Object.freeze({
      id: cell.id,
      cellType: cell.cellType,
      source: cell.source,
      metadata: Object.freeze(cell.metadata),
      attachments: Object.freeze(cell.attachments),
      outputs: Object.freeze([...cell.outputs]),
      ...(cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
      ...(cell.status === undefined ? {} : { status: cell.status }),
      ...(cell.error === undefined ? {} : { error: cell.error }),
    }))),
  })
}

function assertWorkspaceNotebookPath(value: unknown): asserts value is string {
  assertNonEmpty('path', value)
  if (
    value.startsWith('/')
    || value.includes('\\')
    || /^[a-z]:/iu.test(value)
    || value.includes('\0')
  ) {
    throw new NotebookLogError('notebook path must be workspace-relative')
  }
  const segments = value.split('/')
  if (
    !value.toLowerCase().endsWith('.ipynb')
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new NotebookLogError('notebook path must be a normalized workspace-relative .ipynb path')
  }
}

function assertNonEmpty(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new NotebookLogError(`notebook ${field} must be a non-empty string`)
  }
}

function assertOptionalNonEmpty(field: string, value: unknown): asserts value is string | undefined {
  if (value !== undefined) assertNonEmpty(field, value)
}

function assertNonNegativeInteger(field: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new NotebookLogError(`notebook ${field} must be a non-negative safe integer`)
  }
}

function assertJsonObject(field: string, value: unknown): asserts value is Record<string, never> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) {
    throw new NotebookLogError(`${field} must be a JSON object`)
  }
}

function assertCellType(value: unknown): asserts value is 'code' | 'markdown' | 'raw' {
  if (value !== 'code' && value !== 'markdown' && value !== 'raw') {
    throw new NotebookLogError(`unknown notebook cellType ${JSON.stringify(value)}`)
  }
}

function assertImageMediaType(value: unknown): asserts value is ImageMediaType {
  if (
    value !== 'image/png'
    && value !== 'image/jpeg'
    && value !== 'image/webp'
    && value !== 'image/gif'
  ) {
    throw new NotebookLogError(`unsupported notebook image media type ${JSON.stringify(value)}`)
  }
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NotebookLogError(message)
  }
  return value as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

function canonicalBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function assertNever(value: never): never {
  throw new NotebookLogError(`unsupported notebook output mutation ${JSON.stringify(value)}`)
}
