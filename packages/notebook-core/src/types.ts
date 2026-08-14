/**
 * Browser-safe notebook documents and durable session-event types.
 * @module @deepseek-ai/dsh-notebook-core/types
 */

import type {} from '@deepseek-ai/dsh-session/types'
import type { NotebookEnvironmentId } from '@deepseek-ai/dsh-notebook-environment/types'
import type { CellId, ExecutionId, NotebookFileVersion, NotebookId } from './brand.ts'
import type {
  NotebookCellAttachments,
  NotebookJsonObject,
  NotebookOutput,
  NotebookOutputMutation,
} from './output-types.ts'

export type { CellId, ExecutionId, NotebookFileVersion, NotebookId } from './brand.ts'
export type { NotebookEnvironmentId } from '@deepseek-ai/dsh-notebook-environment/types'
export type {
  NotebookAppendOutputMutation,
  NotebookBase64MimeValue,
  NotebookCellAttachments,
  NotebookClearOutputMutation,
  NotebookDisplayOutput,
  NotebookErrorOutput,
  NotebookExecuteResultOutput,
  NotebookImageMimeValue,
  NotebookJsonMimeValue,
  NotebookJsonObject,
  NotebookJsonValue,
  NotebookMimeBundle,
  NotebookMimeValue,
  NotebookOutput,
  NotebookOutputMutation,
  NotebookStreamOutput,
  NotebookTextMimeValue,
  NotebookUpdateDisplayMutation,
} from './output-types.ts'

/** Supported nbformat cell kinds. */
export type CellType = 'code' | 'markdown' | 'raw'

/** Stable notebook service failure categories exposed across RPC clients. */
export type NotebookErrorCode =
  | 'DUPLICATE_BACKEND'
  | 'DISCOVERY_CURSOR_STALE'
  | 'DISCOVERY_UNAVAILABLE'
  | 'ENVIRONMENT_REQUIRED'
  | 'KERNEL_UNAVAILABLE'
  | 'NO_BACKEND'
  | 'NOT_FOUND'
  | 'NOT_CODE_CELL'
  | 'OUTPUT_LIMIT'
  | 'SERVICE_DISPOSING'
  | 'SESSION_DISPOSED'

/** Stable notebook persistence failure categories exposed across RPC clients. */
export type NotebookPersistenceErrorCode =
  | 'ALREADY_EXISTS'
  | 'DOCUMENT_TOO_LARGE'
  | 'INVALID_DOCUMENT'
  | 'INVALID_EXTENSION'
  | 'INVALID_LIMIT'
  | 'INVALID_PATH'
  | 'INVALID_UTF8'
  | 'NOT_REGULAR_FILE'
  | 'NOT_FOUND'
  | 'OUTSIDE_WORKSPACE'
  | 'WRITE_CONFLICT'

/** One durable kernel selection attached to a notebook document. */
export interface NotebookKernelSelection {
  /** Opaque environment selected by the environment provider. */
  readonly environmentId: NotebookEnvironmentId
  /** Registered Notebook kernel backend type. */
  readonly backend: string
  /** Resolved kernelspec name, when the backend uses one. */
  readonly kernelName?: string
  /** Monotonic count of successfully published kernel starts. */
  readonly generation: number
}

/** Process-local status of a document's selected kernel. */
export type NotebookKernelRuntimeStatus =
  | { readonly status: 'detached' }
  | { readonly status: 'starting' | 'ready' | 'running' | 'stopped'; readonly environmentId: NotebookEnvironmentId }
  | { readonly status: 'failed'; readonly environmentId: NotebookEnvironmentId; readonly message: string }

/** One `.ipynb` file discovered under a workspace root. */
export interface NotebookDiscoveryEntry {
  /** Normalized workspace-relative POSIX path accepted by open. */
  readonly path: string
  /** File byte size when the filesystem provider reports it cheaply. */
  readonly size?: number
}

