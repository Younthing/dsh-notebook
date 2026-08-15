# Notebook

English | [中文](notebook.zh.md)

Notebook uses two three-role capabilities. `ctx.notebooks` owns workspace documents, process-local projections, and kernel lifecycle; `ctx.notebookEnvironments` owns browser-safe environment discovery, fixed provisioning operations, and trusted launch resolution. The default Providers use uv and Jupyter, while model, Host, and browser Consumers own their respective interaction policies. The rc.6 baseline persists `.ipynb` files but does not append external Notebook events to the Harness Session log.

Source: [`types.ts`](../packages/notebook-core/src/types.ts), [`kernel-types.ts`](../packages/notebook-core/src/kernel-types.ts), [`output-types.ts`](../packages/notebook-core/src/output-types.ts), [`brand.ts`](../packages/notebook-core/src/brand.ts), and [`notebook-environment`](../packages/notebook-environment/src/index.ts).

## Document and runtime lifecycle

`open()` accepts an existing `.ipynb` and reports `NOT_FOUND` for a missing target; `create()` atomically creates an absent path and reports `ALREADY_EXISTS` for a conflict. Both publish a detached document that remains readable, editable, insertable, discoverable, and reloadable without Python or a kernel. Bounded discovery returns workspace-relative paths without reading file content or restoring an Agent.

An explicit environment attachment starts the first kernel and records `NotebookKernelSelection` in the process-local projection. Execute and inspect report `ENVIRONMENT_REQUIRED` while that selection is absent. When the selection exists but its process-local handle is gone, either operation attempts recovery. Successful attach, restart, and recovery advance its generation; reload accepts the external file, preserves the selection, and retires the old handle without starting another.

File mutations use compare-and-swap before updating the process-local projection. The `.ipynb` output retains stream records, structured errors, full MIME bundles, and display-update semantics; raster MIME values carry authorized attachment references. Calls for one kernel serialize, while different notebook kernels may execute concurrently.

```ts type-equiv
/** Opaque notebook document identity minted by {@link NotebookService}. */
type NotebookId = Branded<'NotebookId'>
```

```ts type-equiv
/** Opaque identity of one notebook environment within its workspace. */
type NotebookEnvironmentId = Branded<'NotebookEnvironmentId'>
```

```ts type-equiv
/** One durable kernel selection attached to a notebook document. */
interface NotebookKernelSelection {
  /** Opaque environment selected by the environment provider. */
  readonly environmentId: NotebookEnvironmentId
  /** Registered Notebook kernel backend type. */
  readonly backend: string
  /** Resolved kernelspec name, when the backend uses one. */
  readonly kernelName?: string
  /** Monotonic count of successfully published kernel starts. */
  readonly generation: number
}
```

```ts type-equiv
/** Workspace-backed notebook document retained in the plugin process. */
interface NotebookDocument {
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
```

```ts type-equiv
/** One bounded page of workspace notebook discovery. */
interface NotebookDiscoveryPage {
  /** Canonically deduplicated notebook files in stable traversal order. */
  readonly items: readonly NotebookDiscoveryEntry[]
  /** Last returned path when another page exists. */
  readonly nextAfter?: string
  /** Whether an unreadable or depth-limited subtree was omitted. */
  readonly partial: boolean
}
```

```ts type-equiv
/** Process-local status of a document's selected kernel. */
type NotebookKernelRuntimeStatus =
  | { readonly status: 'detached' }
  | { readonly status: 'starting' | 'ready' | 'running' | 'stopped'; readonly environmentId: NotebookEnvironmentId }
  | { readonly status: 'failed'; readonly environmentId: NotebookEnvironmentId; readonly message: string }
```

## Environment catalog and provisioning

Catalog entries expose opaque ids, versions, provenance, readiness, and DSH ownership; they never contain an absolute interpreter path, command line, or kernelspec resource directory. `resolveLaunch()` is a same-process operation for the Jupyter Provider.

The uv Provider targets one workspace `.venv`. It installs fixed uv `0.11.32` only after an explicit call, verifies a committed official archive hash, and never runs a remote installer or changes PATH. Python `3.12` download is a separate `danger-full-access` operation. Provisioning accepts workspace-write or danger-full-access, installs the Provider's hash-locked `jupyter_client==8.9.1` and `ipykernel==7.3.0`, and does not run `uv sync` or modify project manifests.

Discovery does not execute an existing `.venv`. Enabling an unmanaged environment and rebuilding a sidecar-proven DSH environment are separate confirmations. Stable error codes and categories let Host and UI Consumers distinguish manager, Python, permission, dependency, kernelspec, and kernel-start recovery.

```ts type-equiv
/** Complete browser-safe catalog for one workspace. */
interface NotebookEnvironmentCatalog {
  /** Manager availability and install affordance. */
  readonly manager: NotebookEnvironmentManagerCatalog
  /** Compatible Python interpreters discovered without exposing their paths. */
  readonly pythons: readonly NotebookPythonCatalogEntry[]
  /** Workspace notebook environments. */
  readonly environments: readonly NotebookEnvironmentCatalogEntry[]
}
```

