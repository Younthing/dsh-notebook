/** Browser-safe wire vocabulary owned by the standalone Notebook Remote. */

/** Opaque identities cross the wire as strings and are rebranded by consumers. */
export type NotebookId = string
export type CellId = string
export type ExecutionId = string
export type NotebookFileVersion = string
export type NotebookEnvironmentId = string

/** Supported nbformat cell kinds. */
export type CellType = 'code' | 'markdown' | 'raw'

/** JSON value retained in notebook metadata and rich MIME payloads. */
export type NotebookJsonValue = null | boolean | number | string | readonly NotebookJsonValue[] | NotebookJsonObject

/** JSON object retained in notebook metadata. */
export interface NotebookJsonObject {
  readonly [key: string]: NotebookJsonValue
}

/** Durable image attachment reference returned to the browser. */
export interface NotebookImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One value in a rich output MIME bundle. */
export type NotebookMimeValue =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly value: NotebookJsonValue }
  | { readonly type: 'image'; readonly attachment: NotebookImageAttachmentRef }
  | { readonly type: 'base64'; readonly data: string }

/** Complete MIME alternatives for one rich output. */
export type NotebookMimeBundle = Readonly<Record<string, NotebookMimeValue>>

/** Markdown attachment name to its MIME alternatives. */
export type NotebookCellAttachments = Readonly<Record<string, NotebookMimeBundle>>

/** One durable nbformat-compatible output. */
export type NotebookOutput =
  | { readonly type: 'stream'; readonly name: 'stdout' | 'stderr'; readonly text: string }
  | {
    readonly type: 'display'
    readonly data: NotebookMimeBundle
    readonly metadata: NotebookJsonObject
    readonly displayId?: string
  }
  | {
    readonly type: 'execute-result'
    readonly data: NotebookMimeBundle
    readonly metadata: NotebookJsonObject
    readonly executionCount: number | null
    readonly displayId?: string
  }
  | { readonly type: 'error'; readonly name: string; readonly value: string; readonly traceback: readonly string[] }

/** Kernel selection persisted with one notebook. */
export interface NotebookKernelSelection {
  readonly environmentId: NotebookEnvironmentId
  readonly backend: string
  readonly kernelName?: string
  readonly generation: number
}

/** One cell in a complete notebook document. */
export interface NotebookCell {
  readonly id: CellId
  readonly cellType: CellType
  readonly source: string
  readonly metadata: NotebookJsonObject
  readonly attachments: NotebookCellAttachments
  readonly outputs: readonly NotebookOutput[]
  readonly executionCount?: number
  readonly status?: 'running' | 'ok' | 'error' | 'cancelled'
  readonly error?: string
}

/** Complete workspace-backed document returned by open and mutation methods. */
export interface NotebookDocument {
  readonly id: NotebookId
  readonly path: string
  readonly kernel?: NotebookKernelSelection
  readonly fileVersion: NotebookFileVersion
  readonly nbformatMinor: number
  readonly metadata: NotebookJsonObject
  readonly cells: readonly NotebookCell[]
}

/** One discovered workspace notebook. */
export interface NotebookDiscoveryItem {
  readonly path: string
  readonly size?: number
}

/** Bounded workspace notebook discovery page. */
export interface NotebookDiscoveryPage {
  readonly items: readonly NotebookDiscoveryItem[]
  readonly nextAfter?: string
  readonly partial: boolean
}

/** Process-local runtime state for one selected notebook kernel. */
export type NotebookKernelRuntimeStatus =
  | { readonly status: 'detached' }
  | { readonly status: 'starting' | 'ready' | 'running' | 'stopped'; readonly environmentId: NotebookEnvironmentId }
  | { readonly status: 'failed'; readonly environmentId: NotebookEnvironmentId; readonly message: string }

/** Environment manager state exposed without host paths. */
export interface NotebookEnvironmentManagerCatalog {
  readonly status: 'ready' | 'missing' | 'broken' | 'unsupported'
  readonly version?: string
  readonly canInstall: boolean
}

/** Browser-safe Python interpreter entry. */
export interface NotebookPythonCatalogEntry {
  readonly id: string
  readonly version: string
  readonly source: 'configured' | 'path' | 'managed'
}

/** Browser-safe workspace environment entry. */
export interface NotebookEnvironmentCatalogEntry {
  readonly id: NotebookEnvironmentId
  readonly displayName: string
  readonly status: 'ready' | 'setup-required' | 'provisioning' | 'broken'
  readonly pythonVersion?: string
  readonly managed: boolean
}

