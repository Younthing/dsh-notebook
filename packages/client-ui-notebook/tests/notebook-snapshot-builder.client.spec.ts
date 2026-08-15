import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  CellId, ExecutionId, NotebookFileVersion, NotebookId, NotebookMimeBundle,
} from '@younthing/dsh-notebook-core/types'
import type { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment/types'
import type {
  NotebookConversationViewNode,
  NotebookSessionEvent,
} from '../src/client/notebook-contract.ts'
import { notebookNode } from '../src/client/notebook-contract.ts'
import { NotebookSnapshotBuilder } from '../src/client/notebook-snapshot-builder.ts'

type NotebookEventInput = NotebookSessionEvent extends infer Event
  ? Event extends NotebookSessionEvent ? Omit<Event, 'seq' | 'time'> : never
  : never

const notebookId = 'notebook-1' as NotebookId
const cellId = 'cell-1' as CellId
const executionId = 'exec-1' as ExecutionId
const environmentId = 'workspace-venv' as NotebookEnvironmentId
const fileVersion1 = 'file-version-1' as NotebookFileVersion
const fileVersion2 = 'file-version-2' as NotebookFileVersion
const fileVersion3 = 'file-version-3' as NotebookFileVersion
const fileVersion5 = 'file-version-5' as NotebookFileVersion
const reloadImage: ImageAttachmentRef = {
  attachmentId: 'reload-image' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png',
  bytes: 3,
  width: 16,
  height: 8,
  name: 'reload.png',
}

const textBundle = (text: string): NotebookMimeBundle => ({
  'text/plain': { type: 'text', text },
})

function event(seq: number, input: NotebookEventInput): NotebookSessionEvent {
  return { seq, time: seq, ...input }
}

function malformedEvent(seq: number, type: NotebookSessionEvent['type'], data: unknown): NotebookSessionEvent {
  return { seq, time: seq, type, data } as unknown as NotebookSessionEvent
}

function node(value: NotebookSessionEvent): NotebookConversationViewNode {
  return notebookNode({
    key: `notebook-event:${value.seq}`,
    kind: 'notebook-event',
    id: String(value.seq),
  }, value.seq, value)
}

function openEvent(seq = 0, id = notebookId, path = 'analysis.ipynb'): NotebookSessionEvent {
  return event(seq, {
    type: 'notebook/open',
    data: {
      notebookId: id,
      path,
      fileVersion: fileVersion1,
      nbformatMinor: 5,
      metadata: { language_info: { name: 'python' } },
    },
  })
}

function kernelEvent(seq = 2, generation = 1): NotebookSessionEvent {
  return event(seq, {
    type: 'notebook/kernel',
    data: {
      notebookId,
      environmentId,
      backend: 'jupyter',
      kernelName: 'python3',
      generation,
      initiator: 'user',
      fileVersion: fileVersion1,
    },
  })
}

function createEvent(
  seq = 1,
  id = notebookId,
  idCell = cellId,
  source = 'print("one")',
): NotebookSessionEvent {
  return event(seq, {
    type: 'notebook/cell',
    data: {
      notebookId: id,
      cellId: idCell,
      cellType: 'code',
      source,
      index: 0,
      operation: 'create',
      metadata: { trusted: false },
      attachments: {},
      fileVersion: fileVersion2,
    },
  })
}

function reloadEvent(seq = 60): NotebookSessionEvent {
  return event(seq, {
    type: 'notebook/reload',
    data: {
      notebookId,
      initiator: 'user',
      fileVersion: fileVersion5,
      nbformatMinor: 6,
      metadata: { kernelspec: { name: 'external-python' } },
      cells: [{
        id: 'reload-markdown' as CellId,
        cellType: 'markdown',
        source: '# Reloaded',
        metadata: { trusted: true },
        attachments: {
          'reload.png': {
            'image/png': { type: 'image', attachment: reloadImage },
          },
        },
        outputs: [],
      }, {
        id: 'reload-code' as CellId,
        cellType: 'code',
        source: 'print("external")',
        metadata: {},
        attachments: {},
        outputs: [{
          type: 'display',
          data: textBundle('external output'),
          metadata: {},
        }],
        executionCount: 7,
      }],
    },
  })
}

function fullLog(): NotebookSessionEvent[] {
  return [
    openEvent(),
    createEvent(),
    event(51, {
      type: 'notebook/cell',
      data: {
        notebookId,
        cellId,
        cellType: 'code',
        source: 'print("two")',
        index: 0,
        operation: 'update',
        fileVersion: fileVersion3,
      },
    }),
    event(52, {
      type: 'notebook/execute',
      data: { notebookId, cellId, executionId, initiator: 'user' },
    }),
    event(53, {
      type: 'notebook/output',
      data: {
        notebookId,
        cellId,
        executionId,
        mutation: {
          operation: 'append',
          output: { type: 'stream', name: 'stdout', text: 'two\n' },
        },
      },
    }),
    event(54, {
      type: 'notebook/execute-end',
      data: {
        notebookId,
        cellId,
        executionId,
        status: 'ok',
        executionCount: 1,
        fileVersion: fileVersion3,
      },
    }),
  ]
}

describe('NotebookSnapshotBuilder', () => {
  it('contains a malformed durable output and preserves the last valid projection', () => {
    const builder = new NotebookSnapshotBuilder()
    const events = [
      openEvent(),
      createEvent(),
      event(2, {
        type: 'notebook/execute',
        data: { notebookId, cellId, executionId, initiator: 'user' },
      }),
      malformedEvent(3, 'notebook/output', {
        notebookId, cellId, executionId, output: { type: 'text', text: 'legacy flat output' },
      }),
      event(4, {
        type: 'notebook/execute-end',
        data: {
          notebookId,
          cellId,
          executionId,
          status: 'ok',
          executionCount: 1,
          fileVersion: fileVersion3,
        },
      }),
    ]
    const snapshot = builder.replace({ nodes: events.map(node) })
    expect(snapshot.protocolError).toBe('incompatible-history')
    expect(snapshot.folded.notebooks[0]?.cells[0]).toMatchObject({
      id: cellId,
      source: 'print("one")',
      status: 'running',
      outputs: [],
    })
  })

  it('contains a malformed durable cell without poisoning the document', () => {
    const builder = new NotebookSnapshotBuilder()
    const snapshot = builder.replace({
      nodes: [
        node(openEvent()),
        node(malformedEvent(1, 'notebook/cell', {
          notebookId,
          cellId,
          operation: 'create',
          source: 'legacy cell',
          index: 0,
        })),
        node(createEvent(2)),
      ],
    })
    expect(snapshot.protocolError).toBe('incompatible-history')
    expect(snapshot.incomplete).toBe(false)
    expect(snapshot.folded.notebooks[0]?.cells).toEqual([])
  })

  it('tolerates a cold tail and becomes complete after older events prepend incrementally', () => {
    const builder = new NotebookSnapshotBuilder()
    const log = fullLog()
    const tail = builder.replace({ nodes: log.slice(2).map(node) })
    expect(tail.incomplete).toBe(true)
    expect(tail.folded.notebooks).toEqual([])

    const prepended = builder.apply({ upserts: log.slice(0, 2).map(node) })
    expect(prepended.incomplete).toBe(false)
    expect(prepended.folded.notebooks).toMatchObject([{
      id: notebookId,
      path: 'analysis.ipynb',
      fileVersion: fileVersion3,
      nbformatMinor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: [{
        id: cellId,
        source: 'print("two")',
        metadata: { trusted: false },
        attachments: {},
        status: 'ok',
        executionCount: 1,
        outputs: [{ type: 'stream', name: 'stdout', text: 'two\n' }],
      }],
    }])
  })

  it('atomically replaces a document after its open prefix is recovered', () => {
    const builder = new NotebookSnapshotBuilder()
    const tail = builder.replace({ nodes: [node(reloadEvent())] })
    expect(tail.incomplete).toBe(true)
    expect(tail.folded.notebooks).toEqual([])

    const recovered = builder.apply({ upserts: [node(openEvent())] })
    expect(recovered.incomplete).toBe(false)
    const document = recovered.folded.notebooks[0]
    expect(document).toMatchObject({
      id: notebookId,
      path: 'analysis.ipynb',
      fileVersion: fileVersion5,
      nbformatMinor: 6,
      metadata: { kernelspec: { name: 'external-python' } },
      cells: [{
        id: 'reload-markdown' as CellId,
        cellType: 'markdown',
        source: '# Reloaded',
        attachments: {
          'reload.png': {
            'image/png': { type: 'image', attachment: reloadImage },
          },
        },
      }, {
        id: 'reload-code' as CellId,
        cellType: 'code',
        source: 'print("external")',
        executionCount: 7,
        outputs: [{ type: 'display', data: textBundle('external output') }],
      }],
    })
    expect(Object.hasOwn(document ?? {}, 'kernel')).toBe(false)
  })

  it('rejects reload snapshots with duplicate cell ids or outputs on non-code cells', () => {
    const validReload = reloadEvent(1)
    if (validReload.type !== 'notebook/reload') throw new Error('expected reload event')
    const markdown = validReload.data.cells[0]!

    const duplicateBuilder = new NotebookSnapshotBuilder()
    const duplicate = duplicateBuilder.replace({ nodes: [
      node(openEvent()),
      node(malformedEvent(1, 'notebook/reload', {
        ...validReload.data,
        cells: [markdown, { ...markdown }],
      })),
    ] })
    expect(duplicate.protocolError).toBe('incompatible-history')
    expect(duplicate.folded.notebooks[0]).toMatchObject({
      fileVersion: fileVersion1,
      cells: [],
    })

    const nonCodeOutputBuilder = new NotebookSnapshotBuilder()
    const nonCodeOutput = nonCodeOutputBuilder.replace({ nodes: [
      node(openEvent()),
      node(malformedEvent(1, 'notebook/reload', {
        ...validReload.data,
        cells: [{
          ...markdown,
          outputs: [{ type: 'stream', name: 'stdout', text: 'invalid\n' }],
        }],
      })),
    ] })
    expect(nonCodeOutput.protocolError).toBe('incompatible-history')
    expect(nonCodeOutput.folded.notebooks[0]).toMatchObject({
      fileVersion: fileVersion1,
      cells: [],
    })
  })

  it('requires kernel generations to advance exactly once and keeps reload document-only', () => {
    for (const generation of [0, 2]) {
      const builder = new NotebookSnapshotBuilder()
      const snapshot = builder.replace({ nodes: [node(openEvent()), node(kernelEvent(1, generation))] })
      expect(snapshot.protocolError).toBe('incompatible-history')
      expect(snapshot.folded.notebooks[0]).toMatchObject({ fileVersion: fileVersion1 })
      expect(snapshot.folded.notebooks[0]?.kernel).toBeUndefined()
    }
    const builder = new NotebookSnapshotBuilder()
    const reloaded = builder.replace({ nodes: [node(openEvent()), node(kernelEvent(1)), node(reloadEvent(2))] })
    expect(reloaded.protocolError).toBeNull()
    expect(reloaded.folded.notebooks[0]?.kernel).toEqual({
      environmentId,
      backend: 'jupyter',
      kernelName: 'python3',
      generation: 1,
    })
  })

  it('projects appended execution events without revisiting prior event payloads', () => {
    let pathReads = 0
    const open = event(0, {
      type: 'notebook/open',
      data: {
        notebookId,
        get path() {
          pathReads += 1
          return 'analysis.ipynb'
        },
        fileVersion: fileVersion1,
        nbformatMinor: 5,
        metadata: {},
      },
    })
    const log = fullLog()
    const builder = new NotebookSnapshotBuilder()
    builder.replace({ nodes: [node(open), node(log[1]!)] })
    expect(pathReads).toBe(1)

    const started = builder.apply({ upserts: [node(log[3]!)] })
    expect(started.folded.notebooks[0]?.cells[0]?.status).toBe('running')
    expect(pathReads).toBe(1)

    const streamed = builder.apply({ upserts: [node(log[4]!)] })
    expect(streamed.folded.notebooks[0]?.cells[0]?.outputs).toEqual([
      { type: 'stream', name: 'stdout', text: 'two\n' },
    ])
    expect(pathReads).toBe(1)
  })

  it('replaces the prior document set and scopes repeated cell ids by notebook', () => {
    const secondNotebook = 'notebook-2' as NotebookId
    const builder = new NotebookSnapshotBuilder()
    const snapshot = builder.replace({
      nodes: [
        node(openEvent()),
        node(createEvent()),
        node(openEvent(2, secondNotebook, 'second.ipynb')),
        node(event(3, {
          type: 'notebook/cell',
          data: {
            notebookId: secondNotebook,
            cellId,
            cellType: 'code',
            source: 'second source',
            index: 0,
            operation: 'create',
            executionCount: 4,
            outputs: [{
              type: 'execute-result',
              data: textBundle('imported\n'),
              metadata: {},
              executionCount: 4,
            }],
            metadata: { imported: true },
            attachments: { diagram: textBundle('attachment fallback') },
            fileVersion: fileVersion2,
          },
        })),
      ],
    })
    expect(snapshot.folded.notebooks.map(document => document.cells[0]?.source))
      .toEqual(['print("one")', 'second source'])
    expect(snapshot.folded.notebooks[1]?.cells[0]).toMatchObject({
      executionCount: 4,
      metadata: { imported: true },
      attachments: { diagram: textBundle('attachment fallback') },
      outputs: [{
        type: 'execute-result',
        data: textBundle('imported\n'),
        executionCount: 4,
      }],
    })

    const replaced = builder.replace({ nodes: [node(openEvent(10, secondNotebook, 'replacement.ipynb'))] })
    expect(replaced.folded.notebooks).toMatchObject([{
      id: secondNotebook,
      path: 'replacement.ipynb',
      cells: [],
    }])
  })

  it('applies deferred clear and display updates across cells', () => {
    const displayCellId = 'cell-display' as CellId
    const displayExecutionId = 'exec-display' as ExecutionId
    const nextExecutionId = 'exec-next' as ExecutionId
    const builder = new NotebookSnapshotBuilder()
    const snapshot = builder.replace({
      nodes: [
        node(openEvent()),
        node(event(1, {
          type: 'notebook/cell',
          data: {
            notebookId,
            cellId: displayCellId,
            cellType: 'code',
            source: 'display(1)',
            index: 0,
            operation: 'create',
            outputs: [{
              type: 'display',
              data: textBundle('old display'),
              metadata: { width: 10 },
              displayId: 'shared-display',
            }],
            fileVersion: fileVersion2,
          },
        })),
        node(event(2, {
          type: 'notebook/cell',
          data: {
            notebookId,
            cellId,
            cellType: 'code',
            source: 'update_display()',
            index: 1,
            operation: 'create',
            fileVersion: fileVersion2,
          },
        })),
        node(event(3, {
          type: 'notebook/execute',
          data: { notebookId, cellId, executionId: displayExecutionId, initiator: 'user' },
        })),
        node(event(4, {
          type: 'notebook/output',
          data: {
            notebookId,
            cellId,
            executionId: displayExecutionId,
            mutation: {
              operation: 'update-display',
              displayId: 'shared-display',
              data: textBundle('new display'),
              metadata: { width: 20 },
            },
          },
        })),
        node(event(5, {
          type: 'notebook/output',
          data: {
            notebookId,
            cellId,
            executionId: displayExecutionId,
            mutation: {
              operation: 'append',
              output: { type: 'stream', name: 'stdout', text: 'before clear\n' },
            },
          },
        })),
        node(event(6, {
          type: 'notebook/output',
          data: {
            notebookId,
            cellId,
            executionId: displayExecutionId,
            mutation: { operation: 'clear', wait: true },
          },
        })),
      ],
    })
    expect(snapshot.folded.notebooks[0]?.cells[0]?.outputs).toMatchObject([{
      type: 'display',
      data: textBundle('new display'),
      metadata: { width: 20 },
    }])
    expect(snapshot.folded.notebooks[0]?.cells[1]?.outputs).toEqual([
      { type: 'stream', name: 'stdout', text: 'before clear\n' },
    ])

    const cleared = builder.apply({ upserts: [node(event(7, {
      type: 'notebook/output',
      data: {
        notebookId,
        cellId,
        executionId: displayExecutionId,
        mutation: {
          operation: 'append',
          output: { type: 'stream', name: 'stderr', text: 'after clear\n' },
        },
      },
    }))] })
    expect(cleared.folded.notebooks[0]?.cells[1]?.outputs).toEqual([
      { type: 'stream', name: 'stderr', text: 'after clear\n' },
    ])

    const restarted = builder.apply({ upserts: [
      node(event(8, {
        type: 'notebook/execute-end',
        data: {
          notebookId,
          cellId,
          executionId: displayExecutionId,
          status: 'cancelled',
          error: 'kernel interrupted',
          executionCount: 2,
          fileVersion: fileVersion3,
        },
      })),
      node(event(9, {
        type: 'notebook/kernel',
        data: {
          notebookId,
          environmentId,
          backend: 'jupyter',
          generation: 1,
          initiator: 'user',
          kernelName: 'python-next',
          fileVersion: fileVersion3,
        },
      })),
    ] })
    expect(restarted.folded.notebooks[0]).toMatchObject({
      kernel: {
        environmentId,
        backend: 'jupyter',
        generation: 1,
        kernelName: 'python-next',
      },
      fileVersion: fileVersion3,
      cells: [{ id: displayCellId }, {
        id: cellId,
        status: 'cancelled',
        error: 'kernel interrupted',
        executionCount: 2,
      }],
    })

    const immediateBuilder = new NotebookSnapshotBuilder()
    immediateBuilder.replace({ nodes: [node(openEvent()), node(createEvent())] })
    immediateBuilder.apply({ upserts: [node(event(10, {
      type: 'notebook/execute',
      data: { notebookId, cellId, executionId: nextExecutionId, initiator: 'user' },
    }))] })
    immediateBuilder.apply({ upserts: [node(event(11, {
      type: 'notebook/output',
      data: {
        notebookId,
        cellId,
        executionId: nextExecutionId,
        mutation: {
          operation: 'append',
          output: { type: 'stream', name: 'stdout', text: 'temporary' },
        },
      },
    }))] })
    const immediatelyCleared = immediateBuilder.apply({ upserts: [node(event(12, {
      type: 'notebook/output',
      data: {
        notebookId,
        cellId,
        executionId: nextExecutionId,
        mutation: { operation: 'clear', wait: false },
      },
    }))] })
    expect(immediatelyCleared.folded.notebooks[0]?.cells[0]?.outputs).toEqual([])
  })

  it('preserves the prior cell count when a cancelled execution reports no new count', () => {
    const builder = new NotebookSnapshotBuilder()
    const created = event(1, {
      type: 'notebook/cell',
      data: {
        notebookId,
        cellId,
        cellType: 'code',
        source: 'long_running()',
        index: 0,
        operation: 'create',
        executionCount: 7,
        fileVersion: fileVersion2,
      },
    })
    builder.replace({ nodes: [node(openEvent()), node(created)] })
    builder.apply({ upserts: [node(event(2, {
      type: 'notebook/execute',
      data: { notebookId, cellId, executionId, initiator: 'user' },
    }))] })
    const cancelled = builder.apply({ upserts: [node(event(3, {
      type: 'notebook/execute-end',
      data: {
        notebookId,
        cellId,
        executionId,
        status: 'cancelled',
        executionCount: null,
        error: 'transport ended',
        fileVersion: fileVersion3,
      },
    }))] })
    expect(cancelled.folded.notebooks[0]?.cells[0]).toMatchObject({
      status: 'cancelled',
      executionCount: 7,
      error: 'transport ended',
    })
  })
})
