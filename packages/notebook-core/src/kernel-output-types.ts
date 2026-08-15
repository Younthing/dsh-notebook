/**
 * Host-only kernel output vocabulary before durable attachment admission.
 * @module @younthing/dsh-notebook-core/kernel-output-types
 */

import type {
  NotebookClearOutputMutation,
  NotebookErrorOutput,
  NotebookJsonObject,
  NotebookJsonValue,
  NotebookStreamOutput,
} from './output-types.ts'

/** Decoded textual MIME payload emitted by a kernel provider. */
export interface NotebookKernelTextMimeValue {
  /** Discriminant for textual MIME payloads. */
  readonly type: 'text'
  /** Complete decoded UTF-8 value. */
  readonly text: string
}

/** Parsed structured MIME payload emitted by a kernel provider. */
export interface NotebookKernelJsonMimeValue {
  /** Discriminant for JSON MIME payloads. */
  readonly type: 'json'
  /** Parsed JSON value. */
  readonly value: NotebookJsonValue
}

/** Base64 binary MIME payload awaiting attachment admission when it is raster data. */
export interface NotebookKernelBase64MimeValue {
  /** Discriminant for encoded binary payloads. */
  readonly type: 'base64'
  /** Canonical base64 without a data-URL prefix. */
  readonly data: string
}

/** One kernel-side MIME value before durable storage conversion. */
export type NotebookKernelMimeValue =
  | NotebookKernelTextMimeValue
  | NotebookKernelJsonMimeValue
  | NotebookKernelBase64MimeValue

/** Complete kernel-provided MIME alternatives for one rich output. */
export type NotebookKernelMimeBundle = Readonly<Record<string, NotebookKernelMimeValue>>

/** Markdown attachment name to raw MIME alternatives before durable admission. */
export type NotebookKernelCellAttachments = Readonly<Record<string, NotebookKernelMimeBundle>>

/** A kernel `display_data` record before raster attachments are committed. */
export interface NotebookKernelDisplayOutput {
  /** Output discriminant. */
  readonly type: 'display'
  /** Complete raw MIME alternatives. */
  readonly data: NotebookKernelMimeBundle
  /** Jupyter display metadata retained as JSON. */
  readonly metadata: NotebookJsonObject
  /** Optional Jupyter display identity used by later updates. */
  readonly displayId?: string
}

/** A kernel `execute_result` record before raster attachments are committed. */
export interface NotebookKernelExecuteResultOutput {
  /** Output discriminant. */
  readonly type: 'execute-result'
  /** Complete raw MIME alternatives. */
  readonly data: NotebookKernelMimeBundle
  /** Jupyter result metadata retained as JSON. */
  readonly metadata: NotebookJsonObject
  /** Kernel-provided execution counter, or null when unavailable. */
  readonly executionCount: number | null
  /** Optional Jupyter display identity used by later updates. */
  readonly displayId?: string
}

/** One kernel output before durable attachment conversion. */
export type NotebookKernelOutput =
  | NotebookStreamOutput
  | NotebookKernelDisplayOutput
  | NotebookKernelExecuteResultOutput
  | NotebookErrorOutput

/** Append one kernel output during an execution. */
export interface NotebookKernelAppendOutputMutation {
  /** Mutation discriminant. */
  readonly operation: 'append'
  /** Kernel output awaiting durable conversion. */
  readonly output: NotebookKernelOutput
}

/** Replace rich displays carrying one Jupyter display identity. */
export interface NotebookKernelUpdateDisplayMutation {
  /** Mutation discriminant. */
  readonly operation: 'update-display'
  /** Existing display identity to replace. */
  readonly displayId: string
  /** Replacement raw MIME alternatives. */
  readonly data: NotebookKernelMimeBundle
  /** Replacement Jupyter display metadata. */
  readonly metadata: NotebookJsonObject
}

/** One ordered kernel-side output mutation. */
export type NotebookKernelOutputMutation =
  | NotebookKernelAppendOutputMutation
  | NotebookClearOutputMutation
  | NotebookKernelUpdateDisplayMutation
