# @deepseek-ai/dsh-client-ui-notebook

[English](README.md) | 中文

Notebook 占据 AppFrame 的笔记本栏，并增量投影 durable 的 `notebook/*` Session 事件。工作区发现只会在历史载入、不完整尾段和不兼容预发布记录处理完成后开始。不兼容历史操作会先归档当前 Session，再打开替代会话，因此旧的空白 Session 不会被复用。历史就绪后，启动器会分页发现有上限的工作区 `.ipynb` 路径，不读取文件、不启动 Agent、不打开文档，也不启动内核。用户需要明确打开候选、新建不存在的路径，或输入已有路径；刷新与加载更多均由用户触发。

多份已打开文档使用选择器和单一活动滚动画布。用户打开的文档会成为活动文档；Agent 打开的文档只显示提示，不抢夺焦点。每份文档分别保留草稿、滚动位置、变更状态和内核状态。Session 标题栏中的 Notebook 操作会在空白会话的 Hero 上保持键盘可访问，并可恢复被响应式布局隐藏的面板；文档标题栏可将其关闭并把焦点交回该操作。进入 Markdown 编辑模式时会聚焦文本框，按 Escape 则返回编辑控件。代码／Markdown／原始文本插入、从磁盘重新加载、串行全部运行、停止执行和 Colab 风格运行轨都限定在活动文档内。全部运行按文档顺序执行，并在第一次错误或取消后停止。

没有选择环境时，文档仍可阅读和编辑。原位环境卡会发现 uv、Python 与工作区 `.venv`，并提供经校验的私有 uv 安装、独立的 Python 3.12 确认、固定 Notebook 依赖配置、明确附着、取消，以及有所有权证明的环境重建确认。附着环境前，运行、全部运行、检查变量和重启都保持禁用。环境配置成功后会自动附着；如果流程由运行操作触发，也会自动续办该操作。

一条 rich output 只渲染一个最优的受支持 MIME 表示，同时保留 `text/plain` 作为失败回退。结构化 stdout／stderr 与异常直接渲染；沙箱 HTML 与 SVG 带默认拒绝的 CSP；可解析的 Plotly、Vega-Lite 与 DataResource 走有 DOM 上限的渲染器，并显示省略数量。光栅 bundle 只携带不可变附件引用，不把 base64 放进日志：窗格通过当前 Session 获授权的 `readAttachment` face 读取字节，创建浏览器 object URL，并在输出变化或卸载时撤销。

文档、环境和内核操作都通过类型化 `ctx.remote.notebooks` 命名空间，包括发现、严格的打开与创建、环境设置、附加及运行时状态。人发起的运行会先持久化源码，再以用户身份执行，并把有界输出摘要注入给下一次模型请求。重新加载会原子接受最新文件系统修订、退役进程内内核、保留已选环境，并丢弃该文档的本地草稿；持久化写入冲突会指明可以使用“从磁盘重新加载”恢复。窗格不导入或调用 Host service runtime。

`@deepseek-ai/dsh-notebook` 组合包会把本浏览器 Consumer 与 Notebook Host 包一起挂载。请把该组合包安装到目标 Harness profile，不要直接添加本实现包。

## 模型体验

无。Notebook 视图只在浏览器中渲染会话数据，不会进入模型请求。

#### KV Cache 影响

无；此包既不组装也不发送 provider 请求。

## 已知限制与后续工作

- **CodeMirror deferred** — 代码与原始文本单元格使用普通 textarea，不是 CodeMirror 6。
- **发现通过刷新进行** — v1 会在 Session 或面板变为活动状态以及用户明确刷新时扫描，不提供 watcher 或轮询循环。
- **交互式科研渲染器仅为部分实现** — Plotly 与 Vega-Lite 使用有上限的静态 SVG 投影；widget、任意 JavaScript、三维分子与完整上游渲染器均未启用。
