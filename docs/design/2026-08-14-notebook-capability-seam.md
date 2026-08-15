# Agent Note: Notebook capability seam

Status: implemented

English | [中文](2026-08-14-notebook-capability-seam.zh.md)

## Problem

Scientists and ML engineers need an interactive computational document with ordered cells, persistent kernel memory, rich MIME outputs, selective re-execution, and a workspace file they can take away. DeepSeek Harness already has fresh-process Code Mode and persistent terminal sessions, but neither represents notebook cells and MIME output as reconstructable session facts.

A notebook document must remain useful when Python, Jupyter, or an environment manager is unavailable. Treating the kernel as a prerequisite for discovery or editing turns a recoverable runtime setup problem into document loss. Letting a browser choose executable paths, packages, indexes, or subprocess arguments would instead move trusted Host policy into an untrusted client.

Embedding JupyterLab would split plugin composition, permissions, session identity, and model visibility between two applications. Driving IPython through a terminal would reduce cells and rich output to untyped text. Making CodeRuntime persistent would violate its fresh-run guarantee and leave cross-call state outside its logged execution model. Code Mode therefore keeps a persistent REPL out of `run_code`; this note owns the separate Notebook capability.

## Decision

Notebook is a complete, independently installed capability with workspace-backed documents, a separate Python-environment capability, a replaceable kernel Provider, and Host, model, and browser Consumers. The rc.6 release keeps document projections process-local and treats `.ipynb` files as durable truth. It does not modify the agent loop.

### Package ownership

| Package | Role and ownership |
|---|---|
| `@younthing/dsh-notebook` | Installable bundle that activates the complete capability through one profile patch |
| `@younthing/dsh-notebook-core` | Service Definition for discovery, documents, file transactions, process-local projections, kernel registration, serialization, and teardown through `ctx.notebooks` |
| `@younthing/dsh-notebook-environment` | Service Definition for browser-safe environment catalogs, opaque environment ids, provisioning operations, typed failures, and trusted launch resolution through `ctx.notebookEnvironments` |
| `@younthing/dsh-notebook-environment-uv` | Provider for private uv installation, Python discovery and installation, workspace `.venv` provisioning, ownership recovery, and interpreter launch resolution |
| `@younthing/dsh-notebook-kernel-jupyter` | Provider that launches `jupyter_client` from a resolved environment through managed subprocess and sandbox services |
| `@younthing/dsh-tool-notebook` | Model Consumer that registers nine document and execution tools plus bounded user-execution injection |
| `@younthing/dsh-notebook-remote` | Host Consumer that derives trusted workspace and permission policy and exposes the `notebooks` Typert Remote namespace |
| `@younthing/dsh-client-ui-notebook` | Browser Consumer that owns document selection, editing, execution controls, environment setup, and rich-output rendering |

Providers and Consumers depend on their Service Definitions, never on each other. Browser-safe type exports contain opaque ids, durable values, catalog entries, and typed error details; they do not expose Cordis services, absolute interpreter paths, kernelspec resource directories, executable arguments, or Host implementation types.

### The ipynb file is available without a kernel

`NotebookService.open()` accepts an existing workspace `.ipynb` only, and `create()` atomically creates an absent path only. A missing open reports `NOT_FOUND`; a losing create reports `ALREADY_EXISTS`; neither operation overwrites or starts a kernel. Both publish the complete document to the plugin-local projection, so read, edit, insert, discover, and reload remain available while detached.

The Service Definition discovers workspace-relative `.ipynb` paths through bounded `ctx.fs` traversal without reading file contents. Canonical-target deduplication, containment checks, excluded directory names, depth and result limits, stable pagination, stale-cursor rejection, cancellation, and partial-result reporting constrain symlinks and large trees. The Host derives the scan root from the Session header and does not restore an Agent merely to discover files.

Canonical filesystem targets coalesce within one exact Session instance; different sessions retain independent kernel state and compete through filesystem versions. Cell edits, stable-anchor insertions, and execution results replace the file through compare-and-swap before the plugin-local projection changes. An external edit yields typed `WRITE_CONFLICT` and leaves the projection unchanged.

