import type { ConversationViewBuilder, ConversationViewDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CellId,
  ExecutionId,
  FoldedNotebooks,
  NotebookCell,
  NotebookCellAttachments,
  NotebookCellSnapshot,
  NotebookDocument,
  NotebookId,
  NotebookJsonObject,
  NotebookMimeBundle,
  NotebookOutput,
  NotebookUpdateDisplayMutation,
} from '@younthing/dsh-notebook-core/types'
import type {
  NotebookConversationViewNode, NotebookSessionEvent, NotebookSnapshot,
} from './notebook-contract.ts'
import { EMPTY_NOTEBOOK_SNAPSHOT } from './notebook-contract.ts'

interface ActiveExecution {
  readonly notebookId: NotebookId
  readonly cellId: CellId
  readonly executionId: ExecutionId
  readonly outputs: readonly NotebookOutput[]
  readonly pendingClear: boolean
}

interface ExecutionIdentity {
  readonly notebookId: NotebookId
  readonly cellId: CellId
  readonly executionId: ExecutionId
}

interface CellLocation {
  readonly documentIndex: number
  readonly cellIndex: number
  readonly cell: NotebookCell
}

interface ActiveExecutionLocation {
  readonly key: string
  readonly execution: ActiveExecution
  readonly location: CellLocation
}

interface KernelTransitionIdentity {
  readonly notebookId: NotebookId
  readonly generation: number
}

interface DocumentLocation {
  readonly documentIndex: number
  readonly document: NotebookDocument
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isNonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isMimeBundle(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).every((entry) => {
    if (!isRecord(entry) || typeof entry.type !== 'string') return false
    switch (entry.type) {
      case 'text':
        return typeof entry.text === 'string'
      case 'json':
        return Object.hasOwn(entry, 'value')
      case 'base64':
        return typeof entry.data === 'string'
      case 'image': {
        const attachment = entry.attachment
        return isRecord(attachment)
          && typeof attachment.attachmentId === 'string'
          && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(attachment.mediaType))
          && isNonnegativeInteger(attachment.bytes)
          && isNonnegativeInteger(attachment.width)
          && isNonnegativeInteger(attachment.height)
          && isOptionalString(attachment.name)
      }
      default:
        return false
    }
  })
}

function isAttachments(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isMimeBundle)
}

function isNotebookOutput(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'stream':
      return (value.name === 'stdout' || value.name === 'stderr') && typeof value.text === 'string'
    case 'display':
      return isMimeBundle(value.data) && isRecord(value.metadata) && isOptionalString(value.displayId)
    case 'execute-result':
      return isMimeBundle(value.data)
        && isRecord(value.metadata)
        && (value.executionCount === null || isNonnegativeInteger(value.executionCount))
        && isOptionalString(value.displayId)
    case 'error':
      return typeof value.name === 'string'
        && typeof value.value === 'string'
        && Array.isArray(value.traceback)
        && value.traceback.every(line => typeof line === 'string')
    default:
      return false
  }
}

function isOutputMutation(value: unknown): boolean {
  if (!isRecord(value) || typeof value.operation !== 'string') return false
  switch (value.operation) {
    case 'append':
      return isNotebookOutput(value.output)
    case 'clear':
      return typeof value.wait === 'boolean'
    case 'update-display':
      return typeof value.displayId === 'string'
        && isMimeBundle(value.data)
        && isRecord(value.metadata)
    default:
      return false
  }
}

function isCellSnapshot(value: unknown): value is NotebookCellSnapshot {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || (value.cellType !== 'code' && value.cellType !== 'markdown' && value.cellType !== 'raw')
    || typeof value.source !== 'string'
    || !isRecord(value.metadata)
    || !isAttachments(value.attachments)
    || !Array.isArray(value.outputs)
    || !value.outputs.every(isNotebookOutput)
    || (value.executionCount !== undefined && !isNonnegativeInteger(value.executionCount))) return false
  return value.cellType === 'code' || value.outputs.length === 0
}

function isReloadCells(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const cellIds = new Set<string>()
  for (const cell of value) {
    if (!isCellSnapshot(cell) || cellIds.has(cell.id)) return false
    cellIds.add(cell.id)
  }
  return true
}

