# dsh-notebook

[![CI](https://github.com/Younthing/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/Younthing/dsh-notebook/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@younthing/dsh-notebook)](https://www.npmjs.com/package/@younthing/dsh-notebook)
[![license](https://img.shields.io/github/license/Younthing/dsh-notebook)](LICENSE)

[English](README.md) | 中文

Notebook 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可安装插件。它为智能体和 Web 用户提供基于工作区的 `.ipynb` 文档、Jupyter 执行、富 MIME 输出与可复现的 Python 环境，而不再把 Notebook 放进 Harness 核心。

> 状态：预发布。首个版本支持 DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`，并使用现有的 details 面板。Notebook 文件会持久化，但已打开文档列表和浏览器状态仅保留在当前进程中；Harness 重启后需要重新打开 `.ipynb` 文件。

## 安装

把唯一面向用户的组合包安装到需要启用 Notebook 的 profile：

```sh
dsh plugin --profile web add @younthing/dsh-notebook
```

该组合包会启用 Host 服务、uv 环境提供器、Jupyter 内核提供器、浏览器 Remote、Web 伴随面板及全部十二项模型工具。安装到其他 profile 时也会启用同一套完整能力，包括 `minimal`；安装本身就是明确的 profile 级选择。

卸载命令：

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
```

## 提供的能力

- 使用比较交换写入的 `.ipynb` 文件与进程内文档投影。
- 发现、打开、创建、脱离内核编辑、插入、重载与多文档状态。
- 由私有 uv 管理的 Python 环境及 Jupyter 内核后端。
- stream、error、JSON、HTML、Markdown、图片附件及支持 Plotly 的 MIME 渲染。
- 十二项模型工具：`notebook_open`、`notebook_create`、`notebook_read`、`notebook_edit_cell`、`notebook_insert_cell`、`notebook_delete_cell`、`notebook_move_cell`、`notebook_copy_cell`、`notebook_execute`、`notebook_restart`、`notebook_reload` 和 `notebook_inspect`。
- 类型化 `ctx.remote.notebooks` Host/Web 接口；冷 session 的发现和状态读取不会激活 Agent。

用户只需安装一个插件包。仓库保留八个可发布包，是因为 Service Definition、环境提供器、内核提供器、Remote、工具 Consumer 和浏览器 Consumer 的运行时依赖及发布面不同。只有 `@younthing/dsh-notebook` 应由用户直接安装。

## 环境与安全

Notebook 代码属于任意代码。执行遵循所选 session 的 Harness 沙箱策略，但仍拥有该 profile 与工作区授予的权限。运行前请审查 Notebook 代码及 profile 权限。

环境设置只能由用户在 Web UI 中主动发起。提供器会下载经过校验和验证的 uv `0.11.32`，按需安装 Python 3.12，并使用 `jupyter_client==8.9.1` 与 `ipykernel==7.3.0` 创建环境。模型工具不能安装 Python、创建环境、选择可执行文件或附加内核。

## 开发

### 前置要求

- Node.js `^22.19.0 || >=24.0.0`。
- 仓库声明的 pnpm 版本（`11.7.0`）。
- 已安装且与本插件兼容的 `dsh` CLI：`>=0.1.0-rc.6 <0.2.0`。

Notebook 仓库只要求能从 `PATH` 调用 `dsh`，不需要 DeepSeek Harness 源码 checkout，也不会检查 DSH 安装位置。开始前验证：

```sh
node --version
pnpm --version
dsh --version
```

受支持的 DSH 范围以插件包的 peer dependency 为准。调整兼容范围时，必须同时更新 peer range 与固定的开发依赖，并针对已安装的 DSH 正式版本进行验证。

### 初始设置

本节所有命令都从 `dsh-notebook` 仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run build
dsh plugin --profile web add ./packages/notebook
dsh web --dump-config
```

安装插件是由开发者显式执行的一次性 profile 操作，会把 `@younthing/dsh-notebook` 记录为指向当前 checkout 的本地 link。`pnpm run dev` 不会安装插件，也不会修改 profile。在 dump 的配置中，应确认存在 `# == @younthing/dsh-notebook` 层，并包含 `notebook-core`、`notebook-environment-uv`、`notebook-kernel-jupyter`、`notebook-remote`、`tool-notebook` 和 `ui-notebook`。

安装与构建相互独立：`pnpm install --frozen-lockfile` 和 `pnpm run build` 只访问本仓库，不需要 `dsh` CLI，并会生成所有可发布包的产物，包括 `packages/client-ui-notebook/lib/client.cjs`。

如需在不接触真实 profile 的情况下验证安装、配置和卸载，可运行 `pnpm run test:dsh-profile`。这个显式集成检查使用 `PATH` 中已安装的 `dsh`，创建临时 `DSH_HOME`，并在结束时始终删除。它不会加入 `pnpm run dev`，也不会加入不依赖 DSH 的 `pnpm run check` 门禁。

### 日常开发

保持两个互相独立的终端。

终端一，在 Notebook 仓库根目录：

```sh
pnpm run dev
```

该命令先完成一次完整构建，再运行 TypeScript、Host bundle 和 Web client bundle watcher。它不会启动 DSH、检查 DSH 安装路径或 profile、打开浏览器、监听 Web 端口或直接发送 HMR 消息。`Ctrl-C` 会停止全部 watcher；任一 watcher 失败时，整个开发命令都会失败。

终端二：

```sh
dsh web
```

已安装的 DSH 负责读取 `web` profile、加载本地 package link、提供 client bundle，并广播 Client HMR 更新。两个进程可以独立失败与重启。

### 重载行为

| 修改内容 | 生效方式 |
| --- | --- |
| Notebook React 组件、panel、cell action、MIME renderer、locale、CSS、client store/service 或 client remote adapter | `client.cjs` 重建后自动 Client HMR |
| Notebook Core、环境／内核 provider、Remote Host 实现、model tool 或其他 Node 侧插件代码 | 保持 `pnpm run dev` 运行，重启 `dsh web` |
| `package.json` 中的 `dsh.client` manifest | 重启 `dsh web` |
| `cordis.patch.yml` 插件集合 | 重启 DSH 并重新验证 profile 配置 |
| 用户 profile 配置 | 遵循已安装 DSH 的 profile watch／reload 行为 |

Client HMR 会重新挂载 Notebook client plugin，并非 React Refresh，因此插件内部的临时 React 状态可能丢失。重新挂载失败时不会自动回滚旧 bundle。标准 `dsh web` 不会热替换 Host 插件。

### 解除本地链接

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
```

如需恢复 registry 版本：

```sh
dsh plugin --profile web add @younthing/dsh-notebook
```

### 排障

如果 Web UI 中没有 Notebook，运行 `dsh web --dump-config`，确认 Notebook bundle 层及其中六项插件配置存在。

如果 client 修改不生效，确认 `packages/client-ui-notebook/lib/client.cjs` 存在且 watcher 正在重建该文件，并确认 `dsh web` 使用的是链接到当前 checkout 的 profile。

如果 Host 修改不生效，这是预期行为：保持 `pnpm run dev` 运行，停止并重新启动 `dsh web`。

如果 profile 仍解析到 registry 包，重新建立显式本地 link：

```sh
dsh plugin --profile web remove @younthing/dsh-notebook
dsh plugin --profile web add ./packages/notebook
```

真实 Jupyter 集成测试是可选项，需要 Python 3.12 与 Jupyter 依赖。通过 Harness Session 事件恢复浏览器状态的能力会在 Harness 发布所需的外部事件 API 后加入。

贡献检查见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞私密报告方式见 [SECURITY.md](SECURITY.md)，随包或运行时获取的组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

[MIT](LICENSE)
