/** Shared Notebook MIME value conversions. @module @deepseek-ai/dsh-tool-notebook/mime */

import type { NotebookMimeValue } from '@deepseek-ai/dsh-notebook-core/types'

type NotebookImageAttachment = Extract<NotebookMimeValue, { readonly type: 'image' }>['attachment']
type NotebookImageAttachmentJson = Readonly<{
  attachmentId: NotebookImageAttachment['attachmentId']
  mediaType: NotebookImageAttachment['mediaType']
  bytes: number
  width: number
  height: number
  name?: string
}>

/**
 * Convert an image attachment reference to its path-free JSON representation.
 * @param attachment - immutable Notebook image attachment metadata.
 * @returns JSON fields shared by structured and textual tool results.
 */
export function notebookImageAttachmentJson(attachment: NotebookImageAttachment): NotebookImageAttachmentJson {
  return {
    attachmentId: attachment.attachmentId,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    ...attachment.name === undefined ? {} : { name: attachment.name },
  }
}
