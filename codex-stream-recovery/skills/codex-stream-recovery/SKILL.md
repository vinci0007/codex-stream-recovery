---
name: codex-stream-recovery
description: >-
  Use this skill whenever the user mentions Codex reconnecting, "Reconnecting... 1/5",
  "stream disconnected before completion", "Upstream request failed", stalled Codex streams,
  repeated retry attempts, or wants a standalone way to resume work after a Codex stream
  disconnect. This skill is project-agnostic: it rebuilds continuation context from local Codex
  session files and can also analyze Codex-side symptoms, local logs, network/provider clues, and
  user-provided evidence without assuming any target repository or gateway implementation.
---

# Codex Stream Recovery

Use this skill to recover usable continuation context after Codex session stream failures. The plugin is standalone and must not assume a target repository, framework, proxy, gateway, or project-specific retry implementation.

## Primary Goal

The first objective is practical continuation: create a recovery package that lets Codex resume the interrupted task in a new turn. Diagnosis is secondary evidence for preventing recurrence.

The bundled recovery script reads Codex session JSONL files and writes:

- `recovery.json`: structured session, failure, user request, assistant progress, and tool evidence.
- `recovery-prompt.md`: a ready-to-send prompt that instructs Codex to continue from recovered state.

This does not patch Codex's transport layer or reopen a dead stream. It solves the "work cannot continue" failure mode by reconstructing enough turn state to continue safely.

## What The Error Means

When Codex shows repeated reconnect attempts and ends with a stream-disconnected upstream failure, interpret it as:

- The active streaming response ended before Codex saw a normal completion.
- Codex retried the connection/request path, then exhausted its retry budget.
- The root cause can be local network instability, a proxy/VPN issue, an upstream API/provider failure, a gateway prematurely closing SSE, timeout/backpressure, or an invalid/expired credential.

## First Response

When triggered, do three things:

1. Run the bundled recovery script first if local tools are available.
2. Tell the user where `recovery-prompt.md` and `recovery.json` were written.
3. If recovery fails or recurrence prevention is requested, run the diagnostic script and classify the evidence.

Keep the response practical. The useful output is the continuation prompt; root-cause analysis should not block continuation unless the session data cannot be read.

## Recovery Script

Resolve the bundled script relative to this plugin root. If the plugin is installed into Codex's plugin cache, use the cached plugin root. If running directly from this standalone folder, the root is the directory that contains `.codex-plugin`.

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs"
```

Useful options:

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --codex-home "$env:USERPROFILE\.codex"
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --session <path-to-session-jsonl>
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --output <path-to-recovery-dir>
node "$PLUGIN_ROOT\scripts\recover_codex_turn.mjs" --tail-events 60 --max-field-chars 10000
```

Default behavior:

- Searches `<codex-home>\sessions` for recent `.jsonl` files.
- Selects the most recent session containing recoverable stream-disconnect evidence.
- Writes `.codex-recovery\recovery.json` and `.codex-recovery\recovery-prompt.md` under the current working directory.
- Redacts API keys, bearer tokens, and blocked promotional/community URLs before writing output.

After the script succeeds, continue by reading or pasting `recovery-prompt.md` into a new Codex turn.

## Diagnostic Script

Resolve the bundled script relative to this plugin root.

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs"
```

Useful options:

```powershell
$PLUGIN_ROOT = "<plugin-root>"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs" --codex-home "$env:USERPROFILE\.codex"
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs" --logs <path-to-codex-or-gateway-log>
node "$PLUGIN_ROOT\scripts\inspect_codex_stream_recovery.mjs" --logs <path-to-logs-dir> --trace-id <trace-id>
```

The script reads only tails of text logs. It does not parse project databases, inspect source code, or require repository dependencies.

## Evidence Checklist

Collect these facts before recommending a fix:

- Exact error text and whether reconnect count reached the maximum.
- Approximate time window and timezone.
- Whether the failure happens with all prompts or only long/rich prompts.
- Whether the user is behind VPN, proxy, corporate network, or custom base URL.
- Whether other internet/API calls work from the same machine.
- Whether Codex was using an official provider path or a custom OpenAI-compatible gateway.
- Any request/trace id visible in the UI, terminal, or logs.

## Common Buckets

Use these buckets for the diagnosis:

- `local_network`: DNS, TLS, proxy/VPN, firewall, sleep/wake, flaky Wi-Fi, or OS socket resets.
- `provider_or_gateway`: upstream 5xx/429, provider capacity, gateway idle timeout, SSE parser/proxy buffering, reverse proxy timeout, or premature stream close.
- `auth_or_config`: expired token, wrong API key, invalid base URL, mismatched model, or stale Codex config.
- `prompt_or_payload`: very large context, large file/image payloads, tool output explosion, or request body rejected mid-stream.
- `unknown`: evidence is insufficient; gather logs and reproduce with a minimal prompt.

## Suggested Actions

Pick the smallest safe action that matches the evidence:

- For an interrupted turn: generate and use `recovery-prompt.md` first.
- For one-off failures: retry the turn or start a fresh turn.
- For repeated failures on one network: test without VPN/proxy, switch network, or check corporate TLS interception.
- For custom gateways: inspect gateway logs for stream close, upstream 5xx/429, idle timeout, and SSE completion events.
- For long prompts: reproduce with a short prompt, then gradually add context/files.
- For auth/config suspicion: verify provider credentials and base URL outside Codex with a minimal request.
- For provider capacity: switch model/provider/account if available and retry later.

## Output Shape

For recovery work, use this short structure:

```text
Recovery package: <recovery-prompt.md path>
Recovered from: <session file>
Failure: <error text>
How to continue: <one concrete action>
```

For diagnostic-only work, use this short structure:

```text
Likely bucket: <bucket>
Evidence: <2-4 bullets>
Next step: <one concrete command/check>
Residual risk: <what is still unknown>
```

If the user asks for a repair plan, include a focused checklist. If they ask for implementation work in a specific gateway, only then inspect that project and follow its local instructions.

## Safety

Never paste secrets, API keys, auth tokens, or full sensitive promotional/community text found in logs or config. Redact them and continue with the diagnostic summary.
