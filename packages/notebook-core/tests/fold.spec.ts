import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { NotebookEnvironmentId } from '@deepseek-ai/dsh-notebook-environment'
import { CellId, ExecutionId, NotebookId, foldNotebooks } from '@deepseek-ai/dsh-notebook-core'
import { NotebookFileVersion } from '../src/brand.ts'

describe('foldNotebooks', () => {
  it('reconstructs rich outputs, file revisions, and kernel generations', () => {
    const session = Session.create(SessionId('fold-notebook'))
    const notebookId = NotebookId('notebook-1')
    const cellId = CellId('cell-1')
    const executionId = ExecutionId('exec-1')
    session.append('notebook/open', {
      notebookId,
      path: 'demo.ipynb',
      fileVersion: NotebookFileVersion('v1'),
      nbformatMinor: 5,
      metadata: { kernelspec: { name: 'python3' } },
    })
    session.append('notebook/cell', {
      notebookId,
      cellId,
      cellType: 'code',
      source: 'print(1)',
      index: 0,
      operation: 'create',
      metadata: {},
      attachments: {},
      outputs: [],
      fileVersion: NotebookFileVersion('v1'),
    })
    session.append('notebook/execute', {
      notebookId,
      cellId,
      executionId,
      initiator: 'agent',
    })
    session.append('notebook/output', {
      notebookId,
      cellId,
      executionId,
      mutation: {
        operation: 'append',
        output: { type: 'stream', name: 'stdout', text: '1\n' },
      },
    })
    session.append('notebook/output', {
      notebookId,
      cellId,
      executionId,
      mutation: {
        operation: 'append',
        output: {
          type: 'display',
          data: { 'text/plain': { type: 'text', text: 'old' } },
          metadata: {},
          displayId: 'shared',
        },
      },
    })
    session.append('notebook/output', {
      notebookId,
      cellId,
      executionId,
      mutation: {
        operation: 'update-display',
        displayId: 'shared',
        data: { 'text/plain': { type: 'text', text: 'new' } },
        metadata: { changed: true },
      },
    })
    session.append('notebook/execute-end', {
      notebookId,
      cellId,
      executionId,
      status: 'ok',
      executionCount: 1,
      fileVersion: NotebookFileVersion('v2'),
    })
    session.append('notebook/kernel', {
      notebookId,
      environmentId: NotebookEnvironmentId('env-1'),
      backend: 'memory',
      generation: 1,
      initiator: 'user',
      kernelName: 'pypy3',
      fileVersion: NotebookFileVersion('v2'),
    })

    const document = foldNotebooks(session.events).notebooks[0]
    expect(document).toMatchObject({
      fileVersion: 'v2',
      kernel: {
        environmentId: 'env-1',
        backend: 'memory',
        generation: 1,
        kernelName: 'pypy3',
      },
      metadata: { kernelspec: { name: 'python3' } },
    })
    expect(document?.cells[0]).toMatchObject({
      executionCount: 1,
      status: 'ok',
      outputs: [
        { type: 'stream', name: 'stdout', text: '1\n' },
        {
          type: 'display',
          data: { 'text/plain': { type: 'text', text: 'new' } },
          metadata: { changed: true },
          displayId: 'shared',
        },
      ],
    })
  })

  it('retains the prior execution count for interrupted runs and exposes live state', () => {
    const session = Session.create(SessionId('fold-running'))
    const notebookId = NotebookId('notebook-1')
    const cellId = CellId('cell-1')
    session.append('notebook/open', {
      notebookId,
      path: 'demo.ipynb',
      fileVersion: NotebookFileVersion('v1'),
      nbformatMinor: 5,
      metadata: {},
    })
    session.append('notebook/cell', {
      notebookId,
      cellId,
      cellType: 'code',
      source: '',
      index: 0,
      operation: 'create',
      executionCount: 4,
      metadata: {},
      attachments: {},
      outputs: [],
      fileVersion: NotebookFileVersion('v1'),
    })
    session.append('notebook/execute', {
      notebookId,
      cellId,
      executionId: ExecutionId('exec-1'),
      initiator: 'agent',
    })
    expect(foldNotebooks(session.events).notebooks[0]?.cells[0]).toMatchObject({
      executionCount: 4,
      status: 'running',
      outputs: [],
    })
    session.append('notebook/execute-end', {
      notebookId,
      cellId,
      executionId: ExecutionId('exec-1'),
      status: 'cancelled',
      executionCount: null,
      error: 'service restarted',
      fileVersion: NotebookFileVersion('v1'),
    })
    expect(foldNotebooks(session.events).notebooks[0]?.cells[0]).toMatchObject({
      executionCount: 4,
      status: 'cancelled',
      error: 'service restarted',
    })
  })

  it('atomically replaces a stale document from a reload snapshot', () => {
    const session = Session.create(SessionId('fold-reload'))
    const notebookId = NotebookId('notebook-1')
    session.append('notebook/open', {
      notebookId,
      path: 'demo.ipynb',
      fileVersion: NotebookFileVersion('v1'),
      nbformatMinor: 5,
      metadata: { kernelspec: { name: 'python3' } },
    })
    session.append('notebook/cell', {
      notebookId,
      cellId: CellId('old-cell'),
      cellType: 'code',
      source: 'old',
      index: 0,
      operation: 'create',
      metadata: {},
      attachments: {},
      outputs: [],
      fileVersion: NotebookFileVersion('v1'),
    })
    session.append('notebook/kernel', {
      notebookId,
      environmentId: NotebookEnvironmentId('env-1'),
      backend: 'memory',
      kernelName: 'python3',
      generation: 1,
      initiator: 'agent',
      fileVersion: NotebookFileVersion('v1'),
    })
    session.append('notebook/reload', {
      notebookId,
      initiator: 'user',
      fileVersion: NotebookFileVersion('v2'),
      nbformatMinor: 6,
      metadata: { external: true },
      cells: [
        {
          id: CellId('new-code'),
          cellType: 'code',
          source: 'answer = 42',
          metadata: { tags: ['fresh'] },
          attachments: {},
          outputs: [{ type: 'stream', name: 'stdout', text: '42\n' }],
          executionCount: 8,
        },
        {
          id: CellId('new-markdown'),
          cellType: 'markdown',
          source: '![plot](attachment:plot.txt)',
          metadata: {},
          attachments: {
            'plot.txt': { 'text/plain': { type: 'text', text: 'plot' } },
          },
          outputs: [],
        },
      ],
    })

    const document = foldNotebooks(session.events).notebooks[0]
    expect(document).toMatchObject({
      fileVersion: 'v2',
      kernel: { environmentId: 'env-1', backend: 'memory', kernelName: 'python3', generation: 1 },
      nbformatMinor: 6,
      metadata: { external: true },
    })
    expect(document?.cells.map(cell => cell.id)).toEqual(['new-code', 'new-markdown'])
    expect(document?.cells[0]).toMatchObject({ executionCount: 8, outputs: [{ text: '42\n' }] })
  })

  it('rejects a reload snapshot with duplicate cell identities', () => {
    const session = Session.create(SessionId('fold-invalid-reload'))
    const notebookId = NotebookId('notebook-1')
    const repeated = CellId('repeated')
    session.append('notebook/open', {
      notebookId,
      path: 'demo.ipynb',
      fileVersion: NotebookFileVersion('v1'),
      nbformatMinor: 5,
      metadata: {},
    })
    session.append('notebook/reload', {
      notebookId,
      initiator: 'agent',
      fileVersion: NotebookFileVersion('v2'),
      nbformatMinor: 5,
      metadata: {},
      cells: [
        { id: repeated, cellType: 'code', source: '', metadata: {}, attachments: {}, outputs: [] },
        { id: repeated, cellType: 'raw', source: '', metadata: {}, attachments: {}, outputs: [] },
      ],
    })

    expect(() => foldNotebooks(session.events)).toThrow('reload cell id "repeated" was reused')
  })

  it('rejects a kernel event that does not reference the current document revision', () => {
    const session = Session.create(SessionId('fold-stale-kernel'))
    const notebookId = NotebookId('notebook-1')
    session.append('notebook/open', {
      notebookId,
      path: 'demo.ipynb',
      fileVersion: NotebookFileVersion('v1'),
      nbformatMinor: 5,
      metadata: {},
    })
    session.append('notebook/kernel', {
      notebookId,
      environmentId: NotebookEnvironmentId('env-1'),
      backend: 'memory',
      generation: 1,
      initiator: 'user',
      fileVersion: NotebookFileVersion('v2'),
    })

    expect(() => foldNotebooks(session.events)).toThrow(
      'notebook kernel must reference the current fileVersion',
    )
  })
})
