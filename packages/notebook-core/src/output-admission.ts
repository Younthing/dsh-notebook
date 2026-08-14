/** Durable admission of kernel MIME bundles and raster attachments. */

import { Buffer } from 'node:buffer'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {
  NotebookKernelCellAttachments,
  NotebookKernelMimeBundle,
  NotebookKernelOutput,
  NotebookKernelOutputMutation,
} from './kernel-output-types.ts'
import type {
  NotebookCellAttachments,
  NotebookMimeBundle,
  NotebookOutput,
  NotebookOutputMutation,
} from './output-types.ts'

interface PendingImage {
  readonly key: string
  readonly mediaType: ImageMediaType
  readonly data: Uint8Array
}

/** Raw imported state for one parsed nbformat cell. */
export interface NotebookKernelCellContent {
  /** Standard code-cell outputs parsed from the file. */
  readonly outputs: readonly NotebookKernelOutput[]
  /** Markdown attachment bundles parsed from the file. */
  readonly attachments: NotebookKernelCellAttachments
}

/** Durable imported state for one cell after raster admission. */
export interface NotebookCellContent {
  /** Standard code-cell outputs with durable raster references. */
  readonly outputs: readonly NotebookOutput[]
  /** Markdown attachment bundles with durable raster references. */
  readonly attachments: NotebookCellAttachments
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Invalid kernel raster data or execution image admission. */
export class NotebookOutputAdmissionError extends Error {
  /**
   * @param message - actionable invalid output detail.
   */
  constructor(message: string) {
    super(message)
    this.name = 'NotebookOutputAdmissionError'
  }
}

/**
 * Validate every raster first, then store each unique image and convert one execution's mutations.
 * @param attachments - authoritative image validator and durable store.
 * @param mutations - ordered kernel mutations from one terminal execution.
 * @param maxImages - maximum distinct raster payloads admitted for the execution.
 * @param signal - cancellation checked between validation and storage operations.
 * @returns durable mutations whose raster values contain attachment references.
 */
export async function admitNotebookOutputMutations(
  attachments: AttachmentStore,
  mutations: readonly NotebookKernelOutputMutation[],
  maxImages: number,
  signal: AbortSignal,
): Promise<readonly NotebookOutputMutation[]> {
  signal.throwIfAborted()
  const pending = collectImages(mutations)
  const references = await admitImages(attachments, pending, maxImages, 'execution', signal)
  return mutations.map(mutation => durableMutation(mutation, references))
}

/**
 * Admit every raster referenced by imported notebook cells as one bounded batch.
 * @param attachments - authoritative image validator and durable store.
 * @param cells - parsed code outputs and Markdown attachments in document order.
 * @param maxImages - maximum distinct raster payloads admitted for the document.
 * @param signal - cancellation checked between validation and storage operations.
 * @returns cell state whose raster values contain durable attachment references.
 */
export async function admitNotebookCellContents(
  attachments: AttachmentStore,
  cells: readonly NotebookKernelCellContent[],
  maxImages: number,
  signal: AbortSignal,
): Promise<readonly NotebookCellContent[]> {
  signal.throwIfAborted()
  const pending = new Map<string, PendingImage>()
  for (const cell of cells) {
    for (const output of cell.outputs) collectOutputImages(output, pending)
    for (const bundle of Object.values(cell.attachments)) collectBundleImages(bundle, pending)
  }
  const references = await admitImages(attachments, pending, maxImages, 'document', signal)
  return cells.map(cell => ({
    outputs: cell.outputs.map(output => durableOutput(output, references)),
    attachments: durableAttachments(cell.attachments, references),
  }))
}

async function admitImages(
  attachments: AttachmentStore,
  pending: ReadonlyMap<string, PendingImage>,
  maxImages: number,
  subject: 'document' | 'execution',
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ImageAttachmentRef>> {
  if (!Number.isSafeInteger(maxImages) || maxImages < 0) {
    throw new NotebookOutputAdmissionError('notebook maxImages must be a non-negative safe integer')
  }
  if (pending.size > maxImages) {
    throw new NotebookOutputAdmissionError(
      `notebook ${subject} contains ${String(pending.size)} distinct raster images; limit is ${String(maxImages)}`,
    )
  }
  for (const image of pending.values()) {
    signal.throwIfAborted()
    await attachments.validateImage(image)
  }
  const references = new Map<string, ImageAttachmentRef>()
  for (const image of pending.values()) {
    signal.throwIfAborted()
    references.set(image.key, await attachments.saveImage(image))
  }
  return references
}

function collectImages(mutations: readonly NotebookKernelOutputMutation[]): Map<string, PendingImage> {
  const images = new Map<string, PendingImage>()
  for (const mutation of mutations) {
    switch (mutation.operation) {
      case 'append':
        collectOutputImages(mutation.output, images)
        break
      case 'update-display':
        collectBundleImages(mutation.data, images)
        break
      case 'clear':
        break
      default:
        assertNever(mutation)
    }
  }
  return images
}

function collectOutputImages(output: NotebookKernelOutput, images: Map<string, PendingImage>): void {
  switch (output.type) {
    case 'display':
    case 'execute-result':
      collectBundleImages(output.data, images)
      return
    case 'stream':
    case 'error':
      return
    default:
      assertNever(output)
  }
}

function collectBundleImages(bundle: NotebookKernelMimeBundle, images: Map<string, PendingImage>): void {
  for (const [mimeType, value] of Object.entries(bundle)) {
    const mediaType = imageMediaType(mimeType)
    if (value.type === 'base64') assertCanonicalBase64(value.data, mimeType)
    if (mediaType === undefined) continue
    if (value.type !== 'base64') {
      throw new NotebookOutputAdmissionError(`${mediaType} notebook output must be base64 encoded`)
    }
    const key = `${mediaType}\0${value.data}`
    if (images.has(key)) continue
    images.set(key, { key, mediaType, data: decodeBase64(value.data, mediaType) })
  }
}

function decodeBase64(value: string, mediaType: ImageMediaType): Uint8Array {
  assertCanonicalBase64(value, mediaType)
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function assertCanonicalBase64(value: string, label: string): void {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new NotebookOutputAdmissionError(`${label} notebook output is not canonical base64`)
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) {
    throw new NotebookOutputAdmissionError(`${label} notebook output is not canonical base64`)
  }
}

function durableMutation(
  mutation: NotebookKernelOutputMutation,
  references: ReadonlyMap<string, ImageAttachmentRef>,
): NotebookOutputMutation {
  switch (mutation.operation) {
    case 'append':
      return { operation: 'append', output: durableOutput(mutation.output, references) }
    case 'clear':
      return mutation
    case 'update-display':
      return {
        operation: 'update-display',
        displayId: mutation.displayId,
        data: durableBundle(mutation.data, references),
        metadata: mutation.metadata,
      }
    default:
      return assertNever(mutation)
  }
}

function durableOutput(
  output: NotebookKernelOutput,
  references: ReadonlyMap<string, ImageAttachmentRef>,
): NotebookOutput {
  switch (output.type) {
    case 'stream':
    case 'error':
      return output
    case 'display':
      return {
        type: 'display',
        data: durableBundle(output.data, references),
        metadata: output.metadata,
        ...(output.displayId === undefined ? {} : { displayId: output.displayId }),
      }
    case 'execute-result':
      return {
        type: 'execute-result',
        data: durableBundle(output.data, references),
        metadata: output.metadata,
        executionCount: output.executionCount,
        ...(output.displayId === undefined ? {} : { displayId: output.displayId }),
      }
    default:
      return assertNever(output)
  }
}

function durableBundle(
  bundle: NotebookKernelMimeBundle,
  references: ReadonlyMap<string, ImageAttachmentRef>,
): NotebookMimeBundle {
  const result: Array<[string, NotebookMimeBundle[string]]> = []
  for (const [mimeType, value] of Object.entries(bundle)) {
    const mediaType = imageMediaType(mimeType)
    if (mediaType === undefined) {
      result.push([mimeType, value])
      continue
    }
    if (value.type !== 'base64') {
      throw new NotebookOutputAdmissionError(`${mediaType} notebook output must be base64 encoded`)
    }
    const reference = references.get(`${mediaType}\0${value.data}`)
    if (reference === undefined) {
      throw new NotebookOutputAdmissionError(`${mediaType} notebook output was not admitted`)
    }
    result.push([mimeType, { type: 'image', attachment: reference }])
  }
  return Object.fromEntries(result)
}

function durableAttachments(
  attachments: NotebookKernelCellAttachments,
  references: ReadonlyMap<string, ImageAttachmentRef>,
): NotebookCellAttachments {
  const result: Array<[string, NotebookMimeBundle]> = []
  for (const [name, bundle] of Object.entries(attachments)) {
    result.push([name, durableBundle(bundle, references)])
  }
  return Object.fromEntries(result)
}

function imageMediaType(value: string): ImageMediaType | undefined {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      return undefined
  }
}

function assertNever(value: never): never {
  throw new NotebookOutputAdmissionError(`unsupported notebook output value ${JSON.stringify(value)}`)
}