`reload()` accepts one stable external revision and replaces the complete plugin-local document. It preserves the selected environment, retires the old process-local kernel, and does not start a replacement. The next execution or inspection may recover that selected environment. Reload is full-document acceptance, not a merge.

### Kernel selection and handles are process-local

`NotebookDocument.kernel` is absent until a successful explicit attachment. Its process-local value contains the opaque environment id, registered backend, optional kernelspec name, and generation. Successful attach, restart, and recovery advance generation exactly once.

Execute and inspect return typed `ENVIRONMENT_REQUIRED` before an environment is selected. When a selection exists but its process-local handle is missing, they recover it before continuing. Failed startup leaves the selection unchanged and remains visible through runtime status. Calls for one kernel serialize through one queue, while different notebook kernels may execute concurrently.

Each live or starting kernel records the complete `SandboxExecutionPolicy` used at startup. A committed sandbox-mode change synchronously makes mismatched records unavailable, aborts active and queued work, and begins retirement. Every kernel publication point checks the current policy. Shutdown, replacement, provider disposal, and failed startup abort owned work, terminate the complete process tree through the Provider, and await settlement.

The Jupyter Provider launches a bounded newline-delimited JSON supervisor through `ctx.subprocess`, using only launch data resolved by `ctx.notebookEnvironments`. The supervisor preserves streams, structured errors, execution results, MIME bundles, metadata, display ids, clear-output behavior, and execution counts. A timed-out or over-limit execution interrupts the kernel and requires a matching idle reply; failure to prove idle retires the kernel.

### uv owns one workspace environment

The uv Provider resolves a configured uv executable, a compatible executable on its scrubbed PATH, then a DSH-private installation. The private path installs fixed uv `0.11.32` from committed official-release archives: download size is bounded, SHA-256 is verified before extraction, publication is atomic, and the operation never runs a remote installer script, changes PATH or a shell profile, enables self-update, or writes project dependency files.

Private uv installation and Python `3.12` download are separate explicit operations. Both write only below the DSH tools home, do not register themselves with the system, and require `danger-full-access`. Creating, enabling, repairing, or rebuilding the workspace `.venv` requires `workspace-write` or `danger-full-access`; the provider never raises permission itself.

Provisioning targets exactly `.venv` and installs the Provider's hash-locked `jupyter_client==8.9.1` and `ipykernel==7.3.0` set with fixed arguments. It does not run `uv sync`, discover a project manifest, change `pyproject.toml` or `uv.lock`, build source distributions, or accept browser-supplied packages, indexes, commands, or environment paths.

Catalog discovery does not execute an untrusted existing `.venv`. Explicitly enabling an unmanaged environment may update it in place, but ownership is recorded only after dependency and kernelspec verification. Rebuild is a separate destructive confirmation accepted only when a matching ownership sidecar proves that DSH owns the target. Staging markers and backups support retry after cancellation or process failure; malformed, foreign, linked, and unmarked lookalikes are never removed. Provider subprocesses use fixed arguments, a scrubbed environment, bounded output, configurable deadlines, cancellation, and terminate-plus-join teardown.

### Model, Host, and browser experience

The model Consumer splits strict `notebook_open` from `notebook_create`; the other tools read, edit, insert, execute, restart, reload, and inspect. Detached read and edit operations succeed. Detached execution returns a structured `ENVIRONMENT_REQUIRED` result without a traceback, and no model tool can install uv or Python, provision an environment, select an interpreter path, or supply subprocess arguments.

The plugin-owned Typert Remote separates document discovery, strict open and create, environment catalog, explicit uv and Python installation, provisioning, attachment, and runtime status. Environment failures carry stable manager, Python, permission, dependency, kernelspec, or kernel-start details; bounded stderr stays in Host diagnostics rather than the ordinary browser message.

The browser waits for its Session to open before discovery. Its launcher shows zero, one, or many candidates without automatically opening the sole result, retains explicit New and Open by path actions, and preserves earlier results when a later page fails. Open documents use a keyboard-operable selector and one active canvas. Draft, busy, error, kernel, and scroll state are isolated per document for the current process.

