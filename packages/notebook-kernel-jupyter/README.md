# @younthing/dsh-notebook-kernel-jupyter

English | [中文](README.zh.md)

Jupyter kernel Service Provider for `ctx.notebooks`. The plugin registers backend type `jupyter`; the standalone install bundle mounts it, while the first kernel start lazily launches `supervisor/dsh_notebook_supervisor.py` through the managed `ctx.subprocess` service. Before launch, it resolves the notebook's opaque environment ID through `ctx.notebookEnvironments`; neither the browser nor durable notebook state receives an executable path. Shutdown, cancellation, protocol failure, and an unrecoverable execution timeout terminate the complete supervisor process tree and wait for it to stop.

The notebook Service Definition resolves a `SandboxExecutionPolicy` for the session before starting a kernel. Restricted policies confine the supervisor command through `ctx.sandbox`; only `danger-full-access` runs the command directly. The working directory resolves in this order: provider `cwd`, notebook start `cwd`, then the policy's `workspaceRoot`. The subprocess environment starts from the canonical credential and `DSH_*` scrub, removes inherited `JUPYTER_*` and IPython search/configuration variables, and adds only deterministic non-secret controls.

## Runtime and Configuration

The selected environment supplies an absolute Host-side Python executable and the native `python3` kernelspec. The supervisor disables ambient kernelspec directories, resolves `python3` through an empty `KernelSpecManager` search list, and verifies its resource directory equals the selected interpreter's `ipykernel` resources before starting it. Any other durable `kernelName`, hostile global `python3` override, or missing pinned dependency fails typed; there is no reduced-interpreter fallback. Environment resolution and startup failures remain typed as a stable code, category, and retryability flag; bounded supervisor stderr is retained only in Host logs.

The opt-in real-provider test is `packages/notebook-kernel-jupyter/tests/real-environment.spec.ts`. It self-skips on Windows, Linux, and macOS unless `DSH_NOTEBOOK_REAL_E2E=1`; when enabled, it installs explicit managed Python 3.12 through the real uv provider, provisions the hash-locked workspace `.venv`, starts and executes the Jupyter kernel under `workspace-write`, verifies a write outside the workspace is denied, and compares seeded `pyproject.toml`, `uv.lock`, and `requirements.txt` bytes after shutdown.

The provider has no executable-path or kernelspec configuration. Empty working-directory strings and fractional timer or byte limits are rejected during configuration validation.

`startupTimeoutMs`, `executionTimeoutMs`, `interruptTimeoutMs`, `inspectTimeoutMs`, and `shutdownTimeoutMs` default to 30 seconds, 120 seconds, 5 seconds, 30 seconds, and 10 seconds. `responseGraceMs` adds one second for the host RPC response after supervisor-owned work, while `graceMs` gives process-tree termination three seconds before escalation. An execution timeout or output limit interrupts the Jupyter kernel and waits for its matching idle reply; failure to confirm idle makes the RPC fatal so the provider discards the kernel.

`maxCellOutputBytes`, `maxInspectBytes`, and `maxStderrBytes` default to 16 MiB, 1 MiB, and 64 KiB. The cell limit counts each complete ordered mutation, including full MIME alternatives, metadata, structured errors, clears, and display updates. The supervisor enforces cell and inspect limits before sending a response; configuration cannot raise the respective safety maxima above 64 MiB, 4 MiB, and 4 MiB. `maxResponseBytes` separately bounds each UTF-8 JSON response line, defaults to 32 MiB, accepts 256 bytes through 64 MiB, and is also enforced by the host decoder.

Jupyter `stream`, `display_data`, `execute_result`, `update_display_data`, `clear_output`, and error messages retain their ordered operations. Rich records preserve the complete text, JSON, and canonical-base64 MIME bundle plus Jupyter metadata and display identity. Every terminal execution reports the kernel's non-negative execution counter; a missing counter is a protocol failure.

## Model Experience

### Indirect model exposure

#### What the model sees

Nothing directly. The `@younthing/dsh-tool-notebook` Consumer owns the tool schemas and model-visible result text.

#### Token effect

None directly.

#### KV Cache effect

No direct invalidation.

## Known Limitations and Deferred Work

- Kernel state remains process-local. The provider owns supervisor transport and process-tree teardown; the notebook Service, tool, and UI expose explicit restart, while the Service logs each replacement generation and exposes reload for full-snapshot recovery. A harness process restart still loses live kernel state, so the caller must explicitly restart or reload before relying on a fresh kernel.
- On Windows `workspace-write`, the sandbox gives each session a private temporary directory, but the restricted token cannot replace the DACL on Jupyter's connection file. The provider therefore enables Jupyter Core's `JUPYTER_ALLOW_INSECURE_WRITES` escape hatch only for that combination; the connection file stays under the session's private temporary directory. `danger-full-access` keeps Jupyter's normal DACL rewrite, while `read-only` still fails loudly because it has no writable temporary capability. The supervisor also binds the kernel process's standard input to NUL; Jupyter input remains available through its ZMQ channel. Both processes retain the restricted token, and the provider never retries a failed start without confinement.
- This provider does not install Python packages. The selected environment provider must supply compatible Jupyter dependencies and its advertised kernelspec; `@younthing/dsh-notebook-environment-uv` provisions the pinned default environment.
