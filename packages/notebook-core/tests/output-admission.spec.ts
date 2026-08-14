import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { NotebookKernelOutputMutation } from '../src/kernel-output-types.ts'
import {
  admitNotebookCellContents,
  admitNotebookOutputMutations,
  NotebookOutputAdmissionError,
} from '../src/output-admission.ts'

const PNG = 'iVBORw0KGgo='

function attachmentRef(input: SaveImageAttachment): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('attachment-png'),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
  }
}

function store(overrides: {
  readonly validateImage?: (input: SaveImageAttachment) => Promise<void>
} = {}) {
  const validateImage = vi.fn(overrides.validateImage ?? (() => Promise.resolve()))
  const saveImage = vi.fn((input: SaveImageAttachment) => Promise.resolve(attachmentRef(input)))
  return {
    value: { validateImage, saveImage } as unknown as AttachmentStore,
    validateImage,
    saveImage,
  }
}

function richMutations(): readonly NotebookKernelOutputMutation[] {
  const data = {
    'text/plain': { type: 'text', text: 'chart fallback' },
    'application/json': { type: 'json', value: { answer: 42 } },
    'image/png': { type: 'base64', data: PNG },
  } as const
  return [
    {
      operation: 'append',
      output: { type: 'display', data, metadata: {}, displayId: 'chart-1' },
    },
    {
      operation: 'update-display',
      displayId: 'chart-1',
      data,
      metadata: { changed: true },
    },
  ]
}

describe('kernel output durable admission', () => {
  it('retains full bundles and stores a duplicate raster only once', async () => {
    const attachments = store()
    const admitted = await admitNotebookOutputMutations(
      attachments.value,
      richMutations(),
      1,
      new AbortController().signal,
    )

    expect(attachments.validateImage).toHaveBeenCalledOnce()
    expect(attachments.saveImage).toHaveBeenCalledOnce()
    expect(admitted).toEqual([
      {
        operation: 'append',
        output: {
          type: 'display',
          data: {
            'text/plain': { type: 'text', text: 'chart fallback' },
            'application/json': { type: 'json', value: { answer: 42 } },
            'image/png': { type: 'image', attachment: attachmentRef(attachments.saveImage.mock.calls[0]![0]) },
          },
          metadata: {},
          displayId: 'chart-1',
        },
      },
      {
        operation: 'update-display',
        displayId: 'chart-1',
        data: {
          'text/plain': { type: 'text', text: 'chart fallback' },
          'application/json': { type: 'json', value: { answer: 42 } },
          'image/png': { type: 'image', attachment: attachmentRef(attachments.saveImage.mock.calls[0]![0]) },
        },
        metadata: { changed: true },
      },
    ])
  })

  it('validates the complete image batch before saving any image', async () => {
    let calls = 0
    const attachments = store({
      validateImage: () => {
        calls += 1
        return calls === 2 ? Promise.reject(new Error('invalid second image')) : Promise.resolve()
      },
    })
    const mutations: readonly NotebookKernelOutputMutation[] = [{
      operation: 'append',
      output: {
        type: 'display',
        data: {
          'image/png': { type: 'base64', data: PNG },
          'image/jpeg': { type: 'base64', data: 'YWJjZA==' },
        },
        metadata: {},
      },
    }]

    await expect(admitNotebookOutputMutations(
      attachments.value,
      mutations,
      2,
      new AbortController().signal,
    )).rejects.toThrow('invalid second image')
    expect(attachments.saveImage).not.toHaveBeenCalled()
  })

  it('rejects non-canonical raster base64 and an image-count overflow', async () => {
    const attachments = store()
    const malformed: readonly NotebookKernelOutputMutation[] = [{
      operation: 'append',
      output: {
        type: 'display',
        data: { 'image/png': { type: 'base64', data: 'not base64' } },
        metadata: {},
      },
    }]
    await expect(admitNotebookOutputMutations(
      attachments.value,
      malformed,
      1,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(NotebookOutputAdmissionError)
    await expect(admitNotebookOutputMutations(
      attachments.value,
      richMutations(),
      0,
      new AbortController().signal,
    )).rejects.toThrow('1 distinct raster images; limit is 0')
    expect(attachments.validateImage).not.toHaveBeenCalled()
    expect(attachments.saveImage).not.toHaveBeenCalled()
  })

  it('passes stream, error, and clear mutations without attachment work', async () => {
    const attachments = store()
    const mutations: readonly NotebookKernelOutputMutation[] = [
      { operation: 'append', output: { type: 'stream', name: 'stderr', text: 'warning\n' } },
      { operation: 'clear', wait: true },
      {
        operation: 'append',
        output: { type: 'error', name: 'ValueError', value: 'bad', traceback: ['trace'] },
      },
    ]
    await expect(admitNotebookOutputMutations(
      attachments.value,
      mutations,
      0,
      new AbortController().signal,
    )).resolves.toEqual(mutations)
    expect(attachments.validateImage).not.toHaveBeenCalled()
    expect(attachments.saveImage).not.toHaveBeenCalled()
  })

  it('preserves an own MIME key named __proto__ during admission', async () => {
    const attachments = store()
    const data = Object.fromEntries([
      ['__proto__', { type: 'text' as const, text: 'literal value' }],
    ])
    const admitted = await admitNotebookOutputMutations(attachments.value, [{
      operation: 'append',
      output: { type: 'display', data, metadata: {} },
    }], 0, new AbortController().signal)

    const mutation = admitted[0]
    expect(mutation?.operation).toBe('append')
    if (mutation?.operation !== 'append' || mutation.output.type !== 'display') {
      throw new Error('expected an appended display output')
    }
    expect(Object.hasOwn(mutation.output.data, '__proto__')).toBe(true)
    expect(mutation.output.data['__proto__']).toEqual({ type: 'text', text: 'literal value' })
  })

  it('admits imported outputs and Markdown attachments as one deduplicated batch', async () => {
    const attachments = store()
    const admitted = await admitNotebookCellContents(attachments.value, [
      {
        outputs: [{
          type: 'display',
          data: { 'image/png': { type: 'base64', data: PNG } },
          metadata: {},
        }],
        attachments: {},
      },
      {
        outputs: [],
        attachments: {
          'plot.png': {
            'image/png': { type: 'base64', data: PNG },
            'text/plain': { type: 'text', text: 'plot' },
          },
        },
      },
    ], 1, new AbortController().signal)

    expect(attachments.validateImage).toHaveBeenCalledOnce()
    expect(attachments.saveImage).toHaveBeenCalledOnce()
    const reference = attachmentRef(attachments.saveImage.mock.calls[0]![0])
    expect(admitted).toEqual([
      {
        outputs: [{
          type: 'display',
          data: { 'image/png': { type: 'image', attachment: reference } },
          metadata: {},
        }],
        attachments: {},
      },
      {
        outputs: [],
        attachments: {
          'plot.png': {
            'image/png': { type: 'image', attachment: reference },
            'text/plain': { type: 'text', text: 'plot' },
          },
        },
      },
    ])
  })

  it('rejects malformed non-raster base64 before durable publication', async () => {
    const attachments = store()
    await expect(admitNotebookCellContents(attachments.value, [{
      outputs: [{
        type: 'display',
        data: { 'application/pdf': { type: 'base64', data: 'not base64' } },
        metadata: {},
      }],
      attachments: {},
    }], 0, new AbortController().signal)).rejects.toThrow('application/pdf notebook output is not canonical base64')
  })
})
