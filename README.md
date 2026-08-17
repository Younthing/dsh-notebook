# dsh-notebook

[![CI](https://github.com/Younthing/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/Younthing/dsh-notebook/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@younthing/dsh-notebook)](https://www.npmjs.com/package/@younthing/dsh-notebook)
[![license](https://img.shields.io/github/license/Younthing/dsh-notebook)](LICENSE)

English | [中文](README.zh.md)

Notebook is an installable plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It gives agents and Web users workspace-backed `.ipynb` documents, Jupyter execution, rich MIME output, and reproducible Python environments without making Notebook part of the Harness core.

> Status: pre-release. The first release supports DeepSeek Harness `>=0.1.0-rc.6 <0.2.0` and uses the existing details panel. Notebook files are durable, while the open-document list and browser state are process-local; reopen a `.ipynb` file after restarting Harness.

## Install

Install the one public bundle into the profile where Notebook should be enabled:

```sh
dsh plugin --profile web add @younthing/dsh-notebook
```

The bundle activates the Host service, uv environment provider, Jupyter kernel provider, browser Remote, Web companion panel, and all nine model tools. Installing it into another profile enables the same complete capability there, including `minimal`; installation is an explicit profile-level opt-in.

Remove it with:

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
```

## What it provides

- `.ipynb` compare-and-swap persistence with a process-local document projection.
- Discovery, open, create, detached editing, insertion, reload, and multi-document state.
- Private uv-managed Python environments and a Jupyter kernel backend.
- Stream, error, JSON, HTML, Markdown, image attachment, and Plotly-capable MIME rendering.
- Nine model tools: `notebook_open`, `notebook_create`, `notebook_read`, `notebook_edit_cell`, `notebook_insert_cell`, `notebook_execute`, `notebook_restart`, `notebook_reload`, and `notebook_inspect`.
- A typed `ctx.remote.notebooks` Host/Web interface; a cold discovery or status read does not activate an Agent.

The user installs one plugin package. The repository keeps eight publishable packages because the Service Definition, environment provider, kernel provider, Remote, tool consumer, and browser consumer have different runtime dependencies and release surfaces. `@younthing/dsh-notebook` is the only package users should add directly.

## Environment and security

Notebook code is arbitrary code. Execution follows the Harness sandbox policy for the selected session, but it still has the permissions granted to that profile and workspace. Review notebook code and profile permissions before running it.

Environment setup is user-initiated in the Web UI. The provider downloads a checksum-verified uv `0.11.32`, installs Python 3.12 when requested, and provisions environments with `jupyter_client==8.9.1` and `ipykernel==7.3.0`. The model tools cannot install Python, create environments, choose executables, or attach a kernel.

## Development

Requirements: Node.js `^22.19.0 || >=24.0.0`, pnpm 11, and DeepSeek Harness rc.6 packages.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run publint
pnpm run pack:verify
```

For linked local development, run `pnpm run dev`. It performs one complete
build, then keeps the TypeScript declaration output and every Host/browser
bundle current. A Harness profile with Host HMR enabled can reload Host plugin
changes from these outputs, while the Web client HMR chain reloads the rebuilt
Notebook browser bundle. When a DeepSeek Harness checkout is adjacent to this
repository, `pnpm run dev:dsh` starts both watchers and `dsh web` as one process
group.

Real Jupyter integration is opt-in and needs Python 3.12 plus Jupyter dependencies. Browser state restoration through Harness Session events is deferred until Harness publishes the required external-event API.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled/runtime-acquired components.

## License

[MIT](LICENSE)
