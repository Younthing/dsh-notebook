# Notebook

[English](notebook.md) | 中文

Notebook 使用两个三角色能力。`ctx.notebooks` 拥有 workspace 文档、进程内投影与 kernel 生命周期；`ctx.notebookEnvironments` 拥有浏览器安全环境发现、固定配置操作与可信启动解析。默认提供方使用 uv 与 Jupyter，模型、Host 与浏览器消费方分别拥有自身交互策略。rc.6 基线会持久化 `.ipynb` 文件，但不会把外部 Notebook 事件追加到 Harness Session 日志。

来源：[`types.ts`](../packages/notebook-core/src/types.ts)、[`kernel-types.ts`](../packages/notebook-core/src/kernel-types.ts)、[`output-types.ts`](../packages/notebook-core/src/output-types.ts)、[`brand.ts`](../packages/notebook-core/src/brand.ts)与 [`notebook-environment`](../packages/notebook-environment/src/index.ts)。

## 文档与运行时生命周期

`open()` 接受已有 `.ipynb`，目标缺失时报告 `NOT_FOUND`；`create()` 原子创建不存在的路径，发生冲突时报告 `ALREADY_EXISTS`。两者都发布 detached 文档；没有 Python 或 kernel 时仍可读取、编辑、插入、发现与 reload。有界发现返回 workspace 相对路径，不读取文件内容，也不恢复 Agent。

显式环境 attach 启动第一个 kernel，并在进程内投影中记录 `NotebookKernelSelection`。该选择不存在时，execute 与 inspect 报告 `ENVIRONMENT_REQUIRED`。选择存在但进程内 handle 丢失时，两项操作都会尝试恢复。成功 attach、restart 与 recovery 会推进 generation；reload 接受外部文件、保留选择，并退役旧 handle，而不启动另一个。

文件变更会先使用 compare-and-swap，再更新进程内投影。`.ipynb` 输出保留 stream 记录、结构化错误、完整 MIME bundle 与 display-update 语义；光栅 MIME 值携带已授权附件引用。一个 kernel 的调用串行化，不同 Notebook kernel 可以并发执行。

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

## 环境目录与配置

目录条目暴露不透明 id、版本、来源、ready 状态与 DSH 所有权；绝不包含绝对解释器路径、命令行或 kernelspec 资源目录。`resolveLaunch()` 是供 Jupyter 提供方使用的同进程操作。

uv 提供方固定以一个 workspace `.venv` 为目标。它只在显式调用后安装固定 uv `0.11.32`，校验已提交的官方发行包 hash，且绝不运行远程安装器或修改 PATH。Python `3.12` 下载是独立的 `danger-full-access` 操作。Provision 接受 workspace-write 或 danger-full-access，安装提供方 hash-locked 的 `jupyter_client==8.9.1` 与 `ipykernel==7.3.0`，不运行 `uv sync`，也不修改项目 manifest。

发现不会执行已有 `.venv`。启用未托管环境与重建由 sidecar 证明的 DSH 环境是不同确认。稳定错误 code 与 category 让 Host 和 UI 消费方区分 manager、Python、permission、dependency、kernelspec 与 kernel-start 恢复。

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

## Session 事件

`SessionEventMap` 的持久 `notebook/*` 成员通过 `foldNotebooks()` 重建文档。`notebook/open` 只描述文档；`notebook/kernel` 是成功 attach、restart 与 recovery 的统一记录。`notebook/reload` 替换完整文档快照，不改变其持久 kernel 选择。预发布 reader 拒绝已取代的 restart event 格式。

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
