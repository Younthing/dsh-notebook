import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type {
  NotebookDocument,
  NotebookImageMimeValue,
  NotebookJsonObject,
} from '@deepseek-ai/dsh-notebook-core/types'
import {
  boundNotebookText,
  renderNotebookDocument,
  renderNotebookExecution,
  renderNotebookJson,
} from '../src/render.ts'

function notebookId(value: string): NotebookDocument['id'] {
  return value as NotebookDocument['id']
}

function cellId(value: string): NotebookDocument['cells'][number]['id'] {
  return value as NotebookDocument['cells'][number]['id']
}

function document(overrides: Partial<NotebookDocument> = {}, detached = false): NotebookDocument {
  return {
    id: notebookId('notebook-test'),
    path: 'analysis.ipynb',
    ...detached ? {} : { kernel: {
      environmentId: 'environment-test' as NonNullable<NotebookDocument['kernel']>['environmentId'],
      backend: 'memory',
      kernelName: 'python3',
      generation: 1,
    } },
    fileVersion: 'version-1' as NotebookDocument['fileVersion'],
    nbformatMinor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [],
    ...overrides,
  }
}

describe('bounded notebook rendering', () => {
  it('preserves an exact complete-result limit', () => {
    const text = '12345678'
    expect(boundNotebookText(text, Buffer.byteLength(text))).toBe(text)
  })

  it('cuts multibyte text without exceeding the inclusive byte cap', () => {
    const rendered = boundNotebookText('😀'.repeat(100), 64)
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(64)
    expect(rendered).not.toContain('�')
    expect(rendered).toContain('[notebook content truncated]')
  })

  it('bounds operation acknowledgements without serializing unreached fields', () => {
    const lateRead = vi.fn(() => 'must not be read')
    const value: Record<string, unknown> = { notebookId: '😀'.repeat(1_000) }
    Object.defineProperty(value, 'late', { enumerable: true, get: lateRead })
    const rendered = renderNotebookJson(value as NotebookJsonObject, 128)
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(128)
    expect(rendered).toContain('[notebook content truncated]')
    expect(lateRead).not.toHaveBeenCalled()
  })

  it('renders raw cells, metadata, attachments, and every structured output kind', () => {
    type AttachmentId = NotebookImageMimeValue['attachment']['attachmentId']
    const rendered = renderNotebookDocument(document({
      cells: [
        {
          id: cellId('raw-cell'),
          cellType: 'raw',
          source: 'literal raw source',
          metadata: { format: 'text/x-example' },
          attachments: {},
          outputs: [],
        },
        {
          id: cellId('code-cell'),
          cellType: 'code',
          source: 'display(value)',
          metadata: { tags: ['model-visible'] },
          attachments: {
            diagram: {
              'text/plain': { type: 'text', text: 'attachment text' },
            },
          },
          status: 'error',
          executionCount: 4,
          outputs: [
            { type: 'stream', name: 'stdout', text: 'stream text' },
            {
              type: 'display',
              displayId: 'display-1',
              metadata: { expanded: true },
              data: {
                'application/vnd.plotly.v1+json': {
                  type: 'json',
                  value: { data: [{ x: [1, 2] }] },
                },
                'image/png': {
                  type: 'image',
                  attachment: {
                    attachmentId: 'attachment-1' as AttachmentId,
                    mediaType: 'image/png',
                    bytes: 12,
                    width: 2,
                    height: 3,
                    name: 'plot.png',
                  },
                },
                'application/pdf': { type: 'base64', data: 'cGRm' },
              },
            },
            {
              type: 'execute-result',
              data: { 'text/plain': { type: 'text', text: 'result text' } },
              metadata: {},
              executionCount: 4,
            },
            {
              type: 'error',
              name: 'ValueError',
              value: 'boom',
              traceback: ['Traceback line', 'ValueError: boom'],
            },
          ],
        },
      ],
    }), 8_192)

    expect(rendered).toContain('#0 raw id="raw-cell"')
    expect(rendered).toContain('environment="environment-test" backend="memory"')
    expect(rendered).toContain('literal raw source')
    expect(rendered).toContain('attachment "diagram"')
    expect(rendered).toContain('[stream stdout]')
    expect(rendered).toContain('[mime "application/vnd.plotly.v1+json"]')
    expect(rendered).toContain('{"data":[{"x":[1,2]}]}')
    expect(rendered).toContain('"attachmentId":"attachment-1"')
    expect(rendered).toContain('[mime "application/pdf"]')
    expect(rendered).toContain('cGRm')
    expect(rendered).toContain('[execute-result count=4]')
    expect(rendered).toContain('[error "ValueError"]')
    expect(rendered).toContain('ValueError: boom')
  })

  it('renders detached documents without hiding editable cells', () => {
    const rendered = renderNotebookDocument(document({
      cells: [{
        id: cellId('detached-cell'),
        cellType: 'markdown',
        source: '# Editable while detached',
        metadata: {},
        attachments: {},
        outputs: [],
      }],
    }, true), 512)
    expect(rendered).toContain('environment=detached')
    expect(rendered).toContain('# Editable while detached')
  })

  it('stops traversing later cell fields after source reaches the complete byte cap', () => {
    const lateRead = vi.fn(() => 'must not be read')
    const metadata: Record<string, unknown> = {}
    Object.defineProperty(metadata, 'late', { enumerable: true, get: lateRead })
    const rendered = renderNotebookDocument(document({
      cells: [{
        id: cellId('large-cell'),
        cellType: 'code',
        source: '😀'.repeat(1_000),
        metadata: metadata as NotebookJsonObject,
        attachments: {},
        outputs: [],
      }],
    }), 256)
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(256)
    expect(rendered).toContain('[notebook content truncated]')
    expect(lateRead).not.toHaveBeenCalled()
    expect(rendered).toContain('large-cell')
  })

  it('retains terminal failure status, execution count, and structured errors', () => {
    const rendered = renderNotebookExecution({
      status: 'error',
      executionCount: 7,
      error: 'division by zero',
      outputs: [{
        type: 'error',
        name: 'ZeroDivisionError',
        value: 'division by zero',
        traceback: ['ZeroDivisionError: division by zero'],
      }],
    }, 512)
    expect(rendered).toContain('Notebook cell failed. executionCount=7')
    expect(rendered).toContain('error: division by zero')
    expect(rendered).toContain('[error "ZeroDivisionError"]')
    expect(rendered).toContain('ZeroDivisionError: division by zero')
  })

  it('renders cancellation as a distinct terminal outcome', () => {
    expect(renderNotebookExecution({
      status: 'cancelled',
      executionCount: null,
      error: 'stopped by user',
      outputs: [],
    }, 256)).toContain('Notebook cell was cancelled. executionCount=null')
  })
})