function hasNotebookId(data: Readonly<Record<string, unknown>>): boolean {
  return typeof data.notebookId === 'string'
}

function hasCellIdentity(data: Readonly<Record<string, unknown>>): boolean {
  return hasNotebookId(data) && typeof data.cellId === 'string'
}

function hasExecutionIdentity(data: Readonly<Record<string, unknown>>): boolean {
  return hasCellIdentity(data) && typeof data.executionId === 'string'
}

function isCurrentNotebookEvent(event: NotebookSessionEvent): boolean {
  const data = (event as unknown as { readonly data?: unknown }).data
  if (!isRecord(data)) return false
  switch (event.type) {
    case 'notebook/open':
      return hasNotebookId(data)
        && typeof data.path === 'string'
        && typeof data.fileVersion === 'string'
        && isNonnegativeInteger(data.nbformatMinor)
        && isRecord(data.metadata)
    case 'notebook/cell':
      return hasCellIdentity(data)
        && (data.cellType === 'code' || data.cellType === 'markdown' || data.cellType === 'raw')
        && typeof data.source === 'string'
        && isNonnegativeInteger(data.index)
        && (data.operation === 'create'
          || data.operation === 'update'
          || data.operation === 'delete'
          || data.operation === 'move')
        && typeof data.fileVersion === 'string'
        && (data.metadata === undefined || isRecord(data.metadata))
        && (data.attachments === undefined || isAttachments(data.attachments))
        && (data.outputs === undefined
          || (Array.isArray(data.outputs) && data.outputs.every(isNotebookOutput)))
        && (data.executionCount === undefined || isNonnegativeInteger(data.executionCount))
        && (data.operation !== 'move'
          || (isNonnegativeInteger(data.fromIndex) && isNonnegativeInteger(data.toIndex)))
    case 'notebook/execute':
      return hasExecutionIdentity(data) && (data.initiator === 'agent' || data.initiator === 'user')
    case 'notebook/output':
      return hasExecutionIdentity(data) && isOutputMutation(data.mutation)
    case 'notebook/execute-end':
      return hasExecutionIdentity(data)
        && (data.status === 'ok' || data.status === 'error' || data.status === 'cancelled')
        && (data.executionCount === null || isNonnegativeInteger(data.executionCount))
        && isOptionalString(data.error)
        && typeof data.fileVersion === 'string'
    case 'notebook/kernel':
      return hasNotebookId(data)
        && typeof data.environmentId === 'string'
        && typeof data.backend === 'string'
        && isNonnegativeInteger(data.generation)
        && (data.initiator === 'agent' || data.initiator === 'user')
        && isOptionalString(data.kernelName)
    case 'notebook/reload':
      return hasNotebookId(data)
        && (data.initiator === 'agent' || data.initiator === 'user')
        && typeof data.fileVersion === 'string'
        && isNonnegativeInteger(data.nbformatMinor)
        && isRecord(data.metadata)
        && isReloadCells(data.cells)
    default:
      return assertNever(event)
  }
}

function normalizeCurrentNotebookEvent(event: NotebookSessionEvent): NotebookSessionEvent | undefined {
  const data = (event as unknown as { readonly data?: unknown }).data
  if (!isRecord(data)) return undefined
  const normalized = {
    seq: event.seq,
    time: event.time,
    type: event.type,
    data: { ...data },
  } as NotebookSessionEvent
  return isCurrentNotebookEvent(normalized) ? normalized : undefined
}

function assertNever(value: never): never {
  throw new Error(`unsupported notebook event ${JSON.stringify(value)}`)
}

function cellKey(notebookId: NotebookId, cellId: CellId): string {
  return `${String(notebookId).length}:${String(notebookId)}${String(cellId)}`
}

function executionKey(notebookId: NotebookId, cellId: CellId, executionId: ExecutionId): string {
  return `${cellKey(notebookId, cellId)}:${String(executionId)}`
}

function freezeJsonObject(value: NotebookJsonObject): NotebookJsonObject {
  return Object.freeze({ ...value })
}