/** One bounded page of workspace notebook discovery. */
export interface NotebookDiscoveryPage {
  /** Canonically deduplicated notebook files in stable traversal order. */
  readonly items: readonly NotebookDiscoveryEntry[]
  /** Last returned path when another page exists. */
  readonly nextAfter?: string
  /** Whether an unreadable or depth-limited subtree was omitted. */
  readonly partial: boolean
}

/** Options accepted by `NotebookService.discoverWorkspace`. */
export interface NotebookDiscoveryOptions {
  /** Exact final path returned by the preceding page. */
  readonly after?: string
  /** Cancellation for root resolution and directory listing. */
  readonly signal?: AbortSignal
}

/** Terminal status for one kernel execution. */
export type NotebookExecutionStatus = 'ok' | 'error' | 'cancelled'

/** Terminal or in-flight execution status folded onto one cell. */
export type NotebookCellStatus = 'running' | NotebookExecutionStatus

/** One cell within a notebook document. */
export interface NotebookCell {
  /** Stable cell identity within the owning notebook. */
  readonly id: CellId
  /** Cell kind controlling editor and execution semantics. */
  readonly cellType: CellType
  /** Current cell source text. */
  source: string
  /** Cell metadata retained from nbformat. */
  readonly metadata: NotebookJsonObject
  /** Markdown attachment bundles keyed by attachment name. */
  readonly attachments: NotebookCellAttachments
  /** Outputs produced by the latest execution, including an in-flight run. */
  outputs: readonly NotebookOutput[]
  /** Non-negative execution count after at least one completed run (`In [n]`). */
  executionCount?: number
  /** Latest execution status; absent when the cell has never started. */
  status?: NotebookCellStatus
  /** Latest terminal failure or cancellation text. */
  error?: string
}

/** One complete cell value carried by a durable document snapshot. */
export interface NotebookCellSnapshot {
  /** Stable cell identity within the owning notebook. */
  readonly id: CellId
  /** Native nbformat cell kind. */
  readonly cellType: CellType
  /** Complete cell source text. */
  readonly source: string
  /** Cell metadata retained from nbformat. */
  readonly metadata: NotebookJsonObject
  /** Markdown attachment bundles keyed by attachment name. */
  readonly attachments: NotebookCellAttachments
  /** Imported outputs for a code cell. */
  readonly outputs: readonly NotebookOutput[]
  /** Imported execution count for a code cell. */
  readonly executionCount?: number
}

/** Workspace-backed notebook document reconstructed from the session log. */
export interface NotebookDocument {
  /** Registry-minted notebook identity. */
  readonly id: NotebookId
  /** Workspace-relative path represented by the document. */
  readonly path: string
  /** Last successfully started kernel selection; absent until an environment is attached. */
  readonly kernel?: NotebookKernelSelection
  /** Latest committed filesystem revision for compare-and-swap writes. */
  readonly fileVersion: NotebookFileVersion
  /** Parsed nbformat minor version. */
  readonly nbformatMinor: number
  /** Notebook metadata retained from nbformat. */
  readonly metadata: NotebookJsonObject
  /** Ordered cells from index zero upward. */
  readonly cells: readonly NotebookCell[]
}

/** Payload for `notebook/open`. */
export interface NotebookOpenEvent {
  /** Opened notebook identity. */
  readonly notebookId: NotebookId
  /** Workspace-relative path opened into the session log. */
  readonly path: string
  /** Filesystem revision observed or created before publication. */
  readonly fileVersion: NotebookFileVersion
  /** Parsed nbformat minor version. */
  readonly nbformatMinor: number
  /** Notebook metadata retained from nbformat. */
  readonly metadata: NotebookJsonObject
}

