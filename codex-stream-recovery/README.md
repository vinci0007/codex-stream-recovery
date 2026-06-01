# Codex Stream Recovery

Codex Stream Recovery 是一个独立的 Codex 插件，用来处理 Codex 会话过程中出现的断流、重连耗尽、上游请求失败后无法继续的问题。

它的目标不是简单分析错误原因，而是从 Codex 本地 session JSONL 中恢复最近一次中断 turn 的上下文，生成可以交给新 Codex turn 继续执行的恢复包。

## 解决什么问题

典型场景：

```text
Reconnecting... 1/5
Reconnecting... 2/5
Reconnecting... 3/5
Reconnecting... 4/5
Reconnecting... 5/5
stream disconnected before completion: Upstream request failed
```

这类错误发生后，原来的流式响应通常已经结束，不能被重新接回。插件的实际解决方式是：

- 找到最近的失败 Codex session。
- 提取最后用户请求、失败信息、近期 assistant 进展、工具调用和工具输出。
- 生成结构化恢复数据 `recovery.json`。
- 生成可直接用于继续工作的 `recovery-prompt.md`。
- 在新 Codex turn 中使用恢复提示继续任务，避免从零开始。

## 插件边界

这个插件是项目无关的独立插件：

- 不依赖任何业务项目代码。
- 不要求当前目录是 Git 仓库。
- 不读取业务数据库。
- 不修改目标项目文件。
- 不实现或替换 Codex 的网络传输层。
- 不尝试重新打开已经断掉的 SSE/stream。

它只依赖：

- Node.js。
- Codex 本地 session 文件，默认位于 `<codex-home>\sessions`。
- 插件自带脚本。

## 目录结构

```text
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

## 直接运行

在未安装为 Codex plugin 的情况下，也可以直接运行脚本。

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs"
```

默认行为：

- 使用当前用户的 `<home>\.codex` 作为 Codex home。
- 扫描 `<codex-home>\sessions` 下最近的 session JSONL。
- 自动选择最近的可恢复断流失败 session。
- 在当前工作目录生成 `.codex-recovery`。

## 指定 session 恢复

如果你知道具体失败 session 文件，可以显式指定：

```powershell
$PLUGIN_ROOT = "<plugin-root>"
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

默认输出目录：

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

`recovery-prompt.md` 是主要产物。把它作为新 Codex turn 的输入，或者让 Codex 读取这个文件并继续。

## 推荐使用流程

1. 遇到 Codex 断流失败后，运行恢复脚本。
2. 打开生成的 `recovery-prompt.md`。
3. 在新 Codex turn 中发送该恢复提示。
4. 让 Codex 根据恢复上下文继续任务。
5. 如需排查复发原因，再运行诊断脚本。

## 诊断脚本

恢复优先，诊断其次。如果要分析断流原因，可以运行：

```powershell
$PLUGIN_ROOT = "<plugin-root>"
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
- `auth_or_config`：密钥、token、base URL、模型配置问题。
- `prompt_or_payload`：上下文过大、请求体过大、payload 异常。
- `unknown`：证据不足，需要更多日志或复现时间。

## 安装为 Codex Plugin

插件本体只要求目录中存在 `.codex-plugin/plugin.json`、`skills/` 和 `scripts/`。如果你希望通过 Codex plugin 机制安装，可以把它放入任意 marketplace 根目录，并配置对应的 `marketplace.json`。

示例 marketplace 结构：

```text
<marketplace-root>/
  marketplace.json
  codex-stream-recovery/
    .codex-plugin/
    skills/
    scripts/
    README.md
```

示例 `marketplace.json`：

```json
{
  "name": "codex-local",
  "interface": {
    "displayName": "Codex Local"
  },
  "plugins": [
    {
      "name": "codex-stream-recovery",
      "source": {
        "source": "local",
        "path": "./codex-stream-recovery"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

安装命令：

```powershell
codex plugin marketplace add <marketplace-root>
codex plugin add codex-stream-recovery@codex-local
```

## Skill 触发方式

安装后，当用户提到以下内容时，Codex 可以触发该 skill：

- Codex Reconnecting。
- `stream disconnected before completion`。
- `Upstream request failed`。
- Codex 断流后无法继续。
- 需要恢复最近失败的 Codex turn。

触发后应优先生成恢复包，而不是先做根因分析。

## 安全与脱敏

脚本会对输出做基础脱敏：

- OpenAI 风格 API key。
- 常见 provider API key。
- Bearer token。
- GitHub/Hugging Face/Slack 等常见 token 前缀。
- 被配置为禁止输出的推广或社区链接。

脱敏是保护措施，不等同于完整 DLP。处理包含机密信息的 session 时，仍建议在分享 `recovery.json` 或 `recovery-prompt.md` 前人工检查。

## 限制

- 不能恢复没有写入 session JSONL 的隐藏推理内容。
- 不能保证工具输出完整，因为原 session 可能已经截断或被 Codex 压缩。
- 不能修复网络、代理、供应商、网关本身的问题。
- 不能保证自动找到所有历史失败 session；必要时请使用 `--session` 指定文件。

## 验证

校验插件结构：

```powershell
python <plugin-creator>\scripts\validate_plugin.py <plugin-root>
```

检查恢复脚本：

```powershell
node "<plugin-root>\scripts\recover_codex_turn.mjs" --help
```

用指定 session 做恢复测试：

```powershell
node "<plugin-root>\scripts\recover_codex_turn.mjs" --session <path-to-session-jsonl> --output <path-to-test-recovery-dir>
```