/** Complete environment catalog for one workspace. */
export interface NotebookEnvironmentCatalog {
  readonly manager: NotebookEnvironmentManagerCatalog
  readonly pythons: readonly NotebookPythonCatalogEntry[]
  readonly environments: readonly NotebookEnvironmentCatalogEntry[]
}

/** Stable plugin-domain failure returned without rejecting the Remote call. */
export interface NotebookRemoteError {
  readonly source: 'session' | 'core' | 'persistence' | 'environment' | 'attachment' | 'configuration' | 'cancelled'
  readonly code: string
  readonly message: string
  readonly category?: string
  readonly retryable?: boolean
}

/** Explicit success or expected domain failure returned by every method. */
export type NotebookRemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: NotebookRemoteError }

/** Browser-safe acknowledgement of one committed kernel selection. */
export interface NotebookKernelAck {
  readonly notebookId: NotebookId
  readonly environmentId: NotebookEnvironmentId
  readonly backend: string
  readonly kernelName?: string
  readonly generation: number
  readonly document: NotebookDocument
}

/** Acknowledgement after a user-initiated cell run. */
export interface NotebookRunAck {
  readonly executionId: ExecutionId
  readonly status: 'ok' | 'error' | 'cancelled'
  readonly executionCount: number | null
  readonly error?: string
  readonly document: NotebookDocument
}

/** Acknowledgement after accepting an external file revision. */
export interface NotebookReloadAck {
  readonly fileVersion: NotebookFileVersion
  readonly document: NotebookDocument
}

/** Cold-session notebook discovery input. */
export interface NotebookDiscoverRequest {
  readonly sessionId: string
  readonly after?: string
}

/** Existing notebook path to open. */
export interface NotebookOpenRequest {
  readonly sessionId: string
  readonly path: string
}

/** Absent notebook path to create. */
export interface NotebookCreateRequest {
  readonly sessionId: string
  readonly path: string
}

/** One session identity for operations without additional input. */
export interface NotebookSessionRequest {
  readonly sessionId: string
}

/** Cold-session environment catalog input. */
export interface NotebookEnvironmentCatalogRequest {
  readonly sessionId: string
}

/** Supported Python installation input. */
export interface NotebookInstallPythonRequest {
  readonly sessionId: string
  readonly version: '3.12'
}

/** Workspace environment provisioning input. */
export interface NotebookCreateEnvironmentRequest {
  readonly sessionId: string
  readonly environmentId: NotebookEnvironmentId
  readonly allowExisting: boolean
  readonly rebuild: boolean
}

/** Kernel attachment input. */
export interface NotebookAttachEnvironmentRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly environmentId: NotebookEnvironmentId
}

/** Cold-session runtime status input. */
export interface NotebookRuntimeStatusRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
}

/** Cell source replacement input. */
export interface NotebookEditCellRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly cellId: CellId
  readonly source: string
}

/** Cell insertion input. */
export interface NotebookInsertCellRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly cellType: CellType
  readonly afterCellId?: CellId
  readonly source?: string
}

/** Cell deletion input. */
export interface NotebookDeleteCellRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly cellId: CellId
}

/** Cell reordering input. */
export interface NotebookMoveCellRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly cellId: CellId
  readonly toIndex: number
}

/** Cell duplication input. */
export interface NotebookCopyCellRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly cellId: CellId
}

/** User-initiated cell execution input. */
export interface NotebookRunCellRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
  readonly cellId: CellId
  readonly source?: string
}

/** Existing notebook identity input. */
export interface NotebookIdentityRequest {
  readonly sessionId: string
  readonly notebookId: NotebookId
}

/** Kernel interruption input. */
export interface NotebookInterruptRequest extends NotebookIdentityRequest {
  readonly reason?: string
}

/** Authorized Notebook raster read input. */
export interface NotebookReadAttachmentRequest {
  readonly sessionId: string
  readonly attachmentId: string
}

/** Verified raster bytes returned as base64 for JSON transport. */
export interface NotebookReadAttachmentAck {
  readonly attachment: NotebookImageAttachmentRef
  readonly data: string
}

/** Successful cell edit acknowledgement. */
export interface NotebookEditCellAck {
  readonly document: NotebookDocument
}

/** Successful cell insertion acknowledgement. */
export interface NotebookInsertCellAck {
  readonly cellId: CellId
  readonly document: NotebookDocument
}

/** Successful cell duplication acknowledgement. */
export interface NotebookCopyCellAck {
  readonly cellId: CellId
  readonly document: NotebookDocument
}

/** Successful cell deletion or reordering acknowledgement. */
export interface NotebookCellMutationAck {
  readonly document: NotebookDocument
}

/** Kernel interruption acknowledgement. */
export interface NotebookInterruptAck {
  readonly interrupted: boolean
}
