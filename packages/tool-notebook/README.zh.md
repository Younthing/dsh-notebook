# @younthing/dsh-tool-notebook

[English](README.md) | 中文

`ctx.notebooks` 的面向模型消费方。注册十二个工具——`notebook_open`、`notebook_create`、`notebook_read`、`notebook_edit_cell`、`notebook_insert_cell`、`notebook_delete_cell`、`notebook_move_cell`、`notebook_copy_cell`、`notebook_execute`、`notebook_restart`、`notebook_reload`、`notebook_inspect`——以及供人类发起执行的路径调用的 `executeNotebookCellAsUser()`。

`@younthing/dsh-notebook` 组合包会在用户安装 Notebook 的每个 profile 中挂载本 Consumer。该 Consumer 与浏览器 UI 和内核 Provider 保持独立。

```yaml
- id: tool-notebook
  name: '@younthing/dsh-tool-notebook'
```

## 操作与限额

`notebook_open` 只打开工作区中已有的 `.ipynb`，`notebook_create` 只在路径不存在时创建文件。两者都不接受环境、后端、kernelspec、可执行文件或安装输入。`notebook_read` 返回当前折叠文档与稳定单元格 id。插入支持 `code`、`markdown`、`raw`；省略 `afterCellId` 时插到开头，提供该 id 时紧随目标单元格插入。删除会维持 notebook 至少保留一个单元格的不变量，移动接受精确的从零开始索引，复制会紧随源单元格插入。文档处于未附加状态时仍可读取并执行所有单元格变更，写入操作会等待 notebook 服务完成文件提交后再渲染更新后的文档。

环境已附加时，`notebook_execute` 返回终态、内核执行计数，以及结构化的 stream、display、execute-result 或 error 记录。rich 记录会保留全部文本、JSON、图像附件与内联 base64 MIME 候选，以及元数据和 display 标识。未附加状态下执行会返回 `{status:"environment-required",code:"ENVIRONMENT_REQUIRED",message}`，不会伪造执行 id、计数或输出；系统提示词要求模型请用户在 notebook UI 中选择环境，并禁止重试或尝试安装。该工具集不暴露环境管理器安装、Python 安装、预配、附加、路径或 argv 操作。`notebook_restart` 仅在替代内核成功启动后替换所选环境的内核，并保留 Host 持有的后端和 kernelspec 选择。

发生 CAS `WRITE_CONFLICT` 后，`notebook_reload` 会显式接受当前外部 `.ipynb`，并把它作为完整文档快照。Reload 会发布新的单元格、元数据和文件 revision，而不会替换或改变所选环境；它不会把外部文件与先前的折叠文档合并。

`maxResultBytes` 默认为 256 KiB，最小值为 128 bytes。文档、inspect 与 execution 渲染在完整 UTF-8 结果达到限制后停止继续读取 source、metadata、MIME、attachment 或 traceback 字段。`executeNotebookCellAsUser()` 注入摘要的独立默认值为 64 KiB。

## 模型体验

### 直接消费者

#### 模型可见内容

十二个 generic-card notebook 工具，用于严格打开或创建工作区文档、读取稳定单元格 id、在未附加状态下插入、编辑、删除、移动或复制所有 nbformat 单元格类型、在 UI 附加环境后执行代码、替换所选内核、显式接受外部快照、检查变量，并返回完整结构化输出的有界摘要。

#### Token 影响

模型调用 notebook tool 时，每个结果最多向对话上下文加入 `maxResultBytes` 的 notebook 文档文本、execution 输出、inspect 文本或紧凑操作确认。

#### KV Cache 影响

本 Consumer 加载或其 guidance 变更时，tool schema 与 `tool:notebook` prompt 段会使请求前缀失效。

## 已知限制与后续工作

- 模型工具不暴露内核 interrupt。Host 与 UI 的 Stop 控件拥有 interrupt，避免模型在缺少明确用户意图时取消并发的人类执行。
- 环境发现、安装、预配及附加仍由 Host/UI 操作；模型只收到结构化的 `ENVIRONMENT_REQUIRED` 结果。
- Reload 是显式的完整快照替换，并非 cell merge；调用方应先检查经过外部编辑的文件，再决定是否接受。
- 用户发起的执行需在模型工具之外调用 `executeNotebookCellAsUser()`。
- 不依赖 `@younthing/dsh-notebook-kernel-jupyter`；安装组合包会单独挂载该 Provider。
