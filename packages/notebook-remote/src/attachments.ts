/** Notebook-owned authorization for raster references in durable events. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

function imageInEvent(event: SessionEvent, attachmentId: string): ImageAttachmentRef | undefined {
  if (event.type === 'notebook/output') {
    const mutation = (event.data as { mutation?: unknown }).mutation
    if (typeof mutation !== 'object' || mutation === null || Array.isArray(mutation)) return undefined
    const candidate = mutation as { operation?: unknown; output?: unknown; data?: unknown }
    if (candidate.operation === 'append') return imageInOutput(candidate.output, attachmentId)
    if (candidate.operation === 'update-display') return imageInBundle(candidate.data, attachmentId)
    return undefined
  }
  if (event.type === 'notebook/cell') return imageInCell(event.data, attachmentId)
  if (event.type === 'notebook/reload') {
    const cells = (event.data as { cells?: unknown }).cells
    if (!Array.isArray(cells)) return undefined
    for (const cell of cells) {
      const found = imageInCell(cell, attachmentId)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Resolve one raster reference only from Notebook-owned durable event fields. */
export function findNotebookImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}
