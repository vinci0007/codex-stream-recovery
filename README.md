[English](./README.md) | [中文](./README.zh-CN.md)

# Codex Stream Recovery

Codex Stream Recovery is a standalone Codex plugin for continuing work after a Codex streaming response disconnects before completion.

The plugin is designed to solve the practical "I cannot continue this broken Codex session" problem. It does not only diagnose the stream failure. It rebuilds enough continuation context from local Codex session JSONL files and generates a recovery prompt that can be used in a new Codex turn.

## What It Solves

Typical failure:

```text
Reconnecting... 1/5
Reconnecting... 2/5
Reconnecting... 3/5
Reconnecting... 4/5
Reconnecting... 5/5
stream disconnected before completion: Upstream request failed
```

After this happens, the original streaming response is usually already closed and cannot be attached again. This plugin works around that by:

- Finding the latest failed Codex session.
- Extracting the last user request, failure message, recent assistant progress, tool calls, and tool outputs.
- Writing structured recovery data to `recovery.json`.
- Writing a ready-to-send continuation prompt to `recovery-prompt.md`.
- Letting a new Codex turn continue from recovered state instead of starting from zero.

## Repository Layout

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

## Independence Boundary

This plugin is project-agnostic:

- It does not depend on any business project code.
- It does not require the current directory to be a Git repository.
- It does not read project databases.
- It does not modify target project files.
- It does not replace or patch Codex's network transport layer.
- It does not reopen an already closed SSE or streaming response.

It depends only on:

- Node.js.
- Local Codex session files under `<codex-home>\sessions`.
- The scripts bundled with this plugin.

## Run Directly

You can use the recovery script without installing the plugin:

```powershell
$PLUGIN_ROOT = ".\codex-stream-recovery"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs"
```

Default behavior:

- Uses the current user's `<home>\.codex` as Codex home.
- Scans recent session JSONL files under `<codex-home>\sessions`.
- Selects the latest recoverable stream-disconnect failure.
- Writes `.codex-recovery` under the current working directory.

## Recover A Specific Session

```powershell
$PLUGIN_ROOT = ".\codex-stream-recovery"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --session <path-to-session-jsonl>
```

Specify an output directory:

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --output <path-to-recovery-dir>
```

Specify Codex home:

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --codex-home "$env:USERPROFILE\.codex"
```

Include more recovered context:

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --tail-events 60 --max-field-chars 10000
```

## Recovery Output

Default output:

```text
.codex-recovery/
  recovery.json
  recovery-prompt.md
```

`recovery.json` contains structured data such as:

- Session id.
- Working directory.
- Codex source and version.
- Failed turn id.
- Failure timestamp and error message.
- Latest user request.
- Recent assistant progress.
- Recent tool calls.
- Recent tool outputs.

`recovery-prompt.md` is the main artifact. Use it as the first message in a new Codex turn, or ask Codex to read it and continue.

## Recommended Workflow

1. Run the recovery script after a Codex stream failure.
2. Open the generated `recovery-prompt.md`.
3. Send that recovery prompt in a new Codex turn.
4. Let Codex continue from the recovered context.
5. Run diagnostics only if you also need to prevent recurrence.

## Diagnostic Script

Recovery comes first. Diagnostics are secondary.

```powershell
$PLUGIN_ROOT = ".\codex-stream-recovery"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs"
```

Scan a specific log or session file:

```powershell
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs" --logs <path-to-log-or-session-jsonl>
```

Common diagnostic buckets:

- `codex_stream`: Codex stream did not complete normally.
- `local_network`: DNS, TLS, proxy, VPN, socket reset, or timeout.
- `provider_or_gateway`: upstream 429/5xx, gateway timeout, or premature SSE close.
- `auth_or_config`: API key, token, base URL, or model configuration problem.
- `prompt_or_payload`: oversized context, request body, or payload.
- `unknown`: insufficient evidence.

## Install With Codex Plugin

This repository includes a local marketplace file at the path expected by Codex:

```text
.agents/plugins/marketplace.json
```

Register this directory as a marketplace:

```powershell
codex plugin marketplace add <this-directory>
```

Install the plugin:

```powershell
codex plugin add codex-stream-recovery@codex-local
```

The marketplace file points to:

```text
./codex-stream-recovery
```

## Skill Trigger

Once installed, the skill should be used when the user mentions:

- Codex reconnecting.
- `stream disconnected before completion`.
- `Upstream request failed`.
- Codex stream failure after repeated reconnect attempts.
- Recovering the latest failed Codex turn.

The skill should generate a recovery package first. Root-cause analysis should not block continuation.

## Security And Redaction

The scripts redact common sensitive values before writing output:

- OpenAI-style API keys.
- Common provider API keys.
- Bearer tokens.
- Common GitHub, Hugging Face, and Slack token prefixes.
- Configured blocked promotional or community URLs.

Redaction is a safety measure, not a complete DLP system. Review `recovery.json` and `recovery-prompt.md` manually before sharing them outside your machine.

## Limitations

- It cannot recover hidden reasoning that was never written to session JSONL.
- It cannot guarantee complete tool output if the original session was truncated or compacted.
- It cannot fix network, proxy, provider, or gateway problems directly.
- It may not automatically find every historical failed session; use `--session` when needed.

## Validation

Validate plugin structure:

```powershell
python <plugin-creator>\scripts\validate_plugin.py .\codex-stream-recovery
```

Check the recovery script:

```powershell
node ".\codex-stream-recovery\scripts\recover_codex_turn.mjs" --help
```

Run a recovery test with a known session:

```powershell
node ".\codex-stream-recovery\scripts\recover_codex_turn.mjs" --session <path-to-session-jsonl> --output <path-to-test-recovery-dir>
```
