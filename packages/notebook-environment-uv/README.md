# @younthing/dsh-notebook-environment-uv

English | [中文](README.zh.md)

uv Service Provider for `ctx.notebookEnvironments`. Manager discovery is deterministic: configured `uvExecutable`, a compatible uv 0.9 through 0.11 on the subprocess provider's scrubbed PATH, then a DSH-private executable. A configured executable fails loud when unusable; an unusable or incompatible PATH command cannot block the private fallback. The private fallback is uv 0.11.32 from the [official release](https://github.com/astral-sh/uv/releases/tag/0.11.32); this package commits the macOS, Windows, Linux glibc, and Linux musl x64/arm64 archive SHA-256 values, downloads with a complete byte cap, verifies before extraction, and publishes through a random exclusive sibling plus rename. It never runs the upstream installer, invokes `uv self update`, or changes PATH.

`installPython({ version: '3.12' })` is the only operation that permits uv to download Python, and it requires `danger-full-access`. All other uv commands set Python downloads to `never`. Private uv releases live under `$DSH_HOME/tools/uv`, Python stays under `$DSH_HOME/tools/python`, and neither is registered on PATH or the Windows registry.

Each workspace has one deterministic opaque environment id and one `.venv`. New environments are built in a random sibling with `uv venv --relocatable`, receive the committed hash-locked `jupyter_client==8.9.1` and `ipykernel==7.3.0` requirements through `uv pip install --require-hashes --no-deps --only-binary :all:`, pass an isolated import and `python3` kernelspec probe, receive a versioned ownership sidecar, and are renamed into place. No `uv sync`, project manifest discovery, source build, arbitrary package, command argument, or environment selector is accepted.

An existing `.venv` without the sidecar is neither executed nor changed during catalog discovery. `inspectExisting()` is the explicit, sandbox-confined health check after selection, and `provision({ allowExisting: true, rebuild: false })` authorizes attachment. Manager-based Python discovery uses only `uv python find 3.12 --managed-python` and `--system`; a candidate whose lexical or resolved path enters the workspace `.venv` is rejected before launch. Explicit attachment installs the same locked dependency set and writes the sidecar only after verification. A failed attachment can leave a partial dependency update in that user-authorized environment, but it does not claim ownership; retrying the fixed operation is safe.

`rebuild: true` is a separate destructive authorization. The provider replaces `.venv` only when a valid sidecar contains the matching opaque environment id. It builds and verifies the replacement first, moves the previous owned directory to a random backup, and publishes the replacement by rename. Failed staging directories and obsolete owned backups are atomically renamed to `.venv.dsh-residue-*` and never deleted automatically. A provision retry detects these names, emits at most one path-free warning, and never opens, renames, or reuses them. On the next explicit provision call, one owned rebuild backup restores a missing `.venv`; other recoverable staging and backup entries become retained residues. A structured process-owner lock permits recovery from a provably dead manager, while malformed, live, foreign, linked, or unmarked state is preserved and reported busy.

Every operation has a configurable 15-minute default deadline. Provider subprocesses receive a deterministic environment that removes inherited `UV_*`, `PIP_*`, Python activation, Python configuration, `JUPYTER_*`, and IPython variables. Stdout plus stderr is bounded; user-facing errors expose only stable code, category, and retryability, while bounded stderr and original causes remain in the Host log. Abort and provider teardown terminate and join the complete child process tree.

## Model Experience

### Indirect model exposure

#### What the model sees

Nothing directly. The `@younthing/dsh-tool-notebook` Consumer owns any model-visible setup guidance.

#### Token effect

None directly.

#### KV Cache effect

No direct invalidation.

## Known Limitations and Deferred Work

- Explicit attachment updates an existing user environment in place because replacing it would discard user packages. Dependency failure may leave some locked packages installed, but ownership is not published until the complete probe succeeds.
- `installUv()` and `installPython()` require `danger-full-access` because they write private runtime components under the DSH home. Creating, attaching, repairing, or explicitly rebuilding the workspace `.venv` accepts `workspace-write` or `danger-full-access` and confines every uv and Python subprocess to that policy.
- Retained `.venv.dsh-residue-*` entries can consume workspace disk space. DSH does not delete them because a concurrent workspace writer can replace a directory with a link to data outside the workspace; users may remove a residue manually after all notebook environment operations have stopped.
