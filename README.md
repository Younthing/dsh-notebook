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

The bundle activates the Host service, uv environment provider, Jupyter kernel provider, browser Remote, Web companion panel, and all twelve model tools. Installing it into another profile enables the same complete capability there, including `minimal`; installation is an explicit profile-level opt-in.

Remove it with:

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
```

## What it provides

- `.ipynb` compare-and-swap persistence with a process-local document projection.
- Discovery, open, create, detached editing, insertion, reload, and multi-document state.
- Private uv-managed Python environments and a Jupyter kernel backend.
- Stream, error, JSON, HTML, Markdown, image attachment, and Plotly-capable MIME rendering.
- Twelve model tools: `notebook_open`, `notebook_create`, `notebook_read`, `notebook_edit_cell`, `notebook_insert_cell`, `notebook_delete_cell`, `notebook_move_cell`, `notebook_copy_cell`, `notebook_execute`, `notebook_restart`, `notebook_reload`, and `notebook_inspect`.
- A typed `ctx.remote.notebooks` Host/Web interface; a cold discovery or status read does not activate an Agent.

The user installs one plugin package. The repository keeps eight publishable packages because the Service Definition, environment provider, kernel provider, Remote, tool consumer, and browser consumer have different runtime dependencies and release surfaces. `@younthing/dsh-notebook` is the only package users should add directly.

## Environment and security

Notebook code is arbitrary code. Execution follows the Harness sandbox policy for the selected session, but it still has the permissions granted to that profile and workspace. Review notebook code and profile permissions before running it.

Environment setup is user-initiated in the Web UI. The provider downloads a checksum-verified uv `0.11.32`, installs Python 3.12 when requested, and provisions environments with `jupyter_client==8.9.1` and `ipykernel==7.3.0`. The model tools cannot install Python, create environments, choose executables, or attach a kernel.

## Development

### Requirements

- Node.js `^22.19.0 || >=24.0.0`.
- The repository-declared pnpm version (`11.7.0`).
- An installed `dsh` CLI compatible with this plugin: `>=0.1.0-rc.6 <0.2.0`.

The Notebook repository only requires `dsh` to be available on `PATH`; it does not require a DeepSeek Harness source checkout and does not inspect where DSH is installed. Verify the tools before setup:

```sh
node --version
pnpm --version
dsh --version
```

The supported DSH range follows the plugin packages' peer dependencies. Compatibility changes must update the peer ranges and pinned development dependencies together and be validated against an installed DSH release.

### Initial setup

Run every command in this section from the `dsh-notebook` repository root:

```sh
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add ./packages/notebook
dsh web --dump-config
```

The plugin installation is an explicit, one-time profile operation. It records `@younthing/dsh-notebook` as a local link to the current checkout. `pnpm run dev` never installs plugins or modifies a profile. In the dumped configuration, verify a `# == @younthing/dsh-notebook` layer containing `notebook-core`, `notebook-environment-uv`, `notebook-kernel-jupyter`, `notebook-remote`, `tool-notebook`, and `ui-notebook`.

The install and build steps are independent: `pnpm install --frozen-lockfile` and `pnpm run build` only access this repository, do not require the `dsh` CLI, and generate all publishable package artifacts, including `packages/client-ui-notebook/lib/client.cjs`.

To verify install, configuration, and removal without touching the real profile, run `pnpm run test:dsh-profile`. This explicit integration check uses the installed `dsh` from `PATH` and creates a temporary `DSH_HOME` that it always removes afterward. It is intentionally not part of `pnpm run dev` or the DSH-independent `pnpm run check` gate.

### Daily development

Keep two independent terminals open.

Terminal 1, from the Notebook repository root:

```sh
pnpm run dev
```

This performs one complete initial build, then runs the TypeScript, Host bundle, and Web client bundle watchers. It does not start DSH, inspect DSH installation paths or profiles, open a browser, watch a Web port, or send HMR messages. `Ctrl-C` stops all watchers; if one watcher fails, the development command fails as a group.

Terminal 2:

```sh
dsh web
```

The installed DSH owns the `web` profile, loads the local package link, serves the client bundle, and broadcasts Client HMR updates. The two processes can fail and restart independently.

### Reload behavior

| Change | How it becomes active |
| --- | --- |
| Notebook React components, panel, cell actions, MIME renderers, locale, CSS, client store/service, or client remote adapter | Automatic Client HMR after `client.cjs` rebuilds |
| Notebook Core, environment/kernel providers, Remote Host implementation, model tools, or other Node-side plugin code | Restart `dsh web`; keep `pnpm run dev` running |
| `package.json` `dsh.client` manifest | Restart `dsh web` |
| `cordis.patch.yml` plugin set | Restart DSH and verify the profile configuration again |
| User profile configuration | Follow the installed DSH profile watch/reload behavior |

Client HMR remounts the Notebook client plugin; it is not React Refresh, so temporary plugin-local React state can be lost. A failed remount does not automatically roll back to the previous bundle. Standard `dsh web` does not hot-replace Host plugins.

### Unlink the local checkout

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
```

To restore the registry version:

```sh
dsh plugin --profile web add @younthing/dsh-notebook
```

### Troubleshooting

If Notebook is absent from the Web UI, run `dsh web --dump-config` and confirm the Notebook bundle layer and its six plugin entries are present.

If client changes do not appear, confirm `packages/client-ui-notebook/lib/client.cjs` exists and is being rebuilt, then confirm `dsh web` is using the profile linked to this checkout.

If Host changes do not appear, this is expected: stop and restart `dsh web` while leaving `pnpm run dev` running.

If the profile still resolves the registry package, recreate the explicit local link:

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
dsh plugin --profile web add ./packages/notebook
```

Real Jupyter integration is opt-in and needs Python 3.12 plus Jupyter dependencies. Browser state restoration through Harness Session events is deferred until Harness publishes the required external-event API.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled/runtime-acquired components.

## License

[MIT](LICENSE)