Missing environment setup appears in place without covering document content. Run, Run all, Inspect, and Restart remain disabled while detached. The environment card exposes only the confirmations authorized above and attaches a ready environment automatically; a Run-triggered setup continues the original run. The header action can restore a notebook column hidden by responsive layout.

The browser selects one supported MIME alternative with `text/plain` fallback. Streams and structured errors render directly. HTML and SVG use deny-by-default CSP isolation; bounded Plotly, Vega-Lite, and table projections omit excess data visibly. Raster attachments are read through the plugin-owned Remote after exact event-reference validation, rendered through revocable object URLs, and never widened to bearer or data-URL access.

### Composition

Installing `@younthing/dsh-notebook` into a profile mounts the Service Definitions, uv environment Provider, Jupyter Provider, plugin-owned Remote, model Consumer, and browser companion. The installation is an explicit profile-level opt-in, so the nine model tools are available to every Agent preset in that profile, including `minimal`. Missing uv, Python, or `.venv` components are runtime catalog states with explicit recovery actions; they do not make application boot or document access silently incomplete.

## Consequences

Document work survives missing runtime dependencies, and every trusted executable decision remains on the Host. This separation adds explicit detached, environment, and kernel lifecycle states to every Consumer and requires durable environment identity to outlive process-local handles.

The workspace file is the durable document. Harness restart clears the open-document list, selected environments, kernel handles, and browser state; users reopen the same `.ipynb` file. A live kernel can contain variables that no cell source records. Restart and Run All make that state disposable; inspect can expose a named value, but the product does not claim dependency analysis or reproducible execution ordering.

One uv-managed workspace `.venv` gives setup a predictable security and recovery model, but it excludes Conda, arbitrary environment locations, free-form package installation, `uv sync`, file watchers, and automatic polling. Explicit Python installation and owned rebuild require an extra confirmation instead of optimizing for one-click completion.

Code and Raw cells use a textarea. Interactive JavaScript widgets, arbitrary notebook HTML scripts, full Plotly or Vega runtimes, molecular 3D, cell deletion, cell reordering, and merge-based conflict resolution remain unsupported. Bounded static renderers and full-snapshot reload keep those omissions explicit without weakening CSP, authorization, or transaction rules.

## Verification

Core tests pin strict open and create, detached mutation, bounded discovery, containment and canonical deduplication, compare-and-swap, attach and recovery generations, reload retirement, old-event rejection, per-kernel serialization, cross-kernel concurrency, policy drift, and quiescent teardown. Environment tests pin manager precedence, release integrity, permission states, explicit Python installation, unmanaged enablement, ownership-proved rebuild and recovery, manifest non-modification, cancellation, bounded subprocesses, and launch resolution without browser path disclosure.

Host and Consumer tests pin cold discovery, typed RPC errors, tool separation, structured detached execution, per-document UI state, environment confirmation and automatic continuation, responsive panel recovery, MIME isolation, real built bundles, and keyless assembled interaction. Real uv and Jupyter integration remains opt-in because it downloads or depends on platform executables; CI fixtures cover Windows, Linux, and macOS resolution while local execution proves only the current host.

## Alternatives considered

**Automatically open the only discovered notebook.** Rejected because a read-only scan would then create durable Session state and could indirectly start runtime work. Discovery always waits for user confirmation.

**Install through a remote script or run `uv sync`.** Rejected because either delegates trusted executable or dependency selection outside the Provider and can modify the project's dependency model. Verified archives and a locked Notebook-only dependency set keep those effects fixed.

**Let the browser or model provide environment paths and commands.** Rejected because opaque ids are sufficient for selection, while executable paths, package indexes, and arguments belong to trusted Host policy.

**iframe JupyterLab.** Rejected because it creates a second UI, permission, identity, and persistence system outside the Harness plugin graph.

**Persistent CodeRuntime or terminal-driven IPython.** Rejected because neither supplies a logged cell document and typed MIME mutation history without changing an existing capability's obligations.

**Papermill-style whole-file execution.** Useful for batch automation, but it does not provide co-authored interactive state or selective execution.
