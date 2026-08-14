# @deepseek-ai/dsh-notebook-environment

[English](README.md) | 中文

这是用于发现、配置、显式接管与解析 Notebook Python 环境的 Service Definition。`ctx.notebookEnvironments` 的每个操作都会显式接收工作区根目录、已解析的沙箱策略和中止信号；会话选择与内核生命周期仍由 Notebook Consumer 管理。

`environmentCatalog()` 只返回可安全展示的管理器、Python 与环境条目。目录中的 id 是不透明值，任何字段都不会包含绝对路径或命令行。`installUv()` 与 `installPython({ version: '3.12' })` 是两个独立的显式操作。`provision({ allowExisting: false, rebuild: false })` 只创建新环境，并拒绝未由 DSH 管理的 `.venv`；`allowExisting: true` 才表示用户明确授权接管并更新现有环境。`rebuild: true` 是独立的替换授权，并且只在有效且匹配的 DSH sidecar 能证明所有权时生效。`resolveLaunch()` 仅供同进程 Consumer 使用，其中的绝对解释器路径不得序列化到浏览器 RPC。

失败通过 `NotebookEnvironmentError` 与稳定的 `NotebookEnvironmentErrorCode` 联合类型报告。取消会保留调用者的中止原因，而不会替换成环境错误码。

## Model Experience

### 间接模型暴露

#### 模型看到的内容

本包不直接向模型提供内容。任何模型可见的环境提示都由 `@deepseek-ai/dsh-tool-notebook` Consumer 管理。

#### Token 影响

无直接影响。

#### KV Cache 影响

不会直接失效。

## Known Limitations and Deferred Work

- 首个 Provider 每个工作区只支持一个 Python `.venv`。Service Definition 刻意不提供任意包安装、管理器参数或项目同步能力。
