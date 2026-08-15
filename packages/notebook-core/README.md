# @younthing/dsh-notebook-core

English | [中文](README.zh.md)

Workspace-backed notebook capability. `NotebookService` registers as `ctx.notebooks`, discovers, creates, opens, and atomically updates `.ipynb` files, keeps documents usable without a kernel, and retains document projections and attached kernel handles process-locally until shutdown.

## Contract

- Kernel backends register one stable `type` and own start, execute, inspect, and shutdown mechanics.
- Notebook paths are normalized workspace-relative `.ipynb` paths. Resolution must remain inside the session working directory after canonicalization. `open()` accepts existing files only, while `create()` uses an atomic absent-only write and never overwrites a winner.
- `discoverWorkspace()` lists metadata without reading file content. Traversal is stable, canonically deduplicated, and bounded by configurable page, entry, and depth limits whose defaults are 50, 500, and 12. Default exclusions cover `.git`, `.hg`, `.svn`, `.venv`, `.ipynb_checkpoints`, and `node_modules`. A page reports omitted subtrees through `partial`, resumes from an exact `nextAfter` path, and rejects a missing continuation with `DISCOVERY_CURSOR_STALE`.
- Opening or creating adds the complete document to the process-local projection without selecting or starting a kernel. `attachEnvironment()` accepts an opaque `NotebookEnvironmentId` and updates the projection only after the backend starts successfully. The projection records `{ environmentId, backend, kernelName?, generation }`.
- Canonical filesystem targets coalesce within one exact `Session` instance, so aliases cannot create two compare-and-swap owners for one file. Different sessions retain independent kernels and compete through file versions.
- `editCell()`, `insertCell()`, and execution completion atomically replace the file with its observed `FsVersion` before updating the process-local projection. An external change raises `NotebookPersistenceError` with `WRITE_CONFLICT` and leaves the projection unchanged. Detached documents remain editable.
- `reload()` accepts one stable external revision, admits its attachments, replaces the process-local document, and retires the live kernel while retaining the selected environment. The next execution or inspection recovers that selection. `restart()` replaces the selected environment's idle kernel without rewriting notebook metadata.
- `execute()` and `inspect()` raise `ENVIRONMENT_REQUIRED` when no environment has been selected. When a selected environment exists but its process-local handle is missing, either operation attempts recovery. Successful attach, restart, and recovery advance `generation` by exactly one; failed startup leaves the selection unchanged and is visible through `runtimeStatus()` with a path-free summary rather than provider stderr or executable paths.
- Calls for one kernel are serialized; different notebook kernels may execute concurrently. Kernel output mutations preserve MIME bundles and display updates, while raster values become attachment references before the document projection is updated.
- Every started code run finishes with an explicit `ok`, `error`, or `cancelled` result after the `.ipynb` execution count and outputs commit. Transport and output-admission failures retire the kernel instead of masquerading as successful code.
- Every kernel captures the complete `SandboxExecutionPolicy` used to start it. A durable `sandbox/mode` change synchronously aborts mismatched active, queued, and starting work and begins handle retirement. A later restart or automatic recovery starts under the current policy and publishes the new generation.
- Shutdown waits for both the kernel queue and provider shutdown to reach quiescence. `shutdownTimeoutMs` bounds Cordis teardown: a timeout is logged as failure while the service retains the unfinished join, and the handle is released only after both settle successfully. Rejection retains a `shutdown-failed` record.
- The service requires `attachments`, `fs`, and `sandboxPolicy`. Configuration bounds discovery traversal, kernel start, execution, inspection, shutdown, complete document bytes and images, execution output bytes/items/images, and inspection bytes.

The seam contains no tool schemas, prompt text, or UI rendering policy. Consumers own model presentation.

## Model Experience

### Indirect consumer

#### What the model sees

Nothing directly. This package registers no prompt or tool; `@younthing/dsh-tool-notebook` owns visible schemas and result text.

#### Token effect

None directly. Notebook documents and outputs reach the model only through consumer tool results or injected user messages.

#### KV Cache effect

No direct invalidation; the named consumer owns request-prefix changes.

## Known Limitations and Deferred Work

- The bundled `MemoryKernelBackend` supports only scalar literals, variables, one binary arithmetic operation, assignment, and `print()` for tests; it never executes arbitrary Python or JavaScript.
- Remote Jupyter wiring lives in `@younthing/dsh-notebook-kernel-jupyter`; this package does not spawn processes.
