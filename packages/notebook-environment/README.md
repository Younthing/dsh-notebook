# @younthing/dsh-notebook-environment

English | [中文](README.zh.md)

Service Definition for notebook Python environment discovery, provisioning, explicit attachment, and launch resolution. `ctx.notebookEnvironments` accepts the complete workspace root, resolved sandbox policy, and abort signal on every operation; session selection and kernel lifecycle remain owned by notebook Consumers.

`environmentCatalog()` returns browser-safe manager, Python, and environment entries. Catalog ids are opaque, and no catalog field contains an absolute path or command line. `installUv()` and `installPython({ version: '3.12' })` are separate explicit operations. `provision({ allowExisting: false, rebuild: false })` creates a new environment and refuses an unmanaged `.venv`; `allowExisting: true` is the explicit authorization to attach and update an existing environment. `rebuild: true` separately authorizes replacement only when a valid matching DSH sidecar proves ownership. `resolveLaunch()` is a same-process Consumer method whose absolute interpreter path must not be serialized to browser RPC.

Failures use `NotebookEnvironmentError` and the stable `NotebookEnvironmentErrorCode` union. Cancellation preserves the caller's abort reason rather than replacing it with an environment failure code.

## Model Experience

### Indirect model exposure

#### What the model sees

Nothing directly. The `@younthing/dsh-tool-notebook` Consumer owns any model-visible environment guidance.

#### Token effect

None directly.

#### KV Cache effect

No direct invalidation.

## Known Limitations and Deferred Work

- The first provider supports one Python `.venv` per workspace. The Service Definition intentionally does not expose arbitrary package installation, manager arguments, or project synchronization.
