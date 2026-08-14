/**
 * Browser-safe durable notebook output vocabulary.
 * @module @deepseek-ai/dsh-notebook-core/output-types
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** JSON value accepted in notebook metadata and structured MIME payloads. */
export type NotebookJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NotebookJsonValue[]
  | NotebookJsonObject

/** JSON object accepted in notebook metadata and structured MIME payloads. */
export interface NotebookJsonObject {
  readonly [key: string]: NotebookJsonValue
}

/** UTF-8 MIME payload retained directly in the session log. */
export interface NotebookTextMimeValue {
  /** Discriminant for textual MIME payloads. */
  readonly type: 'text'
  /** Complete decoded UTF-8 value. */
  readonly text: string
}

/** Structured JSON MIME payload retained without stringifying it twice. */
export interface NotebookJsonMimeValue {
  /** Discriminant for JSON MIME payloads. */
  readonly type: 'json'
  /** Parsed JSON value. */
  readonly value: NotebookJsonValue
}

/** Raster MIME payload stored outside the session log. */
export interface NotebookImageMimeValue {
  /** Discriminant shared with other durable image content. */
  readonly type: 'image'
  /** Immutable attachment reference authorized by the owning session. */
  readonly attachment: ImageAttachmentRef
}

/** Base64 payload for a non-raster binary MIME type without a dedicated store. */
export interface NotebookBase64MimeValue {
  /** Discriminant for bounded inline binary payloads. */
  readonly type: 'base64'
  /** Canonical base64 without a data-URL prefix. */
  readonly data: string
}

/** One value in a rich notebook MIME bundle. */
export type NotebookMimeValue =
  | NotebookTextMimeValue
  | NotebookJsonMimeValue
  | NotebookImageMimeValue
  | NotebookBase64MimeValue

/** Complete MIME alternatives for one rich output. */
export type NotebookMimeBundle = Readonly<Record<string, NotebookMimeValue>>

/** Markdown attachment name to complete MIME alternatives. */
export type NotebookCellAttachments = Readonly<Record<string, NotebookMimeBundle>>

/** A stdout or stderr record. Adjacent records are not implicitly merged. */
export interface NotebookStreamOutput {
  /** Output discriminant. */
  readonly type: 'stream'
  /** Kernel stream identity. */
  readonly name: 'stdout' | 'stderr'
  /** Decoded stream text. */
  readonly text: string
}

/** A `display_data` record with every MIME alternative retained. */
export interface NotebookDisplayOutput {
  /** Output discriminant. */
  readonly type: 'display'
  /** Complete MIME alternatives supplied by the kernel. */
  readonly data: NotebookMimeBundle
  /** Jupyter display metadata retained as JSON. */
  readonly metadata: NotebookJsonObject
  /** Optional Jupyter display identity used by later updates. */
  readonly displayId?: string
}

/** An `execute_result` record with every MIME alternative retained. */
export interface NotebookExecuteResultOutput {
  /** Output discriminant. */
  readonly type: 'execute-result'
  /** Complete MIME alternatives supplied by the kernel. */
  readonly data: NotebookMimeBundle
  /** Jupyter result metadata retained as JSON. */
  readonly metadata: NotebookJsonObject
  /** Kernel-provided execution counter, or null when unavailable. */
  readonly executionCount: number | null
  /** Optional Jupyter display identity used by later updates. */
  readonly displayId?: string
}

/** A structured kernel exception. */
export interface NotebookErrorOutput {
  /** Output discriminant. */
  readonly type: 'error'
  /** Exception class or provider error name. */
  readonly name: string
  /** Human-readable exception value. */
  readonly value: string
  /** Provider-formatted traceback lines in display order. */
  readonly traceback: readonly string[]
}

/** One durable nbformat-compatible output record. */
export type NotebookOutput =
  | NotebookStreamOutput
  | NotebookDisplayOutput
  | NotebookExecuteResultOutput
  | NotebookErrorOutput

/** Append one output record to the executing cell. */
export interface NotebookAppendOutputMutation {
  /** Mutation discriminant. */
  readonly operation: 'append'
  /** Durable output to append. */
  readonly output: NotebookOutput
}

/** Clear the executing cell's outputs now or before its next append. */
export interface NotebookClearOutputMutation {
  /** Mutation discriminant. */
  readonly operation: 'clear'
  /** Defer clearing until the next append, matching Jupyter `clear_output(wait=true)`. */
  readonly wait: boolean
}

/** Replace rich outputs carrying one Jupyter display identity. */
export interface NotebookUpdateDisplayMutation {
  /** Mutation discriminant. */
  readonly operation: 'update-display'
  /** Existing display identity to replace wherever it appears in the notebook. */
  readonly displayId: string
  /** Replacement MIME alternatives. */
  readonly data: NotebookMimeBundle
  /** Replacement Jupyter display metadata. */
  readonly metadata: NotebookJsonObject
}

/** One ordered output mutation emitted during an execution. */
export type NotebookOutputMutation =
  | NotebookAppendOutputMutation
  | NotebookClearOutputMutation
  | NotebookUpdateDisplayMutation
