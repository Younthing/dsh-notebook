# Agent Note: Notebook 能力 seam

Status: implemented

[English](2026-08-14-notebook-capability-seam.md) | 中文

## Problem

科研与机器学习用户需要一份交互式计算文档：有序 cell、持久 kernel 内存、丰富 MIME 输出、选择性重跑，以及可以带走的 workspace 文件。DeepSeek Harness 已有每次新进程的 Code Mode 与持久终端会话，但两者都不会把 Notebook cell 与 MIME 输出表示成可从会话重建的事实。

即使 Python、Jupyter 或环境管理器不可用，Notebook 文档仍必须可用。若把 kernel 当作发现或编辑的前提，一项可恢复的运行时设置问题就会表现为文档丢失。反之，若允许浏览器选择可执行文件路径、包、索引或子进程参数，则会把可信 Host 策略转移到不可信客户端。

嵌入 JupyterLab 会把插件组合、权限、会话身份与模型可见性分裂到两个应用。通过终端驱动 IPython 会把 cell 与丰富输出压成无类型文本。让 CodeRuntime 持久化会破坏它的全新运行保证，并使跨调用状态留在其已记录执行模型之外。因此，Code Mode 继续拒绝把持久 REPL 放进 `run_code`；本笔记拥有独立的 Notebook 能力。

## Decision

Notebook 是完整、独立安装的能力：包含 workspace 支持的文档、独立的 Python 环境能力、可替换 kernel 提供方，以及 Host、模型与浏览器消费方。rc.6 版本把文档投影保留在进程内，并以 `.ipynb` 文件作为持久化事实来源。它不修改 agent loop。

### 包所有权

| 包 | 角色与所有权 |
|---|---|
| `@younthing/dsh-notebook` | 可安装 bundle；通过一个 profile patch 激活完整能力 |
| `@younthing/dsh-notebook-core` | Service Definition；通过 `ctx.notebooks` 拥有发现、文档、文件事务、进程内投影、kernel 注册、串行化与拆卸 |
| `@younthing/dsh-notebook-environment` | Service Definition；通过 `ctx.notebookEnvironments` 拥有浏览器安全环境目录、不透明环境 id、配置操作、类型化失败与可信启动解析 |
| `@younthing/dsh-notebook-environment-uv` | 提供方；拥有私有 uv 安装、Python 发现与安装、workspace `.venv` 配置、所有权恢复与解释器启动解析 |
| `@younthing/dsh-notebook-kernel-jupyter` | 提供方；通过受管 subprocess 与 sandbox 服务，从已解析环境启动 `jupyter_client` |
| `@younthing/dsh-tool-notebook` | 模型消费方；注册九个文档与执行工具，以及有界的人发起执行 inject |
| `@younthing/dsh-notebook-remote` | Host 消费方；推导可信 workspace 与权限策略，并暴露 `notebooks` Typert Remote namespace |
| `@younthing/dsh-client-ui-notebook` | 浏览器消费方；拥有文档选择、编辑、执行控制、环境设置与丰富输出渲染 |

提供方与消费方都依赖自身的 Service Definition，彼此互不依赖。浏览器安全类型导出包含不透明 id、持久值、目录条目与类型化错误详情；不暴露 Cordis 服务、绝对解释器路径、kernelspec 资源目录、可执行参数或 Host 实现类型。

### 没有 kernel 时 ipynb 文件仍可用

`NotebookService.open()` 只接受已有 workspace `.ipynb`，`create()` 只原子创建不存在的路径。Open 缺失会报告 `NOT_FOUND`；并发 create 的失败方会报告 `ALREADY_EXISTS`；两者都不会覆盖或启动 kernel。两者通过 `notebook/open` 与 `notebook/cell` 发布完整文档，因此 detached 状态仍可 read、edit、insert、discover 与 reload。

Service Definition 通过有界 `ctx.fs` 遍历发现 workspace 相对 `.ipynb` 路径，不读取文件内容。规范目标去重、containment 检查、排除目录名、深度和结果限制、稳定分页、过期 cursor 拒绝、取消与 partial 结果约束 symlink 和大型目录树。Host 从 Session header 推导扫描根，不会只为发现文件而恢复 Agent。

同一个精确 Session 实例内的规范文件系统目标会合并；不同 Session 保留独立 kernel 状态，并通过文件版本竞争。Cell 编辑、稳定锚点插入与执行结果都会先通过 compare-and-swap 替换文件，之后才更新插件内投影。外部编辑产生类型化 `WRITE_CONFLICT`，且保持投影不变。

