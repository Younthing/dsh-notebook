# @deepseek-ai/dsh-client-ui-notebook

English | [中文](README.zh.md)

Notebook occupies the AppFrame notebook column and incrementally projects durable `notebook/*` Session events. History loading, incomplete tails, and incompatible pre-release records are resolved before workspace discovery begins. The incompatible-history action archives the current Session before opening a replacement, so the old blank Session cannot be reused. When history is ready, the launcher discovers bounded pages of workspace `.ipynb` paths without reading files, starting an Agent, opening a document, or starting a kernel. Users explicitly open a candidate, create an absent path, or enter an existing path; Refresh and Load more keep discovery user-controlled.

Multiple open documents use a selector and one active scroll canvas. A user-opened document becomes active; a document opened by an Agent is announced without taking focus. Each document retains its own drafts, scroll position, mutation state, and kernel status. The session-header Notebook action remains keyboard-accessible over the blank-session Hero and can restore a panel hidden by responsive layout, while the document header can close it and return focus to that action. Entering Markdown edit mode focuses its textarea; Escape returns to the edit control. Code / Markdown / Raw insertion, Reload from disk, serial Run all, Stop execution, and the Colab-style run rail remain scoped to the active document. Run all follows document order and stops after the first error or cancellation.

Documents remain readable and editable without a selected environment. The in-place environment card discovers uv, Python, and the workspace `.venv`; it offers verified private uv installation, a separate Python 3.12 confirmation, fixed Notebook dependency provisioning, explicit attach, cancellation, and owned-environment rebuild confirmation. Run, Run all, Inspect, and Restart stay disabled until an environment is attached. Successful setup attaches automatically, including continuation of a Run-initiated recovery.

One rich output renders exactly one preferred supported MIME alternative, retaining `text/plain` as a failure fallback. Structured stdout/stderr and exceptions render directly; sandboxed HTML and SVG receive a deny-by-default CSP; parseable Plotly, Vega-Lite, and DataResource payloads use bounded DOM renderers with visible omission counts. Raster bundles carry immutable attachment references, never inline base64: the pane reads bytes through the current Session's authorized `readAttachment` face, creates a browser object URL, and revokes it when the output changes or unmounts.

Document, environment, and kernel operations go through the typed `ctx.remote.notebooks` namespace, including discovery, strict open and create, environment setup, attachment, and runtime status. A user-initiated run persists source, executes as the user, and injects a bounded output summary for the next model request. Reload atomically accepts the latest filesystem revision, retires the process-local kernel, preserves the selected environment, and discards local drafts for that document. A persistence write conflict identifies Reload from disk as the recovery action. The pane never imports or calls Host service runtimes.

The `@deepseek-ai/dsh-notebook` bundle mounts this browser Consumer with the Notebook Host packages. Install that bundle into the target Harness profile; do not add this implementation package directly.

## Model Experience

None, as the notebook view renders session data in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **CodeMirror deferred** — code and raw cells use a plain textarea, not CodeMirror 6.
- **Discovery is refresh-based** — v1 scans when the Session or panel becomes active and on explicit Refresh; it has no watcher or polling loop.
- **Interactive scientific renderers are partial** — Plotly and Vega-Lite use a bounded static SVG projection; widgets, arbitrary JavaScript, 3D molecules, and the full upstream renderers are not enabled.
