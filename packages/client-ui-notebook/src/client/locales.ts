/** `notebook` namespace dictionaries (pane chrome + empty CTA). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'notebook'

/** The notebook dictionary key set (the source of truth for both locales). */
export type NotebookKey =
  | 'view.notebook'
  | 'panel.label'
  | 'panel.toggle'
  | 'panel.close'
  | 'empty.title'
  | 'empty.body'
  | 'empty.open'
  | 'empty.pathLabel'
  | 'empty.pathHint'
  | 'empty.pathInvalid'
  | 'launcher.foundTitle'
  | 'launcher.foundBody'
  | 'launcher.refresh'
  | 'launcher.done'
  | 'launcher.discovering'
  | 'launcher.discoveryFailed'
  | 'launcher.retry'
  | 'launcher.candidates'
  | 'launcher.open'
  | 'launcher.partial'
  | 'launcher.loadMore'
  | 'launcher.loadingMore'
  | 'launcher.createPathLabel'
  | 'launcher.createPathHint'
  | 'launcher.create'
  | 'launcher.openByPath'
  | 'switcher.label'
  | 'switcher.newDocuments'
  | 'switcher.add'
  | 'environment.title'
  | 'environment.body'
  | 'environment.checking'
  | 'environment.failed'
  | 'environment.permission'
  | 'environment.uvMissing'
  | 'environment.installUv'
  | 'environment.installingUv'
  | 'environment.uvUnsupported'
  | 'environment.uvBroken'
  | 'environment.pythonMissing'
  | 'environment.installPython'
  | 'environment.pythonConfirmTitle'
  | 'environment.pythonConfirmBody'
  | 'environment.pythonConfirm'
  | 'environment.cancel'
  | 'environment.choose'
  | 'environment.attach'
  | 'kernel.select'
  | 'kernel.change'
  | 'environment.createBody'
  | 'environment.enableBody'
  | 'environment.create'
  | 'environment.enable'
  | 'environment.provisioning'
  | 'environment.rebuildBody'
  | 'environment.brokenExistingBody'
  | 'environment.rebuild'
  | 'environment.rebuildConfirmTitle'
  | 'environment.rebuildConfirmBody'
  | 'environment.rebuildConfirm'
  | 'kernel.noEnvironment'
  | 'kernel.detached'
  | 'kernel.starting'
  | 'kernel.ready'
  | 'kernel.running'
  | 'kernel.stopped'
  | 'kernel.failed'
  | 'history.loadingTitle'
  | 'history.loadingBody'
  | 'history.errorTitle'
  | 'history.errorBody'
  | 'history.incompleteTitle'
  | 'history.incompleteBody'
  | 'history.loadOlder'
  | 'history.loadingOlder'
  | 'history.noOlder'
  | 'protocol.incompatibleTitle'
  | 'protocol.incompatibleBody'
  | 'protocol.replaceSession'
  | 'cell.run'
  | 'cell.runAll'
  | 'cell.interrupt'
  | 'cell.reload'
  | 'cell.restart'
  | 'cell.source'
  | 'cell.markdown'
  | 'cell.markdownEmpty'
  | 'cell.raw'
  | 'cell.shortcut'
  | 'cell.insertLabel'
  | 'cell.insertCode'
  | 'cell.insertMarkdown'
  | 'cell.insertRaw'
  | 'cell.continue'
  | 'cell.shortcutTitle'
  | 'cell.reloadTitle'
  | 'cell.restartTitle'
  | 'cell.runAllInProgress'
  | 'cell.actions'
  | 'cell.copy'
  | 'cell.moveUp'
  | 'cell.moveDown'
  | 'cell.delete'
  | 'cell.deleteConfirm'
  | 'status.idle'
  | 'status.running'
  | 'status.ok'
  | 'status.error'
  | 'status.cancelled'
  | 'action.open.pending'
  | 'action.open.settled'
  | 'action.create.pending'
  | 'action.create.settled'
  | 'action.edit.pending'
  | 'action.edit.settled'
  | 'action.insert.pending'
  | 'action.insert.settled'
  | 'action.run.pending'
  | 'action.run.settled'
  | 'action.interrupt.pending'
  | 'action.interrupt.settled'
  | 'action.restart.pending'
  | 'action.restart.settled'
  | 'action.reload.pending'
  | 'action.reload.settled'
  | 'action.writeConflict'
  | 'action.history.pending'
  | 'action.history.settled'
  | 'action.replace.pending'
  | 'action.replace.settled'
  | 'action.copy.pending'
  | 'action.copy.settled'
  | 'action.move.pending'
  | 'action.move.settled'
  | 'action.delete.pending'
  | 'action.delete.settled'
  | 'action.failed'
  | 'output.omittedRows'
  | 'output.omittedPoints'
  | 'output.omittedColumns'
  | 'output.imageLoading'
  | 'output.imageLoadFailed'
  | 'output.imageRetry'
  | 'output.binaryOmitted'
  | 'output.emptyBundle'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The notebook pane chrome strings. */
    notebook: NotebookKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<NotebookKey, string> = {
  'view.notebook': '笔记本',
  'panel.label': '笔记本',
  'panel.toggle': '切换笔记本面板',
  'panel.close': '关闭笔记本面板',
  'empty.title': '还没有笔记本',
  'empty.body': '打开一份分析文档后，单元格会写进会话日志；在这里运行的输出也会注入给模型。',
  'empty.open': '打开或新建笔记本',
  'empty.pathLabel': '工作区内的 .ipynb 路径',
  'empty.pathHint': '目前仅支持 .ipynb；请输入相对当前工作区的路径，例如 notebooks/analysis.ipynb。',
  'empty.pathInvalid': '请输入不含“..”的工作区相对 .ipynb 路径。',
  'launcher.foundTitle': '工作区笔记本',
  'launcher.foundBody': '选择要打开的文档，或新建一份笔记本。发现文件不会启动运行环境。',
  'launcher.refresh': '刷新',
  'launcher.done': '完成',
  'launcher.discovering': '正在发现工作区中的笔记本…',
  'launcher.discoveryFailed': '无法扫描工作区；仍可新建或按路径打开。',
  'launcher.retry': '重试',
  'launcher.candidates': '发现的笔记本',
  'launcher.open': '打开',
  'launcher.partial': '部分子目录无法访问；已显示可用结果。',
  'launcher.loadMore': '加载更多',
  'launcher.loadingMore': '正在加载…',
  'launcher.createPathLabel': '新笔记本路径',
  'launcher.createPathHint': '只会创建不存在的 .ipynb；绝不覆盖已有文件。',
  'launcher.create': '新建笔记本',
  'launcher.openByPath': '按路径打开已有文件',
  'switcher.label': '当前笔记本',
  'switcher.newDocuments': '有 {count} 份新文档',
  'switcher.add': '打开或新建',
  'environment.title': '需要 Notebook 运行环境',
  'environment.body': '文档可继续浏览和编辑；配置环境后才能运行代码。',
  'environment.checking': '正在检查 uv、Python 与 .venv…',
  'environment.failed': '环境操作失败。',
  'environment.permission': '当前会话权限不足。请使用现有权限控件；配置工作区 .venv 需要 Workspace Write，安装 DSH 私有 uv 或 Python 需要 Full Access。',
  'environment.uvMissing': '未找到兼容的 uv。可安装经校验的 DSH 私有副本，不会修改 PATH。',
  'environment.installUv': '安装 uv',
  'environment.installingUv': '正在安装 uv…',
  'environment.uvUnsupported': '当前平台没有可用的 uv 发行包。',
  'environment.uvBroken': 'uv 无法正常运行；请检查技术详情或重试。',
  'environment.pythonMissing': '未找到兼容的 Python。下载 Python 需要单独确认。',
  'environment.installPython': '安装 Python 3.12',
  'environment.pythonConfirmTitle': '确认安装 Python',
  'environment.pythonConfirmBody': '将由 uv 下载 Python 3.12 到 DSH 私有目录；不修改系统 Python、PATH 或项目配置。',
  'environment.pythonConfirm': '确认安装',
  'environment.cancel': '取消',
  'environment.choose': '选择环境',
  'environment.attach': '使用 {name}',
  'kernel.select': '选择内核',
  'kernel.change': '选择或更改内核',
  'environment.createBody': '在工作区创建标准 .venv，只安装锁定的 Jupyter 基础组件。',
  'environment.enableBody': '已存在未托管的 .venv。确认后只增补 Notebook 基础组件，不会清空环境。',
  'environment.create': '创建 .venv',
  'environment.enable': '启用此 .venv',
  'environment.provisioning': '正在配置 .venv…',
  'environment.rebuildBody': 'DSH 管理的 .venv 已损坏。只有确认所有权后才能清理并重建。',
  'environment.brokenExistingBody': '现有 .venv 无法通过健康检查；不会自动清空或修改。',
  'environment.rebuild': '重建 .venv',
  'environment.rebuildConfirmTitle': '确认重建环境',
  'environment.rebuildConfirmBody': '将清理并重建由 DSH ownership sidecar 证明拥有的 .venv。此操作不可撤销。',
  'environment.rebuildConfirm': '确认重建',
  'kernel.noEnvironment': '未选择环境',
  'kernel.detached': '未连接',
  'kernel.starting': '正在启动',
  'kernel.ready': '内核就绪',
  'kernel.running': '正在运行',
  'kernel.stopped': '内核已停止',
  'kernel.failed': '内核启动失败',
  'history.loadingTitle': '正在载入笔记本历史',
  'history.loadingBody': '会话历史就绪后会自动发现工作区笔记本。',
  'history.errorTitle': '无法载入笔记本历史',
  'history.errorBody': '请重试打开当前会话。',
  'history.incompleteTitle': '正在等待更早的笔记本记录',
  'history.incompleteBody': '当前会话窗口从一次笔记本操作中间开始；加载更早历史后会自动恢复完整单元格。',
  'history.loadOlder': '加载较早的笔记本历史',
  'history.loadingOlder': '正在加载较早历史…',
  'history.noOlder': '没有可继续加载的较早历史。',
  'protocol.incompatibleTitle': '此会话的 Notebook 历史不兼容',
  'protocol.incompatibleBody': '当前预发布 Session 格式无法读取这段 Notebook 历史。请归档此会话并在同一工作区新建会话，然后重新打开同一份 .ipynb 文件。',
  'protocol.replaceSession': '归档并新建会话',
  'cell.run': '运行',
  'cell.runAll': '全部运行',
  'cell.interrupt': '停止运行',
  'cell.reload': '从磁盘重新加载',
  'cell.restart': '重启内核',
  'cell.source': '单元格源码',
  'cell.markdown': 'Markdown 单元格',
  'cell.markdownEmpty': '写一段说明，或点这里编辑',
  'cell.raw': '原始文本单元格',
  'cell.shortcut': 'Shift+Enter',
  'cell.insertLabel': '插入单元格',
  'cell.insertCode': '代码',
  'cell.insertMarkdown': 'Markdown',
  'cell.insertRaw': '原始文本',
  'cell.continue': '开始编写',
  'cell.shortcutTitle': 'Shift+Enter / Ctrl+Enter / Meta+Enter',
  'cell.reloadTitle': '放弃当前改动并从磁盘重新加载',
  'cell.restartTitle': '重新启动内核（会清除运行时状态）',
  'cell.runAllInProgress': '正在按顺序运行代码单元格',
  'cell.actions': '单元格操作',
  'cell.copy': '复制单元格',
  'cell.moveUp': '上移单元格',
  'cell.moveDown': '下移单元格',
  'cell.delete': '删除单元格',
  'cell.deleteConfirm': '再次点击确认删除',
  'status.idle': '就绪',
  'status.running': '正在运行',
  'status.ok': '运行成功',
  'status.error': '运行失败',
  'status.cancelled': '运行已取消',
  'action.open.pending': '正在打开笔记本…',
  'action.open.settled': '笔记本已打开',
  'action.create.pending': '正在新建笔记本…',
  'action.create.settled': '笔记本已新建',
  'action.edit.pending': '正在保存…',
  'action.edit.settled': '已保存',
  'action.insert.pending': '正在插入单元格…',
  'action.insert.settled': '单元格已插入',
  'action.run.pending': '正在提交运行…',
  'action.run.settled': '运行已完成',
  'action.interrupt.pending': '正在停止运行…',
  'action.interrupt.settled': '已请求停止运行',
  'action.restart.pending': '正在重启内核…',
  'action.restart.settled': '内核已重启',
  'action.reload.pending': '正在从磁盘重新加载…',
  'action.reload.settled': '已从磁盘重新加载',
  'action.writeConflict': '文件已被外部修改。可使用“从磁盘重新加载”恢复到最新版本。',
  'action.history.pending': '正在加载较早历史…',
  'action.history.settled': '较早历史已加载',
  'action.replace.pending': '正在归档当前会话并新建会话…',
  'action.replace.settled': '已新建会话',
  'action.copy.pending': '正在复制单元格…',
  'action.copy.settled': '单元格已复制',
  'action.move.pending': '正在移动单元格…',
  'action.move.settled': '单元格已移动',
  'action.delete.pending': '正在删除单元格…',
  'action.delete.settled': '单元格已删除',
  'action.failed': '操作失败：',
  'output.omittedRows': '另有 {count} 行未渲染。',
  'output.omittedPoints': '另有 {count} 个数据点未渲染。',
  'output.omittedColumns': '另有 {count} 列未渲染。',
  'output.imageLoading': '正在加载图片…',
  'output.imageLoadFailed': '无法加载图片。',
  'output.imageRetry': '重试图片',
  'output.binaryOmitted': '此二进制输出暂不显示。',
  'output.emptyBundle': '此输出没有可显示的 MIME 内容。',
}

