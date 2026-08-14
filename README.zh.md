# dsh-notebook

[English](README.md) | 中文

Notebook 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可安装插件。它为智能体和 Web 用户提供持久化、基于工作区的 `.ipynb` 文档、Jupyter 执行、富 MIME 输出与可复现的 Python 环境，而不再把 Notebook 放进 Harness 核心。

> 状态：正在进行预发布提取。首个版本要求 DeepSeek Harness `>=0.1.0-rc.7 <0.2.0`；该版本提供本插件所需的外部 Remote、伴随面板、持久事件和浏览器测试扩展点。

## 安装

把唯一面向用户的组合包安装到需要启用 Notebook 的 profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-notebook
```

该组合包会启用 Host 服务、uv 环境提供器、Jupyter 内核提供器、浏览器 Remote、Web 伴随面板及全部九项模型工具。安装到其他 profile 时也会启用同一套完整能力，包括 `minimal`；安装本身就是明确的 profile 级选择。

卸载命令：

```sh
dsh plugin --profile web remove @deepseek-ai/dsh-notebook
```

## 提供的能力

- 持久化 `notebook/*` session 事件与使用比较交换写入的 `.ipynb` 文件。
- 发现、打开、创建、脱离内核编辑、插入、重载与多文档状态。
- 由私有 uv 管理的 Python 环境及 Jupyter 内核后端。
- stream、error、JSON、HTML、Markdown、图片附件及支持 Plotly 的 MIME 渲染。
- 九项模型工具：`notebook_open`、`notebook_create`、`notebook_read`、`notebook_edit_cell`、`notebook_insert_cell`、`notebook_execute`、`notebook_restart`、`notebook_reload` 和 `notebook_inspect`。
- 类型化 `ctx.remote.notebooks` Host/Web 接口；冷 session 的发现和状态读取不会激活 Agent。

用户只需安装一个插件包。仓库保留八个可发布包，是因为 Service Definition、环境提供器、内核提供器、Remote、工具 Consumer 和浏览器 Consumer 的运行时依赖及发布面不同。只有 `@deepseek-ai/dsh-notebook` 应由用户直接安装。

## 环境与安全

Notebook 代码属于任意代码。执行遵循所选 session 的 Harness 沙箱策略，但仍拥有该 profile 与工作区授予的权限。运行前请审查 Notebook 代码及 profile 权限。

环境设置只能由用户在 Web UI 中主动发起。提供器会下载经过校验和验证的 uv `0.11.32`，按需安装 Python 3.12，并使用 `jupyter_client==8.9.1` 与 `ipykernel==7.3.0` 创建环境。模型工具不能安装 Python、创建环境、选择可执行文件或附加内核。

## 开发

要求 Node.js `^22.19.0 || >=24.0.0`、pnpm 11，以及发布后的 DeepSeek Harness rc.7 包。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run publint
pnpm run pack:verify
```

真实 Jupyter 集成测试是可选项，需要 Python 3.12 与 Jupyter 依赖。迁移后的浏览器与完整 profile fixture 保留在 `tests/`；独立 runner 会基于公开 Harness rc.7 测试/应用接口启用，而不引用相邻源码目录。

贡献检查见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞私密报告方式见 [SECURITY.md](SECURITY.md)，随包或运行时获取的组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

[MIT](LICENSE)