function freezeBundle(bundle: NotebookMimeBundle): NotebookMimeBundle {
  const result = Object.create(null) as Record<string, NotebookMimeBundle[string]>
  for (const [mimeType, value] of Object.entries(bundle)) {
    switch (value.type) {
      case 'text':
        result[mimeType] = Object.freeze({ type: 'text', text: value.text })
        break
      case 'json':
        result[mimeType] = Object.freeze({ type: 'json', value: value.value })
        break
      case 'image':
        result[mimeType] = Object.freeze({
          type: 'image',
          attachment: Object.freeze({ ...value.attachment }),
        })
        break
      case 'base64':
        result[mimeType] = Object.freeze({ type: 'base64', data: value.data })
        break
      default:
        assertNever(value)
    }
  }
  return Object.freeze(result)
}

function freezeAttachments(attachments: NotebookCellAttachments): NotebookCellAttachments {
  const result = Object.create(null) as Record<string, NotebookMimeBundle>
  for (const [name, bundle] of Object.entries(attachments)) result[name] = freezeBundle(bundle)
  return Object.freeze(result)
}

function freezeOutput(output: NotebookOutput): NotebookOutput {
  switch (output.type) {
    case 'stream':
      return Object.freeze({ type: 'stream', name: output.name, text: output.text })
    case 'display':
      return Object.freeze({
        type: 'display',
        data: freezeBundle(output.data),
        metadata: freezeJsonObject(output.metadata),
        ...(output.displayId === undefined ? {} : { displayId: output.displayId }),
      })
    case 'execute-result':
      return Object.freeze({
        type: 'execute-result',
        data: freezeBundle(output.data),
        metadata: freezeJsonObject(output.metadata),
        executionCount: output.executionCount,
        ...(output.displayId === undefined ? {} : { displayId: output.displayId }),
      })
    case 'error':
      return Object.freeze({
        type: 'error',
        name: output.name,
        value: output.value,
        traceback: Object.freeze([...output.traceback]),
      })
    default:
      return assertNever(output)
  }
}

function freezeCell(snapshot: NotebookCellSnapshot): NotebookCell {
  return Object.freeze({
    id: snapshot.id,
    cellType: snapshot.cellType,
    source: snapshot.source,
    metadata: freezeJsonObject(snapshot.metadata),
    attachments: freezeAttachments(snapshot.attachments),
    outputs: Object.freeze(snapshot.outputs.map(freezeOutput)),
    ...(snapshot.executionCount === undefined ? {} : { executionCount: snapshot.executionCount }),
  })
}

function updateDisplayOutput(
  output: NotebookOutput,
  mutation: NotebookUpdateDisplayMutation,
): NotebookOutput {
  if (
    (output.type !== 'display' && output.type !== 'execute-result')
    || output.displayId !== mutation.displayId
  ) return output
  return Object.freeze({
    ...output,
    data: freezeBundle(mutation.data),
    metadata: freezeJsonObject(mutation.metadata),
  })
}

/** Prefix-tolerant browser projection over one loaded notebook-event window. */
class NotebookProjector {
  private documents: readonly NotebookDocument[] = Object.freeze([])
  private readonly notebookIndexes = new Map<NotebookId, number>()
  private readonly activeExecutions = new Map<string, ActiveExecution>()
  private incomplete = false
  private protocolError: NotebookSnapshot['protocolError'] = null

  reset(): void {
    this.documents = Object.freeze([])
    this.notebookIndexes.clear()
    this.activeExecutions.clear()
    this.incomplete = false
    this.protocolError = null
  }

  apply(event: NotebookSessionEvent): void {
    if (this.protocolError !== null) return
    const current = normalizeCurrentNotebookEvent(event)
    if (current === undefined) {
      this.protocolError = 'incompatible-history'
      return
    }
    switch (current.type) {
      case 'notebook/open':
        this.open(current.data)
        return
      case 'notebook/cell':
        this.cell(current.data)
        return
      case 'notebook/execute':
        this.execute(current.data)
        return
      case 'notebook/output':
        this.output(current.data)
        return
      case 'notebook/execute-end':
        this.executeEnd(current.data)
        return
      case 'notebook/kernel':
        this.kernel(current.data)
        return
      case 'notebook/reload':
        this.reload(current.data)
        return
      default:
        assertNever(current)
    }
  }

  snapshot(): NotebookSnapshot {
    const folded: FoldedNotebooks = Object.freeze({ notebooks: this.documents })
    return Object.freeze({ folded, incomplete: this.incomplete, protocolError: this.protocolError })
  }

