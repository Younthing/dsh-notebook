# @younthing/dsh-tool-notebook

English | [中文](README.zh.md)

Model-facing Consumer for `ctx.notebooks`. Registers nine tools — `notebook_open`, `notebook_create`, `notebook_read`, `notebook_edit_cell`, `notebook_insert_cell`, `notebook_execute`, `notebook_restart`, `notebook_reload`, and `notebook_inspect` — plus `executeNotebookCellAsUser()` for human-initiated execution paths.

The `@younthing/dsh-notebook` bundle mounts this consumer for every profile where the user installs Notebook. The consumer remains independent of the browser UI and kernel Provider.

```yaml
- id: tool-notebook
  name: '@younthing/dsh-tool-notebook'
```

## Operations and Limits

`notebook_open` opens only an existing workspace-backed `.ipynb`; `notebook_create` creates only an absent path. Neither accepts environment, backend, kernelspec, executable, or installation input. `notebook_read` returns the current folded document and stable cell ids. Insertion accepts `code`, `markdown`, or `raw`; omitting `afterCellId` inserts at the start, while a supplied id inserts immediately after that cell. Read, edit, and insertion work while the document is detached, and mutations await the notebook service's file commit before rendering the updated document.

With an attached environment, `notebook_execute` returns the terminal status, kernel execution count, and structured stream, display, execute-result, or error records. Rich records preserve every text, JSON, image-attachment, and inline-base64 MIME alternative plus metadata and display identity. A detached execution returns `{status:"environment-required",code:"ENVIRONMENT_REQUIRED",message}` without fabricating an execution id, count, or output; the system prompt directs the model to ask the user to select an environment in the notebook UI and forbids retry or installation attempts. The tool set exposes no environment-manager installation, Python installation, provisioning, attachment, path, or argv operation. `notebook_restart` replaces the selected environment's kernel only after a successful replacement starts and preserves the Host-owned backend and kernelspec selection.

After a CAS `WRITE_CONFLICT`, `notebook_reload` explicitly accepts the current external `.ipynb` as the complete document snapshot. Reload publishes the new cells, metadata, and file revision without replacing or changing the selected environment; it does not merge the external file with the prior folded document.

`maxResultBytes` defaults to 256 KiB and has a minimum of 128 bytes. Document, inspect, and execution rendering stop consuming further source, metadata, MIME, attachment, or traceback fields once the complete UTF-8 result reaches the limit. `executeNotebookCellAsUser()` separately defaults its injected summary to 64 KiB.

## Model Experience

### Direct consumer

#### What the model sees

Nine generic-card notebook tools that strictly open or create workspace-backed documents, read stable cell ids, insert or edit all nbformat cell kinds while detached, execute code after UI attachment, replace selected kernels, explicitly accept external snapshots, inspect variables, and return bounded summaries of complete structured outputs.

#### Token effect

Each tool result adds at most `maxResultBytes` of notebook document text, execution output, inspection text, or a compact operation acknowledgement when the model invokes a notebook tool.

#### KV Cache effect

Tool schemas and the `tool:notebook` prompt section invalidate the request prefix when this consumer loads or its guidance changes.

## Known Limitations and Deferred Work

- The model tool set does not expose kernel interruption. Host and UI Stop controls own interruption so a model cannot cancel a concurrent human execution without explicit user intent.
- Environment discovery, installation, provisioning, and attachment remain Host/UI operations; the model receives only the structured `ENVIRONMENT_REQUIRED` result.
- Cell deletion and reordering are not model tools; insertion supports only the start or a stable `afterCellId` anchor.
- Reload is an explicit full-snapshot replacement, not a cell merge; callers should first inspect the externally edited file before accepting it.
- User-initiated execution requires `executeNotebookCellAsUser()` outside the model tool surface.
- No dependency on `@younthing/dsh-notebook-kernel-jupyter`; the install bundle mounts that Provider separately.
