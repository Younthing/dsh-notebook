/**
 * Host-only notebook kernel provider protocol.
 * @module @younthing/dsh-notebook-core/kernel-types
 */

import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NotebookEnvironmentId } from '@younthing/dsh-notebook-environment/types'
import type { NotebookId } from './brand.ts'
import type { NotebookKernelOutputMutation } from './kernel-output-types.ts'

export type {
  NotebookKernelAppendOutputMutation,
  NotebookKernelBase64MimeValue,
  NotebookKernelCellAttachments,
  NotebookKernelDisplayOutput,
  NotebookKernelExecuteResultOutput,
  NotebookKernelJsonMimeValue,
  NotebookKernelMimeBundle,
  NotebookKernelMimeValue,
  NotebookKernelOutput,
  NotebookKernelOutputMutation,
  NotebookKernelTextMimeValue,
  NotebookKernelUpdateDisplayMutation,
} from './kernel-output-types.ts'

/** One provider event emitted while a code cell executes. */
export type NotebookKernelExecutionEvent =
  | { readonly type: 'output'; readonly mutation: NotebookKernelOutputMutation }
  | { readonly type: 'complete'; readonly status: 'ok'; readonly executionCount: number }
  | { readonly type: 'complete'; readonly status: 'error'; readonly error: string; readonly executionCount: number }

/** Opaque kernel handle returned by a backend and retained process-locally. */
export type NotebookKernelHandle = unknown

/** Request to start one notebook kernel. */
export interface NotebookKernelStartSpec {
  /** Session identity that namespaces this kernel instance. */
  readonly sessionId: SessionId
  /** Target notebook identity. */
  readonly notebookId: NotebookId
  /** Opaque environment whose interpreter and dependencies the provider resolves. */
  readonly environmentId: NotebookEnvironmentId
  /** Registered backend type. */
  readonly backend: string
  /** Resolved kernelspec name, or undefined for a provider-owned default. */
  readonly kernelName?: string
  /** Optional working directory forwarded to the backend. */
  readonly cwd?: string
  /** Resolved per-session execution policy for the provider's execution world. */
  readonly sandboxPolicy: SandboxExecutionPolicy
  /** Cancellation for unpublished backend setup. */
  readonly signal: AbortSignal
}

/** Replaceable kernel backend registered on {@link NotebookService}. */
export interface NotebookKernelBackend {
  /** Stable backend type selected when an environment is attached. */
  readonly type: string
  /** Start one kernel instance for a notebook document. */
  start(spec: NotebookKernelStartSpec): Promise<NotebookKernelHandle>
  /**
   * Execute one code cell and yield ordered output mutations followed by exactly one terminal event.
   * @param handle - live kernel handle from {@link start}.
   * @param source - cell source text.
   * @param signal - required cancellation owned by the service operation.
   * @returns output events followed by exactly one terminal event.
   */
  execute(
    handle: NotebookKernelHandle,
    source: string,
    signal: AbortSignal,
  ): AsyncIterable<NotebookKernelExecutionEvent>
  /**
   * Inspect one name in the kernel namespace.
   * @param handle - live kernel handle from {@link start}.
   * @param name - variable or symbol name to describe.
   * @param signal - required cancellation owned by the service operation.
   * @returns backend-specific inspection text.
   */
  inspect(handle: NotebookKernelHandle, name: string, signal: AbortSignal): Promise<string>
  /**
   * Shut down one kernel instance and release backend resources before the signal aborts.
   * @param handle - live kernel handle from {@link start}.
   * @param signal - teardown deadline notification.
   */
  shutdown(handle: NotebookKernelHandle, signal: AbortSignal): Promise<void>
}