/** Payload for `notebook/cell`. */
export interface NotebookCellEvent {
  /** Target notebook identity. */
  readonly notebookId: NotebookId
  /** Affected cell identity. */
  readonly cellId: CellId
  /** Cell kind for create operations. */
  readonly cellType: CellType
  /** Cell source after the mutation. */
  readonly source: string
  /** Zero-based insertion index for create operations. */
  readonly index: number
  /** Whether the event creates or updates a cell. */
  readonly operation: 'create' | 'update'
  /** Imported execution count for a created code cell. */
  readonly executionCount?: number
  /** Imported outputs for a created code cell. */
  readonly outputs?: readonly NotebookOutput[]
  /** Cell metadata for a create operation. */
  readonly metadata?: NotebookJsonObject
  /** Markdown attachments for a create operation. */
  readonly attachments?: NotebookCellAttachments
  /** Filesystem revision committed by this mutation. */
  readonly fileVersion: NotebookFileVersion
}

/** Payload for `notebook/execute`. */
export interface NotebookExecuteEvent {
  /** Target notebook identity. */
  readonly notebookId: NotebookId
  /** Executed cell identity. */
  readonly cellId: CellId
  /** Minted execution identity correlating output mutations. */
  readonly executionId: ExecutionId
  /** Whether an agent or a human-initiated path started the run. */
  readonly initiator: 'agent' | 'user'
}

/** Payload for `notebook/output`. */
export interface NotebookOutputEvent {
  /** Target notebook identity. */
  readonly notebookId: NotebookId
  /** Source cell identity. */
  readonly cellId: CellId
  /** Owning execution identity. */
  readonly executionId: ExecutionId
  /** Ordered append, clear, or display-update mutation. */
  readonly mutation: NotebookOutputMutation
}

/** Payload for `notebook/execute-end`. */
export interface NotebookExecuteEndEvent {
  /** Target notebook identity. */
  readonly notebookId: NotebookId
  /** Source cell identity. */
  readonly cellId: CellId
  /** Completed execution identity. */
  readonly executionId: ExecutionId
  /** Terminal execution status. */
  readonly status: NotebookExecutionStatus
  /** Kernel-wide counter, or null when cancellation/transport failure prevented a terminal reply. */
  readonly executionCount: number | null
  /** Failure or cancellation text when status is not `ok`. */
  readonly error?: string
  /** Filesystem revision committed before the terminal event. */
  readonly fileVersion: NotebookFileVersion
}

/** Payload for `notebook/kernel`. */
export interface NotebookKernelEvent {
  /** Target notebook identity. */
  readonly notebookId: NotebookId
  /** Opaque environment used by this successful kernel start. */
  readonly environmentId: NotebookEnvironmentId
  /** Registered backend that owns the live kernel. */
  readonly backend: string
  /** Resolved kernelspec name, when present. */
  readonly kernelName?: string
  /** Strictly increasing successful-start generation. */
  readonly generation: number
  /** Human or agent path that caused the start or recovery. */
  readonly initiator: 'agent' | 'user'
  /** Current filesystem revision; kernel selection does not modify document content. */
  readonly fileVersion: NotebookFileVersion
}

/** Payload for `notebook/reload`. */
export interface NotebookReloadEvent {
  /** Target notebook identity retained across the reload. */
  readonly notebookId: NotebookId
  /** Human or agent path that accepted the external file revision. */
  readonly initiator: 'agent' | 'user'
  /** Filesystem revision observed immediately before publication. */
  readonly fileVersion: NotebookFileVersion
  /** Parsed nbformat minor version from the accepted revision. */
  readonly nbformatMinor: number
  /** Notebook metadata from the accepted revision. */
  readonly metadata: NotebookJsonObject
  /** Complete ordered cells from the accepted revision. */
  readonly cells: readonly NotebookCellSnapshot[]
}

/** Options accepted by `NotebookService.open`. */
export interface NotebookOpenOptions {
  /** Cancellation for the stable existing-file read and publication. */
  readonly signal?: AbortSignal
}

