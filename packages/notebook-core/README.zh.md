# @younthing/dsh-notebook-core

[English](README.md) | 中文

基于工作区文件的 Notebook 能力。`NotebookService` 注册为 `ctx.notebooks`，发现、创建、打开并原子更新 `.ipynb` 文件，让文档在没有 kernel 时仍可使用，并在进程内保留文档投影与已附加的 kernel 句柄直至关闭。

## 契约

- Kernel 后端注册唯一稳定的 `type`，负责 start、execute、inspect 与 shutdown。
- Notebook 路径必须是规范化的工作区相对 `.ipynb` 路径，规范解析后仍须位于会话工作目录内。`open()` 只接受已存在文件；`create()` 使用原子的仅缺失写入，绝不覆盖竞争胜者。
- `discoverWorkspace()` 只列出元数据，不读取文件内容。遍历顺序稳定、按规范目标去重，并受可配置的分页、条目数和深度限制；默认值分别为 50、500 和 12。默认排除 `.git`、`.hg`、`.svn`、`.venv`、`.ipynb_checkpoints` 与 `node_modules`。页面用 `partial` 报告被省略的子树，以精确的 `nextAfter` 路径续页，并在续页路径消失时抛出 `DISCOVERY_CURSOR_STALE`。
- 打开或创建会把完整文档加入进程内投影，但不选择或启动 kernel。`attachEnvironment()` 接受不透明的 `NotebookEnvironmentId`，仅在后端成功启动后更新投影。投影记录 `{ environmentId, backend, kernelName?, generation }`。
- 同一个精确 `Session` 实例内的规范文件系统目标会合并，因此别名无法为同一文件建立两个比较并交换写入所有者。不同会话保留独立 kernel，并通过文件版本竞争写入。
- `editCell()`、`insertCell()` 与执行完成会先使用已观察的 `FsVersion` 原子替换文件，再更新进程内投影。外部修改会抛出代码为 `WRITE_CONFLICT` 的 `NotebookPersistenceError`，且保持投影不变。未附加环境的文档仍可编辑。
- `reload()` 接受一个稳定的外部版本，准入其中的附件，替换进程内文档，并退役 live kernel、保留所选环境。下一次执行或检查会恢复该选择。`restart()` 替换所选环境的空闲 kernel，但不重写 notebook 元数据。
- 未选择环境时，`execute()` 与 `inspect()` 抛出 `ENVIRONMENT_REQUIRED`。存在已选环境但缺少进程内句柄时，两者会尝试恢复。成功的首次附加、重启与恢复都会使 `generation` 严格加一；启动失败会保持选择不变，其状态可由 `runtimeStatus()` 查询，但只携带不含提供方 stderr 或可执行文件路径的摘要。
- 同一 kernel 的调用串行执行；不同 notebook kernel 可并发执行。Kernel 输出修改保留 MIME bundle 与 display 更新，而栅格值会在更新文档投影前转换为附件引用。
- 每个已启动的代码执行都会在 `.ipynb` 执行计数与输出提交后，以明确的 `ok`、`error` 或 `cancelled` 结果结束。传输与输出准入失败会退役 kernel，不会伪装成代码执行成功。
- 每个 kernel 都会捕获启动时使用的完整 `SandboxExecutionPolicy`。持久 `sandbox/mode` 变更会同步取消策略不匹配的 active、queued 与 starting 工作，并开始退役句柄。之后的显式 restart 或自动恢复会按当前策略启动并发布新代次。
- 关闭会等待 kernel 队列与提供方 shutdown 均完全停稳。`shutdownTimeoutMs` 限制 Cordis 资源释放的等待时长：超时会记为失败，服务继续持有未结束的任务；仅当两者都成功结算后才释放句柄。拒绝则保留一条 `shutdown-failed` 记录。
- 服务依赖 `attachments`、`fs` 与 `sandboxPolicy`。配置会限制发现遍历、kernel 启动、执行、检查与关闭，完整文档字节数与图像数，执行输出字节数、条目数与图像数，以及检查结果字节数。

本包不含 tool schema、提示词或 UI 渲染策略；面向模型的呈现由 Consumer 负责。

## 模型体验

### 间接消费者

#### 模型可见内容

无直接可见内容。本包不注册 prompt 或 tool；`@younthing/dsh-tool-notebook` 拥有可见 schema 与结果文本。

#### Token 影响

无直接影响。Notebook 文档与输出仅通过 Consumer tool 结果或注入的用户消息进入模型上下文。

#### KV Cache 影响

无直接失效；命名 Consumer 拥有请求前缀变更。

## 已知限制与延期工作

- 内置 `MemoryKernelBackend` 仅为测试支持标量字面量、变量、单次二元算术运算、赋值与 `print()`；它绝不执行任意 Python 或 JavaScript。
- 远程 Jupyter 接线在 `@younthing/dsh-notebook-kernel-jupyter`；本包不 spawn 进程。