```ts type-equiv
/** Stable machine-readable failures exposed by the environment seam. */
type NotebookEnvironmentErrorCode =
  | 'NOTEBOOK_ENVIRONMENT_UNKNOWN'
  | 'NOTEBOOK_ENVIRONMENT_MANAGER_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_MANAGER_UNSUPPORTED'
  | 'NOTEBOOK_ENVIRONMENT_MANAGER_INTEGRITY'
  | 'NOTEBOOK_ENVIRONMENT_PYTHON_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_ATTACH_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_REBUILD_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_PERMISSION_REQUIRED'
  | 'NOTEBOOK_ENVIRONMENT_BUSY'
  | 'NOTEBOOK_ENVIRONMENT_TIMEOUT'
  | 'NOTEBOOK_ENVIRONMENT_OUTPUT_LIMIT'
  | 'NOTEBOOK_ENVIRONMENT_PROVISION_FAILED'
  | 'NOTEBOOK_ENVIRONMENT_DEPENDENCY_FAILED'
  | 'NOTEBOOK_ENVIRONMENT_KERNELSPEC_MISSING'
  | 'NOTEBOOK_ENVIRONMENT_KERNEL_START_FAILED'
  | 'NOTEBOOK_ENVIRONMENT_BROKEN'
```

## Session events

Durable `notebook/*` members of `SessionEventMap` reconstruct documents through `foldNotebooks()`. `notebook/open` describes the document only; `notebook/kernel` is the single successful attach, restart, and recovery record. `notebook/reload` replaces the complete document snapshot without changing its durable kernel selection. The pre-release reader rejects the superseded restart-event format.

```ts type-equiv
/** Payload for `notebook/kernel`. */
interface NotebookKernelEvent {
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
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnotebookenvironments--notebookenvironmentmanager-abstract-seam"></a>

### `ctx.notebookEnvironments` — `NotebookEnvironmentManager` (abstract seam)

One environment manager implementation. Every request carries its complete workspace, permission, and cancellation context; the service retains no hidden session selection.

```ts cordis-catalog
/**
 * Discover manager, Python, and workspace environment state without mutation.
 * @param request - explicit workspace, policy, and cancellation context.
 * @returns a browser-safe catalog containing no absolute paths or argv.
 */
abstract environmentCatalog(request: NotebookEnvironmentOperationRequest): Promise<NotebookEnvironmentCatalog>

/**
 * Install the provider's pinned private manager after explicit user intent.
 * @param request - explicit workspace, policy, and cancellation context.
 * @returns the refreshed browser-safe catalog.
 */
abstract installUv(request: NotebookEnvironmentOperationRequest): Promise<NotebookEnvironmentCatalog>

/**
 * Install the supported Python runtime after an explicit user call.
 * @param request - explicit version, workspace, policy, and cancellation context.
 * @returns the refreshed browser-safe catalog.
 */
abstract installPython(request: NotebookPythonInstallRequest): Promise<NotebookEnvironmentCatalog>

/**
 * Inspect the workspace `.venv` without claiming or mutating it.
 * @param request - selected environment and explicit operation context.
 * @returns whether the directory is absent, managed, attachable, or broken.
 */
abstract inspectExisting(request: NotebookEnvironmentTargetRequest): Promise<NotebookExistingEnvironmentInspection>

/**
 * Create, explicitly attach, repair, or explicitly rebuild the workspace environment.
 * @param request - selected environment plus independent attach and owned-rebuild authorizations.
 * @returns the ready catalog entry after atomic publication or successful attach.
 */
abstract provision(request: NotebookEnvironmentProvisionRequest): Promise<NotebookEnvironmentCatalogEntry>

/**
 * Resolve an opaque ready environment into same-process Jupyter launch details.
 * @param request - selected environment and explicit operation context.
 * @returns absolute Host-only interpreter path and provider default kernelspec.
 */
abstract resolveLaunch(request: NotebookEnvironmentTargetRequest): Promise<NotebookEnvironmentLaunchSpec>
```

Source: [`packages/notebook-environment/src/index.ts`](../packages/notebook-environment/src/index.ts)

<a id="ctxnotebooks--notebookservice"></a>

### `ctx.notebooks` — `NotebookService`

Workspace-backed notebook registry and kernel lifecycle owner.

```ts cordis-catalog
/**
 * Register one kernel backend for this effect scope.
 * @param backend - provider with a non-empty unique type.
 * @returns disposer that removes exactly this contribution and retires its kernels.
 */
registerBackend(backend: NotebookKernelBackend): () => void

/**
 * List registered backend types in registration order.
 * @returns fresh backend type names.
 */
listBackends(): string[]

/**
 * Open one existing workspace `.ipynb` without selecting or starting a kernel.
 * Canonical aliases in the same session coalesce to one document.
 * @param session - exact owning session instance.
 * @param path - normalized workspace-relative notebook path.
 * @param options - cancellation for the stable read and publication.
 * @returns the complete document reconstructed from committed session events.
 */
