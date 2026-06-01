# Codex Stream Recovery

Standalone Codex plugin for continuing work after a Codex streaming response disconnects before completion.

## What It Does

- Recovers the latest interrupted Codex turn from local session JSONL files.
- Writes a structured `recovery.json` file.
- Writes a ready-to-send `recovery-prompt.md` file for continuing in a new Codex turn.
- Provides a separate diagnostic script for stream, provider, network, auth, and payload clues.
- Redacts API keys, bearer tokens, and blocked promotional/community URLs from generated output.

## Run Directly

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs"
```

Useful recovery options:

```powershell
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --codex-home "$env:USERPROFILE\.codex"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --session C:\path\to\rollout.jsonl
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --output C:\path\to\recovery
```

Diagnostic script:

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs" --logs C:\path\to\log-or-session.jsonl
```

## Install With Codex Plugin

This folder can be installed directly or exposed through a local marketplace file at:

```powershell
<marketplace-root>\marketplace.json
```

Register the local marketplace once:

```powershell
codex plugin marketplace add <marketplace-root>
```

Install the plugin:

```powershell
codex plugin add codex-stream-recovery@codex-local
```

## Plugin Layout

```text
codex-stream-recovery/
  .codex-plugin/plugin.json
  skills/codex-stream-recovery/SKILL.md
  scripts/recover_codex_turn.mjs
  scripts/inspect_codex_stream_recovery.mjs
```

## Recovery Output

By default the recovery script writes to `.codex-recovery` in the current working directory:

```text
.codex-recovery/
  recovery.json
  recovery-prompt.md
```

Use `recovery-prompt.md` as the first message in a new Codex turn to continue from the recovered state.