  private open(data: Extract<NotebookSessionEvent, { type: 'notebook/open' }>['data']): void {
    if (this.notebookIndexes.has(data.notebookId)) {
      this.incomplete = true
      return
    }
    const document: NotebookDocument = Object.freeze({
      id: data.notebookId,
      path: data.path,
      fileVersion: data.fileVersion,
      nbformatMinor: data.nbformatMinor,
      metadata: freezeJsonObject(data.metadata),
      cells: Object.freeze([]),
    })
    this.notebookIndexes.set(data.notebookId, this.documents.length)
    this.documents = Object.freeze([...this.documents, document])
  }

  private cell(data: Extract<NotebookSessionEvent, { type: 'notebook/cell' }>['data']): void {
    const documentIndex = this.notebookIndexes.get(data.notebookId)
    if (documentIndex === undefined) {
      this.incomplete = true
      return
    }
    const document = this.documents[documentIndex]
    if (document === undefined) return
    const cellIndex = document.cells.findIndex(cell => cell.id === data.cellId)
    if (data.operation === 'create') {
      if (cellIndex !== -1 || data.index < 0 || data.index > document.cells.length) {
        this.incomplete = true
        return
      }
      const cell = freezeCell({
        id: data.cellId,
        cellType: data.cellType,
        source: data.source,
        metadata: data.metadata ?? {},
        attachments: data.attachments ?? {},
        outputs: data.outputs ?? [],
        ...(data.executionCount === undefined ? {} : { executionCount: data.executionCount }),
      })
      const cells = [...document.cells]
      cells.splice(data.index, 0, cell)
      this.replaceDocument(documentIndex, {
        ...document,
        fileVersion: data.fileVersion,
        cells: Object.freeze(cells),
      })
      return
    }
    if (data.operation === 'delete') {
      const target = document.cells[data.index]
      if (target === undefined || target.id !== data.cellId) {
        this.incomplete = true
        return
      }
      const cells = [...document.cells]
      cells.splice(data.index, 1)
      this.replaceDocument(documentIndex, {
        ...document,
        fileVersion: data.fileVersion,
        cells: Object.freeze(cells),
      })
      return
    }
    if (data.operation === 'move') {
      const fromIndex = data.fromIndex
      const toIndex = data.toIndex
      if (fromIndex === undefined
        || toIndex === undefined
        || fromIndex < 0
        || fromIndex >= document.cells.length
        || toIndex < 0
        || toIndex >= document.cells.length) {
        this.incomplete = true
        return
      }
      const source = document.cells[fromIndex]
      if (source === undefined || source.id !== data.cellId) {
        this.incomplete = true
        return
      }
      const cells = [...document.cells]
      cells.splice(fromIndex, 1)
      cells.splice(toIndex, 0, source)
      this.replaceDocument(documentIndex, {
        ...document,
        fileVersion: data.fileVersion,
        cells: Object.freeze(cells),
      })
      return
    }
    if (cellIndex === -1) {
      this.incomplete = true
      return
    }
    if (cellIndex !== data.index) {
      this.incomplete = true
      return
    }
    const cell = document.cells[cellIndex]
    if (cell === undefined) return
    this.replaceCell(documentIndex, cellIndex, { ...cell, source: data.source })
    const updated = this.documents[documentIndex]
    if (updated !== undefined) this.replaceDocument(documentIndex, { ...updated, fileVersion: data.fileVersion })
  }

  private execute(data: Extract<NotebookSessionEvent, { type: 'notebook/execute' }>['data']): void {
    const location = this.findCell(data.notebookId, data.cellId)
    if (location === undefined) {
      this.incomplete = true
      return
    }
    const { error: _error, ...cell } = location.cell
    this.replaceCell(location.documentIndex, location.cellIndex, {
      ...cell,
      outputs: Object.freeze([]),
      status: 'running',
    })
    this.activeExecutions.set(executionKey(data.notebookId, data.cellId, data.executionId), {
      notebookId: data.notebookId,
      cellId: data.cellId,
      executionId: data.executionId,
      outputs: Object.freeze([]),
      pendingClear: false,
    })
  }