`reload()` 接受一个稳定的外部修订版，并发布完整 `notebook/reload` 快照。它保留已选环境，退役旧的进程内 kernel，但不启动替换项。下一次执行或检查可以恢复该已选环境。Reload 是整份文档接纳，不是合并。

### Kernel 选择与句柄仅在进程内保留

首次成功显式 attach 前，`NotebookDocument.kernel` 不存在。其持久值包含不透明环境 id、已注册 backend、可选 kernelspec 名称与 generation。成功 attach、restart 与 recovery 都发布同一种 `notebook/kernel` 事件，并恰好推进一次 generation。预发布 log 会拒绝已取代的 `notebook/restart` 格式，而不保留兼容层。

环境尚未选择时，execute 与 inspect 返回类型化 `ENVIRONMENT_REQUIRED`。已有选择但进程内 handle 丢失时，两者会先恢复再继续。启动失败不发布 kernel 事件，并通过运行时状态保持可见。一个 kernel 的调用通过同一队列串行化，不同 Notebook kernel 可以并发执行。

每个 live 或 starting kernel 都记录启动时的完整 `SandboxExecutionPolicy`。已提交的 sandbox mode 变更会同步使不匹配记录不可用，取消 active 与 queued 工作，并开始退役。每个 kernel 发布点都会检查当前策略。Shutdown、替换、提供方 dispose 与失败启动会取消自身工作，通过提供方终止完整进程树，并等待结算。

Jupyter 提供方通过 `ctx.subprocess` 启动有界的换行分隔 JSON supervisor，并只使用 `ctx.notebookEnvironments` 解析的启动数据。Supervisor 保留 stream、结构化错误、执行结果、MIME bundle、metadata、display id、clear-output 行为与 execution count。超时或超限执行会 interrupt kernel，并要求匹配的 idle 回复；无法证明 idle 时会退役 kernel。

### uv 拥有一个 workspace 环境

uv 提供方依次解析配置的 uv 可执行文件、scrubbed PATH 上的兼容可执行文件与 DSH 私有安装。私有路径从已提交的官方发行包安装固定 uv `0.11.32`：下载大小受限，提取前校验 SHA-256，原子发布，且操作绝不运行远程安装脚本、修改 PATH 或 shell profile、启用 self-update，或写入项目依赖文件。

私有 uv 安装与 Python `3.12` 下载是不同的显式操作。两者都只写入 DSH tools home 下方，不向系统注册，并要求 `danger-full-access`。创建、启用、修复或重建 workspace `.venv` 要求 `workspace-write` 或 `danger-full-access`；提供方绝不会自行提升权限。

配置目标固定为 `.venv`，并用固定参数安装提供方的 hash-locked `jupyter_client==8.9.1` 与 `ipykernel==7.3.0` 集合。它不运行 `uv sync`、发现项目 manifest、修改 `pyproject.toml` 或 `uv.lock`、构建 source distribution，也不接受浏览器提供的包、索引、命令或环境路径。

目录发现不会执行不可信的已有 `.venv`。显式启用未托管环境可以原位更新它，但只会在依赖与 kernelspec 验证后记录所有权。Rebuild 是独立破坏性确认，且只在匹配的 ownership sidecar 证明 DSH 拥有目标时才接受。Staging marker 与 backup 支持在取消或进程失败后重试；malformed、foreign、linked 与 unmarked lookalike 绝不删除。提供方子进程使用固定参数、scrubbed 环境、有界输出、可配置 deadline、取消，以及 terminate-plus-join 拆卸。

### 模型、Host 与浏览器体验

模型消费方把严格 `notebook_open` 与 `notebook_create` 拆开；其他工具负责 read、edit、insert、execute、restart、reload 与 inspect。Detached read 与 edit 操作成功。Detached execute 返回结构化 `ENVIRONMENT_REQUIRED` 结果且没有 traceback；模型工具都不能安装 uv 或 Python、配置环境、选择解释器路径或提供子进程参数。

插件自有 Typert Remote 分离文档发现、严格 open 与 create、环境目录、显式 uv 与 Python 安装、provision、attach 与运行时状态。环境失败携带稳定的 manager、Python、permission、dependency、kernelspec 或 kernel-start 详情；有界 stderr 留在 Host 诊断中，不进入普通浏览器消息。

浏览器等待 Session 打开后再开始发现。Launcher 显示零个、一个或多个候选，不会自动打开唯一结果；显式 New 与按路径 Open 动作始终可用；后续页面失败时保留先前结果。已打开文档使用可键盘操作的选择器与单一 active canvas。Draft、busy、error、kernel 与滚动状态会在当前进程中按文档隔离。