async open(session: Session, path: string, options: NotebookOpenOptions = {}): Promise<NotebookDocument>

/**
 * Guardedly create one absent workspace `.ipynb` without selecting a kernel.
 * @param session - exact owning session instance.
 * @param path - normalized workspace-relative notebook path.
 * @param options - cancellation for absence observation and guarded creation.
 * @returns the newly created document reconstructed from committed events.
 */
async create(session: Session, path: string, options: NotebookCreateOptions = {}): Promise<NotebookDocument>

/**
 * Read one notebook document from the session log.
 * @param session - owning session.
 * @param notebookId - target notebook identity.
 * @returns the folded notebook document.
 */
get(session: Session, notebookId: NotebookId): NotebookDocument

/**
 * List notebook documents visible in one session log.
 * @param session - owning session.
 * @returns documents in first-open order.
 */
list(session: Session): NotebookDocument[]

/**
 * Discover a bounded page of `.ipynb` files beneath the session workspace.
 * File content is never opened or decoded by discovery.
 * @param session - session whose working directory is the discovery root.
 * @param options - exact continuation path and cancellation.
 * @returns stable traversal results plus partial and continuation state.
 */
async discoverWorkspace( session: Session, options: NotebookDiscoveryOptions = {}, ): Promise<NotebookDiscoveryPage>

/**
 * Query process-local kernel state without mutating durable notebook state.
 * Failed state carries a path-free summary instead of the provider exception.
 * @param session - owning session.
 * @param notebookId - target document identity.
 * @returns detached, starting, ready, running, stopped, or failed state.
 */
runtimeStatus(session: Session, notebookId: NotebookId): NotebookKernelRuntimeStatus

/**
 * Atomically replace one cell's source before publishing its session event.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param cellId - target cell identity.
 * @param source - complete replacement source.
 * @param signal - optional cancellation for queue wait, read, and CAS write.
 * @returns the updated folded document.
 */
async editCell( session: Session, notebookId: NotebookId, cellId: CellId, source: string, signal?: AbortSignal, ): Promise<NotebookDocument>

/**
 * Insert one cell immediately after an anchor, or at index zero without one.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param cellType - native nbformat cell kind.
 * @param afterCellId - preceding cell identity; omitted inserts first.
 * @param source - optional initial source.
 * @param signal - optional cancellation for queue wait, read, and CAS write.
 * @returns the updated folded document.
 */
async insertCell( session: Session, notebookId: NotebookId, cellType: CellType, afterCellId?: CellId, source: string = '', signal?: AbortSignal, ): Promise<NotebookDocument>

/**
 * Execute one code cell with a serialized per-kernel state transition.
 * Different notebook kernels remain independently runnable.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param cellId - target code-cell identity.
 * @param options - initiator and optional cancellation.
 * @returns bounded durable outputs and an explicit terminal outcome.
 */
async execute( session: Session, notebookId: NotebookId, cellId: CellId, options: NotebookExecuteOptions, ): Promise<NotebookExecuteResult>

/**
 * Inspect one kernel name without exposing unbounded backend text.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param name - variable or symbol name.
 * @param options - initiator and cancellation for recovery, queue wait, and inspection.
 * @returns bounded backend-specific text.
 */
async inspect( session: Session, notebookId: NotebookId, name: string, options: NotebookInspectOptions, ): Promise<string>

/**
 * Select an environment and publish it only after its kernel starts successfully.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param environmentId - opaque provider-owned environment identity.
 * @param options - trusted backend selection, initiator, kernelspec, and cancellation.
 * @returns the document with its newly committed kernel selection.
 */
async attachEnvironment( session: Session, notebookId: NotebookId, environmentId: NotebookEnvironmentId, options: NotebookAttachEnvironmentOptions, ): Promise<NotebookDocument>

/**
 * Replace the selected environment's idle kernel and advance its generation.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param options - initiator and optional cancellation.
 * @returns the document after the successful replacement is published.
 */
async restart( session: Session, notebookId: NotebookId, options: NotebookRestartOptions, ): Promise<NotebookDocument>

/**
 * Accept the current external `.ipynb` revision as one atomic document snapshot.
 * The selected environment is retained while any live kernel is retired after publication.
 * @param session - exact owning session instance.
 * @param notebookId - document identity retained by the reload.
 * @param options - initiator and optional cancellation.
 * @returns the reloaded folded document.
 */
async reload( session: Session, notebookId: NotebookId, options: NotebookReloadOptions, ): Promise<NotebookDocument>

/**
 * Cancel the active execution for one exact session/notebook kernel.
 * @param session - exact owning session instance.
 * @param notebookId - target notebook identity.
 * @param reason - optional cancellation text persisted by the terminal outcome.
 * @returns true only when an active execution was newly interrupted.
 */
interrupt(session: Session, notebookId: NotebookId, reason?: string): boolean
```

Types: [Session](session.md)

Source: [`packages/notebook-core/src/index.ts`](../packages/notebook-core/src/index.ts)
<!-- END GENERATED cordis-surface -->