  private output(data: Extract<NotebookSessionEvent, { type: 'notebook/output' }>['data']): void {
    const active = this.requireActiveExecution(data)
    if (active === undefined) return
    const { key, execution, location } = active
    const mutation = data.mutation
    switch (mutation.operation) {
      case 'append': {
        const outputs = Object.freeze([
          ...(execution.pendingClear ? [] : execution.outputs),
          freezeOutput(mutation.output),
        ])
        this.activeExecutions.set(key, { ...execution, outputs, pendingClear: false })
        this.replaceCell(location.documentIndex, location.cellIndex, {
          ...location.cell,
          outputs,
          status: 'running',
        })
        return
      }
      case 'clear': {
        if (mutation.wait) {
          this.activeExecutions.set(key, { ...execution, pendingClear: true })
          return
        }
        const outputs: readonly NotebookOutput[] = Object.freeze([])
        this.activeExecutions.set(key, { ...execution, outputs, pendingClear: false })
        this.replaceCell(location.documentIndex, location.cellIndex, {
          ...location.cell,
          outputs,
          status: 'running',
        })
        return
      }
      case 'update-display': {
        const activeOutputs = Object.freeze((execution.pendingClear ? [] : execution.outputs)
          .map(output => updateDisplayOutput(output, mutation)))
        const nextExecution = { ...execution, outputs: activeOutputs, pendingClear: false }
        this.activeExecutions.set(key, nextExecution)
        this.replaceDisplayOutputs(location.documentIndex, nextExecution, mutation)
        return
      }
      default:
        assertNever(mutation)
    }
  }

  private executeEnd(data: Extract<NotebookSessionEvent, { type: 'notebook/execute-end' }>['data']): void {
    const active = this.requireActiveExecution(data)
    if (active === undefined) return
    const { key, execution, location } = active
    this.activeExecutions.delete(key)
    const { error: _error, ...cell } = location.cell
    this.replaceCell(location.documentIndex, location.cellIndex, {
      ...cell,
      outputs: execution.outputs,
      status: data.status,
      ...(data.executionCount === null ? {} : { executionCount: data.executionCount }),
      ...(data.error === undefined ? {} : { error: data.error }),
    })
    const document = this.documents[location.documentIndex]
    if (document !== undefined) {
      this.replaceDocument(location.documentIndex, { ...document, fileVersion: data.fileVersion })
    }
  }

  private kernel(data: Extract<NotebookSessionEvent, { type: 'notebook/kernel' }>['data']): void {
    const location = this.requireNextKernelDocument(data)
    if (location === undefined) return
    const { documentIndex, document } = location
    this.replaceDocument(documentIndex, {
      ...document,
      kernel: Object.freeze({
        environmentId: data.environmentId,
        backend: data.backend,
        ...(data.kernelName === undefined ? {} : { kernelName: data.kernelName }),
        generation: data.generation,
      }),
    })
  }

  private reload(data: Extract<NotebookSessionEvent, { type: 'notebook/reload' }>['data']): void {
    const documentIndex = this.notebookIndexes.get(data.notebookId)
    const document = documentIndex === undefined ? undefined : this.documents[documentIndex]
    if (documentIndex === undefined || document === undefined) {
      this.incomplete = true
      return
    }
    for (const [key, execution] of this.activeExecutions) {
      if (execution.notebookId === data.notebookId) this.activeExecutions.delete(key)
    }
    this.replaceDocument(documentIndex, {
      ...document,
      fileVersion: data.fileVersion,
      nbformatMinor: data.nbformatMinor,
      metadata: freezeJsonObject(data.metadata),
      cells: Object.freeze(data.cells.map(freezeCell)),
    })
  }

  private replaceDisplayOutputs(
    documentIndex: number,
    execution: ActiveExecution,
    mutation: NotebookUpdateDisplayMutation,
  ): void {
    const document = this.documents[documentIndex]
    if (document === undefined) return
    const cells = document.cells.map((cell) => {
      if (cell.id === execution.cellId) {
        return Object.freeze({ ...cell, outputs: execution.outputs })
      }
      let changed = false
      const outputs: NotebookOutput[] = []
      for (const output of cell.outputs) {
        const next = updateDisplayOutput(output, mutation)
        if (next !== output) changed = true
        outputs.push(next)
      }
      return changed ? Object.freeze({ ...cell, outputs: Object.freeze(outputs) }) : cell
    })
    this.replaceDocument(documentIndex, { ...document, cells: Object.freeze(cells) })
  }