/** English dictionary. */
export const en: Record<NotebookKey, string> = {
  'view.notebook': 'Notebook',
  'panel.label': 'Notebook',
  'panel.toggle': 'Toggle Notebook panel',
  'panel.close': 'Close Notebook panel',
  'empty.title': 'No notebook yet',
  'empty.body': 'Open an analysis document to log cells in this session. Running a cell injects its output for the model.',
  'empty.open': 'Open or create notebook',
  'empty.pathLabel': 'Workspace-relative .ipynb path',
  'empty.pathHint': 'Only .ipynb is currently supported. Enter a path relative to this workspace, such as notebooks/analysis.ipynb.',
  'empty.pathInvalid': 'Enter a workspace-relative .ipynb path without “..” segments.',
  'launcher.foundTitle': 'Workspace notebooks',
  'launcher.foundBody': 'Choose a document to open or create a notebook. Discovery never starts a runtime.',
  'launcher.refresh': 'Refresh',
  'launcher.done': 'Done',
  'launcher.discovering': 'Discovering notebooks in this workspace…',
  'launcher.discoveryFailed': 'The workspace could not be scanned. You can still create or open by path.',
  'launcher.retry': 'Retry',
  'launcher.candidates': 'Discovered notebooks',
  'launcher.open': 'Open',
  'launcher.partial': 'Some folders could not be read; available results are shown.',
  'launcher.loadMore': 'Load more',
  'launcher.loadingMore': 'Loading…',
  'launcher.createPathLabel': 'New notebook path',
  'launcher.createPathHint': 'Creates only an absent .ipynb file and never overwrites an existing file.',
  'launcher.create': 'Create notebook',
  'launcher.openByPath': 'Open an existing file by path',
  'switcher.label': 'Current notebook',
  'switcher.newDocuments': '{count} new documents',
  'switcher.add': 'Open or create',
  'environment.title': 'Notebook runtime required',
  'environment.body': 'You can keep viewing and editing. Configure an environment before running code.',
  'environment.checking': 'Checking uv, Python, and .venv…',
  'environment.failed': 'The environment operation failed.',
  'environment.permission': 'This session lacks the required permission. Use the existing control: workspace .venv setup needs Workspace Write, while private DSH uv or Python installation needs Full Access.',
  'environment.uvMissing': 'No compatible uv was found. Install a verified private DSH copy without changing PATH.',
  'environment.installUv': 'Install uv',
  'environment.installingUv': 'Installing uv…',
  'environment.uvUnsupported': 'No supported uv distribution is available for this platform.',
  'environment.uvBroken': 'uv could not run. Review technical details or retry.',
  'environment.pythonMissing': 'No compatible Python was found. Downloading Python requires separate confirmation.',
  'environment.installPython': 'Install Python 3.12',
  'environment.pythonConfirmTitle': 'Confirm Python installation',
  'environment.pythonConfirmBody': 'uv will download Python 3.12 into DSH private storage without changing system Python, PATH, or project files.',
  'environment.pythonConfirm': 'Confirm installation',
  'environment.cancel': 'Cancel',
  'environment.choose': 'Choose an environment',
  'environment.attach': 'Use {name}',
  'kernel.select': 'Select kernel',
  'kernel.change': 'Select or change kernel',
  'environment.createBody': 'Create a standard workspace .venv with only the locked Jupyter basics.',
  'environment.enableBody': 'An unmanaged .venv exists. Confirm adding only Notebook basics; it will not be cleared.',
  'environment.create': 'Create .venv',
  'environment.enable': 'Enable this .venv',
  'environment.provisioning': 'Configuring .venv…',
  'environment.rebuildBody': 'The DSH-managed .venv is broken. It can be cleaned and rebuilt only after ownership is confirmed.',
  'environment.brokenExistingBody': 'The existing .venv failed its health check and will not be changed or cleared automatically.',
  'environment.rebuild': 'Rebuild .venv',
  'environment.rebuildConfirmTitle': 'Confirm environment rebuild',
  'environment.rebuildConfirmBody': 'This irreversibly cleans and rebuilds only the .venv proven to be DSH-owned by its ownership sidecar.',
  'environment.rebuildConfirm': 'Confirm rebuild',
  'kernel.noEnvironment': 'No environment selected',
  'kernel.detached': 'Detached',
  'kernel.starting': 'Starting',
  'kernel.ready': 'Kernel ready',
  'kernel.running': 'Running',
  'kernel.stopped': 'Kernel stopped',
  'kernel.failed': 'Kernel failed',
  'history.loadingTitle': 'Loading Notebook history',
  'history.loadingBody': 'Workspace discovery starts after the Session history is ready.',
  'history.errorTitle': 'Notebook history could not be loaded',
  'history.errorBody': 'Retry opening the current Session.',
  'history.incompleteTitle': 'Waiting for earlier notebook history',
  'history.incompleteBody': 'This session window starts in the middle of notebook activity. Loading older history will restore the complete cells.',
  'history.loadOlder': 'Load earlier notebook history',
  'history.loadingOlder': 'Loading earlier history…',
  'history.noOlder': 'No earlier history remains to load.',
  'protocol.incompatibleTitle': 'This session\'s Notebook history is incompatible',
  'protocol.incompatibleBody': 'This pre-release Session format cannot read this Notebook history. Archive this session and start a new one in the same Workspace, then reopen the same .ipynb file.',
  'protocol.replaceSession': 'Archive and start new session',
  'cell.run': 'Run',
  'cell.runAll': 'Run all',
  'cell.interrupt': 'Stop execution',
  'cell.reload': 'Reload from disk',
  'cell.restart': 'Restart kernel',
  'cell.source': 'Cell source',
  'cell.markdown': 'Markdown cell',
  'cell.markdownEmpty': 'Write a note, or click to edit',
  'cell.raw': 'Raw text cell',
  'cell.shortcut': 'Shift+Enter',
  'cell.insertLabel': 'Insert cell',
  'cell.insertCode': 'Code',
  'cell.insertMarkdown': 'Markdown',
  'cell.insertRaw': 'Raw',
  'cell.continue': 'Start coding',
  'cell.shortcutTitle': 'Shift+Enter / Ctrl+Enter / Meta+Enter',
  'cell.reloadTitle': 'Discard local changes and reload from disk',
  'cell.restartTitle': 'Restart the kernel (clears runtime state)',
  'cell.runAllInProgress': 'Running code cells in order',
  'cell.actions': 'Cell actions',
  'cell.copy': 'Copy cell',
  'cell.moveUp': 'Move cell up',
  'cell.moveDown': 'Move cell down',
  'cell.delete': 'Delete cell',
  'cell.deleteConfirm': 'Click again to confirm delete',
  'status.idle': 'Ready',
  'status.running': 'Running',
  'status.ok': 'Run succeeded',
  'status.error': 'Run failed',
  'status.cancelled': 'Run cancelled',
  'action.open.pending': 'Opening notebook…',
  'action.open.settled': 'Notebook opened',
  'action.create.pending': 'Creating notebook…',
  'action.create.settled': 'Notebook created',
  'action.edit.pending': 'Saving…',
  'action.edit.settled': 'Saved',
  'action.insert.pending': 'Inserting cell…',
  'action.insert.settled': 'Cell inserted',
  'action.run.pending': 'Submitting run…',
  'action.run.settled': 'Run finished',
  'action.interrupt.pending': 'Stopping execution…',
  'action.interrupt.settled': 'Stop requested',
  'action.restart.pending': 'Restarting kernel…',
  'action.restart.settled': 'Kernel restarted',
  'action.reload.pending': 'Reloading from disk…',
  'action.reload.settled': 'Reloaded from disk',
  'action.writeConflict': 'The file changed outside this session. Use Reload from disk to recover the latest revision.',
  'action.history.pending': 'Loading earlier history…',
  'action.history.settled': 'Earlier history loaded',
  'action.replace.pending': 'Archiving this session and starting a new one…',
  'action.replace.settled': 'New session started',
  'action.copy.pending': 'Duplicating cell…',
  'action.copy.settled': 'Cell duplicated',
  'action.move.pending': 'Moving cell…',
  'action.move.settled': 'Cell moved',
  'action.delete.pending': 'Deleting cell…',
  'action.delete.settled': 'Cell deleted',
  'action.failed': 'Action failed: ',
  'output.omittedRows': '{count} additional rows omitted.',
  'output.omittedPoints': '{count} additional points omitted.',
  'output.omittedColumns': '{count} additional columns omitted.',
  'output.imageLoading': 'Loading image…',
  'output.imageLoadFailed': 'Image could not be loaded.',
  'output.imageRetry': 'Retry image',
  'output.binaryOmitted': 'Binary output is not displayed.',
  'output.emptyBundle': 'This output has no displayable MIME content.',
}
