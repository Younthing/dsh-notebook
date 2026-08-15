# @younthing/dsh-notebook-environment-uv

[English](README.md) | 中文

这是 `ctx.notebookEnvironments` 的 uv Service Provider。管理器发现顺序固定为：配置的 `uvExecutable`、subprocess Provider 已清理 PATH 中兼容的 uv 0.9 至 0.11、DSH 私有可执行文件。配置的可执行文件不可用时会明确失败；PATH 命令不可用或版本不兼容时不会阻止私有回退。私有回退固定使用[官方发布](https://github.com/astral-sh/uv/releases/tag/0.11.32)的 uv 0.11.32；本包提交 macOS、Windows、Linux glibc 与 Linux musl 的 x64/arm64 归档 SHA-256，在完整下载字节上限内获取文件，先校验再解压，并通过随机独占同级文件与 rename 发布。它不会执行上游安装脚本、调用 `uv self update` 或修改 PATH。

`installPython({ version: '3.12' })` 是唯一允许 uv 下载 Python 的操作，并且要求 `danger-full-access`。其他所有 uv 命令都把 Python 下载设为 `never`。私有 uv release 保存在 `$DSH_HOME/tools/uv`，Python 保存在 `$DSH_HOME/tools/python`，二者都不会注册到 PATH 或 Windows 注册表。

每个工作区只有一个确定性不透明环境 id 和一个 `.venv`。新环境先在随机同级目录中通过 `uv venv --relocatable` 构建，再用 `uv pip install --require-hashes --no-deps --only-binary :all:` 安装已提交且带哈希锁定的 `jupyter_client==8.9.1` 与 `ipykernel==7.3.0` requirements；之后通过隔离导入与 `python3` kernelspec 探测，写入带版本的所有权 sidecar，最后 rename 到目标位置。本包不接受 `uv sync`、项目 manifest 发现、源码构建、任意包、任意命令参数或任意环境选择器。

没有 sidecar 的现有 `.venv` 在 catalog 发现阶段既不会执行，也不会被修改。用户选择后，`inspectExisting()` 才会在沙箱内显式执行健康检查；`provision({ allowExisting: true, rebuild: false })` 则授权接管。基于 manager 的 Python 发现只使用 `uv python find 3.12 --managed-python` 与 `--system`；如果 candidate 的词法路径或解析后路径进入工作区 `.venv`，provider 会在启动前拒绝它。显式接管会安装同一套锁定依赖，并只在验证成功后写 sidecar。接管失败可能在用户已授权的环境里留下部分依赖更新，但不会发布所有权；重试同一个固定操作是安全的。

`rebuild: true` 是独立的破坏性授权。只有有效 sidecar 包含匹配的 opaque environment id 时，provider 才会替换 `.venv`。它先构建并验证 replacement，把旧的 owned directory 移到随机 backup，再通过 rename 发布 replacement。失败的 staging directory 与不再使用的 owned backup 会被原子 rename 为 `.venv.dsh-residue-*`，之后不会被自动删除。重试 provision 只检测这些名称，每次操作最多写一条不含路径的告警，且不会打开、再次 rename 或复用它们。下一次显式 provision 会用唯一的 owned rebuild backup 恢复缺失的 `.venv`，其他可恢复的 staging 与 backup entry 会变成保留 residue。带 process owner 的结构化锁允许恢复可证明已经退出的 manager；malformed、live、foreign、linked 或没有 marker 的状态会保留并报告 busy。

每个操作的默认截止时间为可配置的 15 分钟。Provider subprocess 接收确定性的环境，继承的 `UV_*`、`PIP_*`、Python 激活变量、Python 配置变量、`JUPYTER_*` 与 IPython 变量都会被移除。stdout 与 stderr 的总量有界；用户可见错误只公开稳定 code、category 与 retryable，有限 stderr 与原始 cause 只留在 Host 日志。中止与 Provider 卸载都会终止并等待完整子进程树退出。

## Model Experience

### 间接模型暴露

#### 模型看到的内容

本包不直接向模型提供内容。任何模型可见的配置提示都由 `@younthing/dsh-tool-notebook` Consumer 管理。

#### Token 影响

无直接影响。

#### KV Cache 影响

不会直接失效。

## Known Limitations and Deferred Work

- 显式接管会原地更新现有用户环境，因为替换它会丢弃用户包。依赖安装失败时可能已经安装部分锁定包，但完整探测成功前不会发布所有权。
- `installUv()` 与 `installPython()` 会向 DSH home 写入私有 runtime component，因此要求 `danger-full-access`。创建、接管、修复或显式重建工作区 `.venv` 接受 `workspace-write` 或 `danger-full-access`，并按该策略限制每个 uv 与 Python subprocess。
- 保留的 `.venv.dsh-residue-*` entry 可能占用工作区磁盘空间。并发工作区 writer 可能把目录替换成指向工作区外数据的链接，因此 DSH 不会删除 residue；所有 notebook environment 操作停止后，用户可以手动移除。
