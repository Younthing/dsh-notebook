import { describe, expect, it } from 'vitest'
import { CellId } from '@younthing/dsh-notebook-core'
import {
  createIpynb,
  insertIpynbCell,
  IpynbFormatError,
  parseIpynb,
  replaceIpynbCellExecution,
  replaceIpynbCellSource,
  replaceIpynbKernelName,
  serializeIpynb,
} from '../src/ipynb.ts'

function notebook(cells: unknown[], minor = 5, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    cells,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    nbformat: 4,
    nbformat_minor: minor,
  })
}

function codeCell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cell_type: 'code',
    execution_count: null,
    id: 'code-1',
    metadata: {},
    outputs: [],
    source: '',
    ...overrides,
  }
}

describe('nbformat-v4 codec', () => {
  it('normalizes multiline cells and every standard output without losing notebook fields', () => {
    const source = notebook([
      codeCell({
        execution_count: 7,
        metadata: { collapsed: true, extension: { owned: false } },
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['hello', '\n'] },
          {
            output_type: 'display_data',
            data: {
              'text/plain': 'fallback',
              'application/vnd.plotly.v1+json': { data: [{ x: [1], y: [2] }] },
            },
            metadata: { extension: 1 },
          },
          {
            output_type: 'execute_result',
            execution_count: 7,
            data: { 'image/png': ['YW', 'Jj'] },
            metadata: {},
          },
          {
            output_type: 'error',
            ename: 'ValueError',
            evalue: 'boom',
            traceback: ['Traceback line', 'ValueError: boom'],
          },
        ],
        source: ['answer = 6 * 7\n', 'print(answer)'],
        extension_field: ['keep-me'],
      }),
      {
        cell_type: 'markdown',
        id: 'markdown-1',
        metadata: { tags: ['intro'] },
        source: ['![plot](attachment:plot.png)\n'],
        attachments: { 'plot.png': { 'image/png': 'YWJj' } },
      },
      {
        cell_type: 'raw',
        id: 'raw-1',
        metadata: { format: 'text/latex' },
        source: '\\newpage',
      },
    ], 5, { custom_top_level: { preserve: true } })

    const parsed = parseIpynb(source)
    expect(parsed.cells.map(cell => cell.cellType)).toEqual(['code', 'markdown', 'raw'])
    expect(parsed.cells[0]).toMatchObject({
      id: 'code-1',
      source: 'answer = 6 * 7\nprint(answer)',
      executionCount: 7,
      outputs: [
        {
          type: 'stream',
          name: 'stdout',
          text: 'hello\n',
        },
        {
          type: 'display',
          data: {
            'text/plain': { type: 'text', text: 'fallback' },
            'application/vnd.plotly.v1+json': {
              type: 'json',
              value: { data: [{ x: [1], y: [2] }] },
            },
          },
          metadata: { extension: 1 },
        },
        {
          type: 'execute-result',
          data: { 'image/png': { type: 'base64', data: 'YWJj' } },
          metadata: {},
          executionCount: 7,
        },
        {
          type: 'error',
          name: 'ValueError',
          value: 'boom',
          traceback: ['Traceback line', 'ValueError: boom'],
        },
      ],
    })
    expect(parsed.cells[1]?.attachments).toEqual({
      'plot.png': { 'image/png': { type: 'base64', data: 'YWJj' } },
    })

    const serialized = JSON.parse(serializeIpynb(parsed)) as {
      custom_top_level: unknown
      cells: Array<Record<string, unknown>>
    }
    expect(serialized.custom_top_level).toEqual({ preserve: true })
    expect(serialized.cells[0]?.extension_field).toEqual(['keep-me'])
    expect(serialized.cells[0]?.metadata).toEqual({ collapsed: true, extension: { owned: false } })
    expect(serialized.cells[1]?.attachments).toEqual({ 'plot.png': { 'image/png': 'YWJj' } })
    expect(serialized.cells[2]).toMatchObject({ cell_type: 'raw', source: '\\newpage' })
    expect(serializeIpynb(parsed).endsWith('\n')).toBe(true)
  })

  it('assigns deterministic ids to pre-4.5 cells and upgrades them on write', () => {
    const legacy = notebook([
      codeCell({ id: undefined, source: 'print(1)' }),
      { cell_type: 'markdown', metadata: {}, source: 'hello' },
    ], 4)
    const first = parseIpynb(legacy)
    const second = parseIpynb(legacy)
    expect(first.cells.map(cell => cell.id)).toEqual(second.cells.map(cell => cell.id))
    expect(first.cells[0]?.id).toMatch(/^dsh-0-[a-f0-9]{32}$/)
    expect(first.cells[1]?.id).toMatch(/^dsh-1-[a-f0-9]{32}$/)

    const serialized = JSON.parse(serializeIpynb(first)) as {
      nbformat_minor: number
      cells: Array<{ id?: string }>
    }
    expect(serialized.nbformat_minor).toBe(5)
    expect(serialized.cells.map(cell => cell.id)).toEqual(first.cells.map(cell => cell.id))
  })

  it('preserves forward-compatible output records without inventing a standard output', () => {
    const source = notebook([codeCell({
      outputs: [{ output_type: 'future_output', payload: { answer: 42 } }],
    })])
    const parsed = parseIpynb(source)
    expect(parsed.cells[0]?.outputs).toEqual([])
    const serialized = JSON.parse(serializeIpynb(parsed)) as { cells: Array<{ outputs: unknown[] }> }
    expect(serialized.cells[0]?.outputs).toEqual([{
      output_type: 'future_output',
      payload: { answer: 42 },
    }])
  })

  it('preserves own MIME and attachment keys named __proto__', () => {
    const mimeData = Object.fromEntries([['__proto__', 'literal MIME value']])
    const attachments = Object.fromEntries([
      ['__proto__', Object.fromEntries([['text/plain', 'literal attachment value']])],
    ])
    const parsed = parseIpynb(notebook([
      codeCell({
        outputs: [{ output_type: 'display_data', data: mimeData, metadata: {} }],
      }),
      {
        cell_type: 'markdown',
        id: 'markdown-1',
        metadata: {},
        source: 'attachment',
        attachments,
      },
    ]))

    const output = parsed.cells[0]?.outputs[0]
    expect(output?.type).toBe('display')
    if (output?.type !== 'display') throw new Error('expected display output')
    expect(Object.hasOwn(output.data, '__proto__')).toBe(true)
    expect(output.data['__proto__']).toEqual({ type: 'text', text: 'literal MIME value' })
    expect(Object.hasOwn(parsed.cells[1]?.attachments ?? {}, '__proto__')).toBe(true)

    const serialized = JSON.parse(serializeIpynb(parsed)) as {
      cells: Array<{
        attachments?: Record<string, unknown>
        outputs?: Array<{ data: Record<string, unknown> }>
      }>
    }
    expect(Object.hasOwn(serialized.cells[0]?.outputs?.[0]?.data ?? {}, '__proto__')).toBe(true)
    expect(serialized.cells[0]?.outputs?.[0]?.data['__proto__']).toBe('literal MIME value')
    expect(Object.hasOwn(serialized.cells[1]?.attachments ?? {}, '__proto__')).toBe(true)
  })

  it.each([
    ['invalid JSON', '{', 'not valid JSON'],
    ['non-object root', '[]', '$ must be an object'],
    ['wrong major', JSON.stringify({ cells: [], metadata: {}, nbformat: 3, nbformat_minor: 0 }), 'nbformat must equal 4'],
    ['missing cells', JSON.stringify({ metadata: {}, nbformat: 4, nbformat_minor: 5 }), '$.cells must be an array'],
    ['missing 4.5 id', notebook([codeCell({ id: undefined })]), '.id is required'],
    ['invalid id', notebook([codeCell({ id: 'contains space' })]), 'ASCII letters'],
    ['duplicate id', notebook([codeCell(), codeCell()]), 'duplicate notebook cell id'],
    ['unsupported cell', notebook([{ cell_type: 'heading', id: 'heading-1', metadata: {}, source: 'x' }]), 'cell_type is unsupported'],
    ['invalid source', notebook([codeCell({ source: [1] })]), '.source must be a string or string array'],
    ['invalid execution count', notebook([codeCell({ execution_count: -1 })]), 'execution_count must be a non-negative'],
    ['invalid stream', notebook([codeCell({ outputs: [{ output_type: 'stream', name: 'log', text: 'x' }] })]), '.name must be'],
    ['invalid MIME value', notebook([codeCell({ outputs: [{ output_type: 'display_data', data: { 'text/plain': {} }, metadata: {} }] })]), 'must be a string or string array'],
    ['invalid attachment', notebook([{
      cell_type: 'markdown', id: 'md-1', metadata: {}, source: '', attachments: { image: { 'image/png': {} } },
    }]), 'must be a string or string array'],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseIpynb(text)).toThrow(message)
  })

  it('edits and inserts cells without discarding metadata, attachments, or extension fields', () => {
    const parsed = parseIpynb(notebook([
      codeCell({ source: 'old', extension: { keep: true } }),
      {
        cell_type: 'markdown',
        id: 'markdown-1',
        metadata: { tags: ['keep'] },
        source: 'image',
        attachments: { 'x.png': { 'image/png': 'YWJj' } },
      },
    ]))
    const edited = replaceIpynbCellSource(parsed, CellId('code-1'), 'new')
    const inserted = insertIpynbCell(edited, 1, {
      id: CellId('raw-added'),
      cellType: 'raw',
      source: '\\pagebreak',
      metadata: { format: 'text/latex' },
    })
    const raw = JSON.parse(serializeIpynb(inserted)) as { cells: Array<Record<string, unknown>> }
    expect(raw.cells.map(cell => cell.cell_type)).toEqual(['code', 'raw', 'markdown'])
    expect(raw.cells[0]).toMatchObject({ source: 'new', extension: { keep: true } })
    expect(raw.cells[1]).toMatchObject({ id: 'raw-added', metadata: { format: 'text/latex' } })
    expect(raw.cells[2]?.attachments).toEqual({ 'x.png': { 'image/png': 'YWJj' } })

    expect(() => replaceIpynbCellSource(parsed, CellId('missing'), 'x')).toThrow('unknown notebook cell')
    expect(() => insertIpynbCell(parsed, 9, {
      id: CellId('new'), cellType: 'code',
    })).toThrow('out of range')
    expect(() => insertIpynbCell(parsed, 0, {
      id: CellId('code-1'), cellType: 'code',
    })).toThrow('already present')
  })

  it('encodes successful rich output as native JSON instead of double serialization', () => {
    const parsed = parseIpynb(notebook([codeCell()]))
    const executed = replaceIpynbCellExecution(parsed, CellId('code-1'), {
      executionCount: 1,
      mutations: [{
        operation: 'append',
        output: {
          type: 'display',
          data: {
            'application/vnd.plotly.v1+json': {
              type: 'json',
              value: { data: [{ x: [1, 2], y: [3, 4] }] },
            },
          },
          metadata: {},
        },
      }],
      status: 'ok',
    })
    const raw = JSON.parse(serializeIpynb(executed)) as {
      cells: Array<{ execution_count: number; outputs: Array<{ data: Record<string, unknown> }> }>
    }
    expect(raw.cells[0]?.execution_count).toBe(1)
    expect(raw.cells[0]?.outputs[0]?.data['application/vnd.plotly.v1+json']).toEqual({
      data: [{ x: [1, 2], y: [3, 4] }],
    })
  })

  it('encodes terminal errors as nbformat error outputs', () => {
    const parsed = parseIpynb(notebook([codeCell()]))
    const executed = replaceIpynbCellExecution(parsed, CellId('code-1'), {
      executionCount: 8,
      mutations: [
        {
          operation: 'append',
          output: {
            type: 'error',
            name: 'ValueError',
            value: 'boom',
            traceback: ['Traceback line', 'ValueError: boom'],
          },
        },
        {
          operation: 'append',
          output: {
            type: 'display',
            data: { 'image/png': { type: 'base64', data: 'YWJj' } },
            metadata: {},
          },
        },
      ],
      status: 'error',
      error: 'ValueError: boom',
    })
    const raw = JSON.parse(serializeIpynb(executed)) as {
      cells: Array<{ outputs: Array<Record<string, unknown>> }>
    }
    expect(raw.cells[0]?.outputs[0]).toEqual({
      ename: 'ValueError',
      evalue: 'boom',
      output_type: 'error',
      traceback: ['Traceback line', 'ValueError: boom'],
    })
    expect(raw.cells[0]?.outputs[1]).toMatchObject({
      output_type: 'display_data',
      data: { 'image/png': 'YWJj' },
    })
  })

  it('creates a minimal portable notebook and validates mutation preconditions', () => {
    const created = createIpynb(CellId('starter'))
    const raw = JSON.parse(serializeIpynb(created)) as {
      nbformat: number
      nbformat_minor: number
      cells: Array<Record<string, unknown>>
    }
    expect(raw).toMatchObject({ nbformat: 4, nbformat_minor: 5 })
    expect(raw.cells).toEqual([{
      cell_type: 'code',
      execution_count: null,
      id: 'starter',
      metadata: {},
      outputs: [],
      source: '',
    }])
    expect(() => createIpynb(CellId('bad id'))).toThrow(IpynbFormatError)
    expect(() => replaceIpynbCellExecution(created, CellId('starter'), {
      executionCount: 1,
      mutations: [],
      status: 'error',
    })).toThrow('requires non-empty error text')
  })

  it('applies deferred clears and display updates across notebook cells', () => {
    const parsed = parseIpynb(notebook([
      codeCell({
        outputs: [{
          output_type: 'display_data',
          data: { 'text/plain': 'old' },
          metadata: {},
          transient: { display_id: 'shared' },
        }],
      }),
      codeCell({ id: 'code-2' }),
    ]))
    const executed = replaceIpynbCellExecution(parsed, CellId('code-2'), {
      executionCount: 2,
      mutations: [
        { operation: 'append', output: { type: 'stream', name: 'stdout', text: 'discarded' } },
        { operation: 'clear', wait: true },
        {
          operation: 'update-display',
          displayId: 'shared',
          data: { 'text/plain': { type: 'text', text: 'new' } },
          metadata: { updated: true },
        },
        { operation: 'append', output: { type: 'stream', name: 'stdout', text: 'kept' } },
      ],
      status: 'ok',
    })
    expect(executed.cells[0]?.outputs).toMatchObject([{
      type: 'display',
      data: { 'text/plain': { type: 'text', text: 'new' } },
      metadata: { updated: true },
      displayId: 'shared',
    }])
    expect(executed.cells[1]?.outputs).toEqual([
      { type: 'stream', name: 'stdout', text: 'kept' },
    ])
    const raw = JSON.parse(serializeIpynb(executed)) as {
      cells: Array<{ outputs: Array<Record<string, unknown>> }>
    }
    expect(raw.cells[0]?.outputs[0]).toMatchObject({
      data: { 'text/plain': 'new' },
      metadata: { updated: true },
      transient: { display_id: 'shared' },
    })
  })

  it('updates kernelspec metadata and retains the prior count without a terminal reply', () => {
    const parsed = parseIpynb(notebook([codeCell({ execution_count: 4 })]))
    const renamed = replaceIpynbKernelName(parsed, 'pypy3')
    const cancelled = replaceIpynbCellExecution(renamed, CellId('code-1'), {
      executionCount: null,
      mutations: [],
      status: 'cancelled',
      error: 'execution stopped by user',
    })
    const raw = JSON.parse(serializeIpynb(cancelled)) as {
      metadata: { kernelspec: Record<string, unknown> }
      cells: Array<{ execution_count: number; outputs: Array<Record<string, unknown>> }>
    }
    expect(raw.metadata.kernelspec).toMatchObject({
      display_name: 'Python 3',
      language: 'python',
      name: 'pypy3',
    })
    expect(raw.cells[0]?.execution_count).toBe(4)
    expect(raw.cells[0]?.outputs).toEqual([{
      ename: 'Error',
      evalue: 'execution stopped by user',
      output_type: 'error',
      traceback: [],
    }])
    expect(() => replaceIpynbKernelName(parsed, '')).toThrow('kernelName must be non-empty')
  })
})
