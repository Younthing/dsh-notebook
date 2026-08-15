# @younthing/dsh-notebook-kernel-jupyter

[English](README.md) | 中文

`ctx.notebooks` 的 Jupyter 内核 Service Provider。插件注册 `jupyter` 后端；独立安装组合包会挂载它，首次启动内核时才通过托管的 `ctx.subprocess` 服务启动 `supervisor/dsh_notebook_supervisor.py`。启动前，Provider 会通过 `ctx.notebookEnvironments` 解析 Notebook 的 opaque environment ID；浏览器和持久 Notebook 状态都不会收到 executable path。关闭、取消、协议失败或无法恢复的执行超时会终止整个 supervisor 进程树，并等待它完全停止。

notebook Service Definition 在启动内核前为当前 session 解析 `SandboxExecutionPolicy`。受限策略通过 `ctx.sandbox` 约束 supervisor 命令；只有 `danger-full-access` 会直接运行命令。工作目录依次取 provider `cwd`、notebook 启动 `cwd`、策略的 `workspaceRoot`。子进程环境以标准的 credential 与 `DSH_*` 清理结果为基础，移除继承的 `JUPYTER_*` 与 IPython 搜索和配置变量，并且只补充确定且不含 secret 的控制项。

## 运行时与配置

所选 environment 会提供 Host 侧的 absolute Python executable 与原生 `python3` kernelspec。supervisor 会禁用 ambient kernelspec directory，通过空搜索列表的 `KernelSpecManager` 解析 `python3`，并在启动前验证其 resource directory 等于所选 interpreter 的 `ipykernel` resource。其他持久 `kernelName`、恶意 global `python3` override 或缺失的固定 dependency 都会返回 typed failure；provider 不提供精简 interpreter fallback。environment 解析和启动失败会保留稳定的 code、category 与 retryability；有界 supervisor stderr 只写入 Host log。

可选真实 Provider 测试位于 `packages/notebook-kernel-jupyter/tests/real-environment.spec.ts`。Windows、Linux 与 macOS 在没有设置 `DSH_NOTEBOOK_REAL_E2E=1` 时都会自行跳过；显式启用后，测试会通过真实 uv Provider 安装已确认的 managed Python 3.12，provision 带 hash lock 的工作区 `.venv`，在 `workspace-write` 下启动并执行 Jupyter kernel，验证工作区外写入被拒绝，并在 shutdown 后逐字节比较预先写入的 `pyproject.toml`、`uv.lock` 与 `requirements.txt`。

provider 不提供 executable path 或 kernelspec 配置。配置校验会拒绝空的工作目录字符串，也会拒绝带小数的计时或字节限制。

`startupTimeoutMs`、`executionTimeoutMs`、`interruptTimeoutMs`、`inspectTimeoutMs` 与 `shutdownTimeoutMs` 的默认值依次为 30 秒、120 秒、5 秒、30 秒与 10 秒。supervisor 自有工作完成后，`responseGraceMs` 为宿主 RPC 响应额外保留 1 秒；进程树终止升级前，`graceMs` 提供 3 秒宽限。执行超时或输出超限时，supervisor 会中断 Jupyter 内核并等待对应的 idle 回复；无法确认 idle 会令 RPC 进入致命失败，provider 随后丢弃该内核。

`maxCellOutputBytes`、`maxInspectBytes` 与 `maxStderrBytes` 的默认值依次为 16 MiB、1 MiB 与 64 KiB。cell 限额会统计每个完整且有序的 mutation，包括全部 MIME 候选、metadata、结构化错误、clear 与 display update。supervisor 会在发送响应前执行 cell 与 inspect 限制；配置可设的对应安全上限依次为 64 MiB、4 MiB 与 4 MiB。`maxResponseBytes` 另行限制每条 UTF-8 JSON 响应行，默认为 32 MiB，可配置范围为 256 bytes 至 64 MiB，宿主 decoder 也会执行该限制。

Jupyter 的 `stream`、`display_data`、`execute_result`、`update_display_data`、`clear_output` 与错误消息会保留原有顺序和 operation。rich record 会保留完整的文本、JSON 与规范 base64 MIME bundle，以及 Jupyter metadata 和 display identity。每个 execution 终态都报告内核提供的非负 execution counter；缺失 counter 属于协议失败。

## 模型体验

### 间接模型入口

#### 模型可见内容

无直接可见内容。`@younthing/dsh-tool-notebook` Consumer 负责 Tool schema 与模型可见结果文本。

#### Token 影响

无直接影响。

#### KV Cache 影响

无直接失效。

## 已知限制与后续工作

- 内核状态仍只存在于进程中。provider 负责 supervisor transport 与整个进程树的 teardown；notebook Service、tool 和 UI 暴露显式 restart，Service 会记录每次替换的 generation，并通过 reload 提供完整快照恢复。Harness 进程重启仍会丢失 live kernel state，因此调用方必须显式 restart 或 reload，才能继续依赖新内核。
- 在 Windows `workspace-write` 模式下，沙箱会为每个 session 分配私有临时目录，但受限 token 无法替换 Jupyter 连接文件的 DACL。因此，provider 只在这个组合下启用 Jupyter Core 的 `JUPYTER_ALLOW_INSECURE_WRITES` 逃生开关；连接文件仍位于该 session 的私有临时目录内。`danger-full-access` 保留 Jupyter 的常规 DACL 改写，而 `read-only` 因没有可写临时能力而继续明确失败。supervisor 还会把内核进程的标准输入连接到 NUL；Jupyter 输入仍通过其 ZMQ channel 可用。两个进程都会保留受限 token，provider 绝不会在启动失败后改为不受约束地重试。
- 本 provider 不安装 Python 包。所选 environment provider 必须提供兼容的 Jupyter dependencies 与其声明的 kernelspec；`@younthing/dsh-notebook-environment-uv` 会 provision 固定版本的默认 environment。