  private requireActiveExecution(data: ExecutionIdentity): ActiveExecutionLocation | undefined {
    const key = executionKey(data.notebookId, data.cellId, data.executionId)
    const execution = this.activeExecutions.get(key)
    const location = this.findCell(data.notebookId, data.cellId)
    if (execution === undefined || location === undefined) {
      this.incomplete = true
      return undefined
    }
    return { key, execution, location }
  }

  private requireNextKernelDocument(data: KernelTransitionIdentity): DocumentLocation | undefined {
    const documentIndex = this.notebookIndexes.get(data.notebookId)
    const document = documentIndex === undefined ? undefined : this.documents[documentIndex]
    if (documentIndex === undefined || document === undefined) {
      this.incomplete = true
      return undefined
    }
    if (data.generation !== (document.kernel?.generation ?? 0) + 1) {
      this.protocolError = 'incompatible-history'
      return undefined
    }
    return { documentIndex, document }
  }

  private findCell(notebookId: NotebookId, cellId: CellId): CellLocation | undefined {
    const documentIndex = this.notebookIndexes.get(notebookId)
    if (documentIndex === undefined) return undefined
    const document = this.documents[documentIndex]
    const cellIndex = document?.cells.findIndex(cell => cell.id === cellId) ?? -1
    const cell = cellIndex === -1 ? undefined : document?.cells[cellIndex]
    return cell === undefined ? undefined : { documentIndex, cellIndex, cell }
  }

  private replaceCell(documentIndex: number, cellIndex: number, cell: NotebookCell): void {
    const document = this.documents[documentIndex]
    if (document === undefined) return
    const cells = [...document.cells]
    cells[cellIndex] = Object.freeze(cell)
    this.replaceDocument(documentIndex, { ...document, cells: Object.freeze(cells) })
  }

  private replaceDocument(documentIndex: number, document: NotebookDocument): void {
    const documents = [...this.documents]
    documents[documentIndex] = Object.freeze(document)
    this.documents = Object.freeze(documents)
  }
}

/** Incrementally fold notebook events captured by the notebook event Definition. */
export class NotebookSnapshotBuilder implements ConversationViewBuilder<
  NotebookConversationViewNode,
  NotebookSnapshot
> {
  private readonly events = new Map<number, NotebookSessionEvent>()
  private readonly projector = new NotebookProjector()
  private maxSeq = -1
  readonly empty = EMPTY_NOTEBOOK_SNAPSHOT

  replace(input: { readonly nodes: readonly NotebookConversationViewNode[] }): NotebookSnapshot {
    this.events.clear()
    for (const node of input.nodes) this.events.set(node.data.event.seq, node.data.event)
    return this.rebuild()
  }

  apply(input: { readonly upserts: readonly NotebookConversationViewNode[] }): NotebookSnapshot {
    const appended: NotebookSessionEvent[] = []
    let requiresRebuild = false
    for (const node of input.upserts) {
      const event = node.data.event
      const previous = this.events.get(event.seq)
      if (previous === event) continue
      this.events.set(event.seq, event)
      if (previous !== undefined || event.seq <= this.maxSeq) requiresRebuild = true
      else appended.push(event)
    }
    if (requiresRebuild) return this.rebuild()
    appended.sort((left, right) => left.seq - right.seq)
    for (const event of appended) {
      this.projector.apply(event)
      this.maxSeq = event.seq
    }
    return this.projector.snapshot()
  }

  private rebuild(): NotebookSnapshot {
    this.projector.reset()
    const ordered = [...this.events.values()].sort((left, right) => left.seq - right.seq)
    this.maxSeq = -1
    for (const event of ordered) {
      this.projector.apply(event)
      this.maxSeq = event.seq
    }
    return this.projector.snapshot()
  }
}

/** Notebook target factory folding durable notebook/* session events. */
export const notebookViewDefinition: ConversationViewDefinition<
  NotebookConversationViewNode,
  NotebookSnapshot
> = {
  target: 'notebook',
  create: () => new NotebookSnapshotBuilder(),
}