环境缺失设置原位显示，不会覆盖文档内容。Detached 时 Run、Run all、Inspect 与 Restart 保持禁用。环境卡只暴露上述授权确认，并在环境 ready 后自动 attach；由 Run 触发的设置会续办原 Run。Header action 可以恢复因响应式布局隐藏的 Notebook 列。

浏览器选择一个受支持 MIME 备选，并以 `text/plain` fallback。Stream 与结构化错误直接渲染。HTML 与 SVG 使用默认拒绝的 CSP 隔离；有界 Plotly、Vega-Lite 与表格投影会显示省略数据。光栅附件由插件自有 Remote 在精确事件引用校验后读取，经可撤销 object URL 渲染，且绝不会扩大成 bearer 或 data-URL 访问。

### 组合

把 `@younthing/dsh-notebook` 安装进 profile 后，会挂载 Service Definition、uv 环境提供方、Jupyter 提供方、插件自有 Remote、模型消费方与浏览器 companion。安装是显式的 profile 级 opt-in，因此九个模型工具会对该 profile 的所有 Agent preset 可用，包括 `minimal`。缺失 uv、Python 或 `.venv` 组件是带显式恢复动作的运行时目录状态，不会让应用 boot 或文档访问静默缺功能。

## Consequences

缺少运行时依赖时仍可处理文档，而且每个可信可执行决策都保留在 Host。这项分离会给每个消费方增加显式 detached、environment 与 kernel 生命周期状态，并要求持久环境身份比进程内 handle 更长寿。

Workspace 文件与 Session log 在每次已发布变更上一致，但 live kernel 仍可能含有任何 cell source 都未记录的变量。Restart 与 Run All 让该状态可丢弃；inspect 可以暴露一个具名值，但产品不声称提供依赖分析或可复现执行排序。

一个由 uv 管理的 workspace `.venv` 带来可预测的设置安全与恢复模型，但排除 Conda、任意环境位置、自由包安装、`uv sync`、文件 watcher 与自动轮询。显式 Python 安装与 owned rebuild 要求额外确认，而不追求一次点击完成。

Code 与 Raw cell 使用 textarea。交互式 JavaScript widget、任意 Notebook HTML 脚本、完整 Plotly 或 Vega runtime、分子 3D、cell 删除、cell 重排与基于合并的冲突恢复不受支持。有界静态渲染器与全快照 reload 让这些缺口保持明确，而不削弱 CSP、授权或事务规则。

## Verification

Core 测试钉住严格 open 与 create、detached mutation、有界发现、containment 与规范去重、compare-and-swap、attach 与 recovery generation、reload retirement、旧事件拒绝、每 kernel 串行化、跨 kernel 并发、策略漂移与完全停稳的 teardown。环境测试钉住 manager 优先级、发行包完整性、权限状态、显式 Python 安装、未托管环境启用、所有权证明 rebuild 与恢复、不修改 manifest、取消、有界子进程，以及不向浏览器泄露路径的启动解析。

Host 与消费方测试钉住冷发现、类型化 RPC 错误、工具分离、结构化 detached execute、每文档 UI 状态、环境确认与自动续办、响应式面板恢复、MIME 隔离、真实构建 bundle 与无钥组装交互。真实 uv 与 Jupyter 联调会下载或依赖平台可执行文件，因此保持 opt-in；CI fixture 覆盖 Windows、Linux 与 macOS 解析，而本地执行只证明当前 Host。

## Alternatives considered

**自动打开唯一发现的 Notebook。** 拒绝，因为只读扫描会因此创建持久 Session 状态，并可能间接启动运行时工作。发现始终等待用户确认。

**通过远程脚本安装或运行 `uv sync`。** 拒绝，因为两者都会把可信可执行或依赖选择交给提供方之外，并可能修改项目依赖模型。已验证发行包与锁定的 Notebook 专用依赖集合使这些效果固定。

**让浏览器或模型提供环境路径与命令。** 拒绝，因为不透明 id 足以完成选择，而可执行路径、包索引与参数属于可信 Host 策略。

**iframe JupyterLab。** 拒绝，因为它会在 Harness 插件图之外建立第二套 UI、权限、身份与持久化系统。

**持久 CodeRuntime 或终端驱动 IPython。** 拒绝，因为若不改变现有能力的义务，两者都无法提供已记录的 cell 文档与类型化 MIME 变更历史。

**Papermill 式整文件执行。** 适合批处理自动化，但不提供共著交互状态或选择性执行。
