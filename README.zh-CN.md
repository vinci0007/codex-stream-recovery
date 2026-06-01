[English](./README.md) | [中文](./README.zh-CN.md)

# Codex Stream Recovery

Codex Stream Recovery 是一个独立的 Codex 插件，用来处理 Codex 会话过程中流式响应断开、重连耗尽、上游请求失败后无法继续的问题。

它的目标不是只分析断流原因，而是解决“这个 Codex 会话断了以后无法继续”的实际问题：从 Codex 本地 session JSONL 中恢复足够的上下文，并生成可以交给新 Codex turn 继续执行的恢复提示。

## 解决什么问题

典型失败：

```text
Reconnecting... 1/5
Reconnecting... 2/5
Reconnecting... 3/5
Reconnecting... 4/5
Reconnecting... 5/5
stream disconnected before completion: Upstream request failed
```

这类错误发生后，原来的流式响应通常已经关闭，不能重新接回。插件的处理方式是：

- 找到最近的失败 Codex session。
- 提取最后用户请求、失败信息、近期 assistant 进展、工具调用和工具输出。
- 生成结构化恢复数据 `recovery.json`。
- 生成可直接用于继续工作的 `recovery-prompt.md`。
- 在新的 Codex turn 中使用恢复提示继续任务，避免从零开始。

## 仓库结构

```text
codex/
  .agents/
    plugins/
      marketplace.json
  README.md
  README.zh-CN.md
  codex-stream-recovery/
    .codex-plugin/
      plugin.json
    skills/
      codex-stream-recovery/
        SKILL.md
    scripts/
      recover_codex_turn.mjs
      inspect_codex_stream_recovery.mjs
    README.md
```

## 独立性边界

这个插件是项目无关的独立插件：

- 不依赖任何业务项目代码。
- 不要求当前目录是 Git 仓库。
- 不读取业务数据库。
- 不修改目标项目文件。
- 不替换或修补 Codex 的网络传输层。
- 不重新打开已经关闭的 SSE 或 stream。

它只依赖：

- Node.js。
- Codex 本地 session 文件，默认位于 `<codex-home>\sessions`。
- 插件自带脚本。

## 直接运行

不安装为 Codex plugin，也可以直接运行恢复脚本：

```powershell
$PLUGIN_ROOT = ".\codex-stream-recovery"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs"
```

默认行为：

- 使用当前用户的 `<home>\.codex` 作为 Codex home。
- 扫描 `<codex-home>\sessions` 下最近的 session JSONL。
- 自动选择最近的可恢复断流失败 session。
- 在当前工作目录生成 `.codex-recovery`。

## 指定 Session 恢复

```powershell
$PLUGIN_ROOT = ".\codex-stream-recovery"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --session <path-to-session-jsonl>
```

指定输出目录：

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --output <path-to-recovery-dir>
```

指定 Codex home：

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --codex-home "$env:USERPROFILE\.codex"
```

调大恢复上下文：

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --tail-events 60 --max-field-chars 10000
```

## 恢复输出

默认输出：

```text
.codex-recovery/
  recovery.json
  recovery-prompt.md
```

`recovery.json` 包含结构化信息：

- session id。
- 工作目录。
- Codex 来源和版本。
- 失败 turn id。
- 失败时间和错误信息。
- 最近用户请求。
- 最近 assistant 进展。
- 最近工具调用。
- 最近工具输出。

`recovery-prompt.md` 是主要产物。把它作为新 Codex turn 的第一条消息，或让 Codex 读取该文件并继续。

## 推荐流程

1. Codex 断流失败后运行恢复脚本。
2. 打开生成的 `recovery-prompt.md`。
3. 在新的 Codex turn 中发送该恢复提示。
4. 让 Codex 根据恢复上下文继续任务。
5. 如果还需要防止复发，再运行诊断脚本。

## 诊断脚本

恢复优先，诊断其次。

```powershell
$PLUGIN_ROOT = ".\codex-stream-recovery"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs"
```

扫描指定日志或 session：

```powershell
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs" --logs <path-to-log-or-session-jsonl>
```

常见诊断分类：

- `codex_stream`：Codex 流式响应未正常完成。
- `local_network`：DNS、TLS、代理、VPN、网络重置或超时。
- `provider_or_gateway`：上游 429/5xx、网关超时、SSE 提前关闭。
- `auth_or_config`：API key、token、base URL、模型配置问题。
- `prompt_or_payload`：上下文过大、请求体过大、payload 异常。
- `unknown`：证据不足。

## 安装为 Codex Plugin

### 从 GitHub 安装

仓库推送到 GitHub 后，用户可以把它作为远程 marketplace 添加，不需要手动 clone 或下载：

```powershell
codex plugin marketplace add https://github.com/vinci0007/codex-stream-recovery.git
codex plugin add codex-stream-recovery@codex-local
```

Codex CLI 也支持短 GitHub 写法：

```powershell
codex plugin marketplace add vinci0007/codex-stream-recovery
codex plugin add codex-stream-recovery@codex-local
```

安装时 Codex 仍会把插件缓存到本机，但用户不需要自己维护本地插件目录。

### 从本地 checkout 安装

这个目录包含 Codex 期望路径下的本地 marketplace 文件：

```text
.agents/plugins/marketplace.json
```

把当前目录注册为 marketplace：

```powershell
codex plugin marketplace add <this-directory>
```

安装插件：

```powershell
codex plugin add codex-stream-recovery@codex-local
```

`marketplace.json` 指向：

```text
./codex-stream-recovery
```

## Skill 触发方式

安装后，当用户提到以下内容时，应触发该 skill：

- Codex reconnecting。
- `stream disconnected before completion`。
- `Upstream request failed`。
- Codex 多次重连后断流失败。
- 恢复最近失败的 Codex turn。

触发后应优先生成恢复包，而不是先做根因分析。

## 安全与脱敏

脚本会在写出结果前脱敏常见敏感值：

- OpenAI 风格 API key。
- 常见 provider API key。
- Bearer token。
- 常见 GitHub、Hugging Face、Slack token 前缀。
- 被配置为禁止输出的推广或社区链接。

脱敏是保护措施，不等同于完整 DLP。把 `recovery.json` 或 `recovery-prompt.md` 分享到机器外部前，仍建议人工检查。

## 限制

- 不能恢复没有写入 session JSONL 的隐藏推理内容。
- 如果原 session 已截断或压缩，不能保证工具输出完整。
- 不能直接修复网络、代理、供应商或网关问题。
- 不保证自动找到所有历史失败 session；必要时请使用 `--session`。

## 验证

校验插件结构：

```powershell
python <plugin-creator>\scripts\validate_plugin.py .\codex-stream-recovery
```

检查恢复脚本：

```powershell
node ".\codex-stream-recovery\scripts\recover_codex_turn.mjs" --help
```

用已知 session 做恢复测试：

```powershell
node ".\codex-stream-recovery\scripts\recover_codex_turn.mjs" --session <path-to-session-jsonl> --output <path-to-test-recovery-dir>
```
