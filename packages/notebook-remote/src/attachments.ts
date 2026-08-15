/** Notebook-owned authorization for raster references in open documents. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { NotebookDocument } from '@younthing/dsh-notebook-core'

function imageInBundle(value: unknown, attachmentId: string): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  for (const mimeValue of Object.values(value)) {
    if (typeof mimeValue !== 'object' || mimeValue === null || Array.isArray(mimeValue)) continue
    const candidate = mimeValue as { type?: unknown; attachment?: unknown }
    if (candidate.type !== 'image' || typeof candidate.attachment !== 'object' || candidate.attachment === null) continue
    const ref = candidate.attachment as ImageAttachmentRef
    if (String(ref.attachmentId) === attachmentId) return ref
  }
  return undefined
}

function imageInOutput(value: unknown, attachmentId: string): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const output = value as { type?: unknown; data?: unknown }
  if (output.type !== 'display' && output.type !== 'execute-result') return undefined
  return imageInBundle(output.data, attachmentId)
}

function imageInCell(value: unknown, attachmentId: string): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const cell = value as { attachments?: unknown; outputs?: unknown }
  if (typeof cell.attachments === 'object' && cell.attachments !== null && !Array.isArray(cell.attachments)) {
    for (const bundle of Object.values(cell.attachments)) {
      const found = imageInBundle(bundle, attachmentId)
      if (found !== undefined) return found
    }
  }
  if (Array.isArray(cell.outputs)) {
    for (const output of cell.outputs) {
      const found = imageInOutput(output, attachmentId)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Resolve one raster reference only from documents opened by this plugin process. */
export function findNotebookImage(
  documents: readonly NotebookDocument[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const document of documents) {
    for (const cell of document.cells) {
      const found = imageInCell(cell, attachmentId)
      if (found !== undefined) return found
    }
  }
  return undefined
}