/** Options accepted by `NotebookService.create`. */
export interface NotebookCreateOptions {
  /** Cancellation for guarded absent-file creation and publication. */
  readonly signal?: AbortSignal
}

/** Options accepted by `NotebookService.attachEnvironment`. */
export interface NotebookAttachEnvironmentOptions {
  /** Human or agent path selecting the environment. */
  readonly initiator: 'agent' | 'user'
  /** Backend type resolved by the trusted Host or same-process consumer. */
  readonly backend?: string
  /** Optional kernelspec override; providers may otherwise use their environment default. */
  readonly kernelName?: string
  /** Cancellation for queue wait and unpublished kernel startup. */
  readonly signal?: AbortSignal
}

/** Options accepted by `NotebookService.execute`. */
export interface NotebookExecuteOptions {
  /** Whether an agent or a human-initiated path started the run. */
  readonly initiator: 'agent' | 'user'
  /** Optional cancellation for queue wait and kernel execution. */
  readonly signal?: AbortSignal
}

/** Result returned after one cell execution completes. */
export interface NotebookExecuteResult {
  /** Minted execution identity written to the log. */
  readonly executionId: ExecutionId
  /** Final folded outputs after append, clear, and display updates. */
  readonly outputs: readonly NotebookOutput[]
  /** Kernel-wide counter, or null when the kernel did not report one. */
  readonly executionCount: number | null
  /** Terminal execution status. */
  readonly status: NotebookExecutionStatus
  /** Failure or cancellation text when status is not `ok`. */
  readonly error?: string
}

/** Options accepted by `NotebookService.restart`. */
export interface NotebookRestartOptions {
  /** Human or agent path requesting the replacement. */
  readonly initiator: 'agent' | 'user'
  /** Optional cancellation for queue wait and replacement startup. */
  readonly signal?: AbortSignal
}

/** Options accepted by `NotebookService.inspect`. */
export interface NotebookInspectOptions {
  /** Human or agent path whose inspection may recover the selected kernel. */
  readonly initiator: 'agent' | 'user'
  /** Optional cancellation for queue wait and inspection. */
  readonly signal?: AbortSignal
}

/** Options accepted by `NotebookService.reload`. */
export interface NotebookReloadOptions {
  /** Human or agent path accepting the current external file revision. */
  readonly initiator: 'agent' | 'user'
  /** Optional cancellation for the stable external document read. */
  readonly signal?: AbortSignal
}

/** Folded notebook documents derived from one session log slice. */
export interface FoldedNotebooks {
  /** Notebook documents in first-open order. */
  readonly notebooks: readonly NotebookDocument[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one workspace-backed notebook and records its committed file revision.
     * @param data - document identity, normalized path, file revision, and nbformat metadata.
     */
    'notebook/open': NotebookOpenEvent
    /**
     * Creates or updates one notebook cell after a file commit.
     * @param data - document, cell, operation, imported state, and committed file revision.
     */
    'notebook/cell': NotebookCellEvent
    /**
     * Starts execution for one code cell.
     * @param data - document, cell, execution identity, and initiator.
     */
    'notebook/execute': NotebookExecuteEvent
    /**
     * Applies one ordered execution output mutation.
     * @param data - execution correlation and one admitted output mutation.
     */
    'notebook/output': NotebookOutputEvent
    /**
     * Marks one cell execution complete after its file commit.
     * @param data - execution correlation, terminal result, and committed file revision.
     */
    'notebook/execute-end': NotebookExecuteEndEvent
    /**
     * Publishes one successfully started, restarted, or recovered notebook kernel.
     * @param data - selected environment, backend, resolved kernel, generation, and initiator.
     */
    'notebook/kernel': NotebookKernelEvent
    /**
     * Accepts one complete external document revision without changing its kernel selection.
     * @param data - document identity, external revision, nbformat metadata, and complete cells.
     */
    'notebook/reload': NotebookReloadEvent
  }
}
