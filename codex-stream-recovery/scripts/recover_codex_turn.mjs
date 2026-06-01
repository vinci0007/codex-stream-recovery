#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import readline from 'node:readline'

const defaultMaxSessions = 80
const defaultTailEvents = 36
const defaultMaxFieldChars = 6000

const recoverableErrorPatterns = [
  /stream disconnected before completion/i,
  /upstream request failed/i,
  /stream closed before response\.completed/i,
  /reconnecting\.\.\.\s*\d+\/\d+/i,
  /response\.completed/i,
  /connection.*closed/i,
  /stream.*closed/i,
  /stream.*interrupted/i
]

const secretPatterns = [
  { pattern: /sk-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted]' },
  { pattern: /\bnvapi-[A-Za-z0-9_-]{12,}\b/g, replacement: '[redacted]' },
  { pattern: /\b[A-Za-z][A-Za-z0-9_-]{0,20}api-[A-Za-z0-9_-]{16,}\b/g, replacement: '[redacted]' },
  { pattern: /\b(?:ghp|github_pat|gsk|hf|xoxb|xoxp)_[A-Za-z0-9_-]{16,}\b/g, replacement: '[redacted]' },
  { pattern: /(api[_-]?key["':=\s]+)[A-Za-z0-9._-]{12,}/gi, replacement: '$1[redacted]' },
  { pattern: /(authorization["':=\s]+bearer\s+)[A-Za-z0-9._-]{12,}/gi, replacement: '$1[redacted]' },
  { pattern: /https?:\/\/dc\.hhhl\.cc\/chat\/room\/[A-Za-z0-9_-]+/g, replacement: '[redacted]' }
]

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  const codexHome = resolve(options.codexHome ?? join(homedir(), '.codex'))
  const outputDir = resolve(options.output ?? join(process.cwd(), '.codex-recovery'))
  const maxSessions = finitePositive(options.maxSessions, defaultMaxSessions)
  const tailEvents = finitePositive(options.tailEvents, defaultTailEvents)
  const maxFieldChars = finitePositive(options.maxFieldChars, defaultMaxFieldChars)

  const sessionPath = options.session
    ? resolve(options.session)
    : await findLatestRecoverableSession(codexHome, maxSessions)

  if (!sessionPath) {
    console.error(`No recoverable failed Codex session was found under ${join(codexHome, 'sessions')}.`)
    console.error('Pass --session <path-to-jsonl> to recover a specific session.')
    process.exitCode = 2
    return
  }

  const recovery = await recoverSession(sessionPath, { tailEvents, maxFieldChars })
  if (!recovery.turn) {
    console.error(`No turn data could be recovered from ${sessionPath}.`)
    process.exitCode = 3
    return
  }

  mkdirSync(outputDir, { recursive: true })
  const jsonPath = join(outputDir, 'recovery.json')
  const promptPath = join(outputDir, 'recovery-prompt.md')
  recovery.files = { json: jsonPath, prompt: promptPath }

  writeFileSync(jsonPath, `${JSON.stringify(recovery, null, 2)}\n`, 'utf8')
  writeFileSync(promptPath, buildPrompt(recovery), 'utf8')

  console.log('Codex turn recovery package created.')
  console.log(`Source session: ${sessionPath}`)
  console.log(`Failure: ${recovery.failure?.message ?? '(none detected; recovered latest turn)'}`)
  console.log(`Recovery JSON: ${jsonPath}`)
  console.log(`Recovery prompt: ${promptPath}`)
  console.log('')
  console.log('Next step: paste the recovery prompt into a new Codex turn, or ask Codex to read it and continue.')
}

function parseArgs(argv) {
  const options = {
    codexHome: undefined,
    session: undefined,
    output: undefined,
    maxSessions: defaultMaxSessions,
    tailEvents: defaultTailEvents,
    maxFieldChars: defaultMaxFieldChars,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--codex-home') {
      options.codexHome = argv[++index]
    } else if (arg === '--session') {
      options.session = argv[++index]
    } else if (arg === '--output' || arg === '--out') {
      options.output = argv[++index]
    } else if (arg === '--max-sessions') {
      options.maxSessions = Number(argv[++index])
    } else if (arg === '--tail-events') {
      options.tailEvents = Number(argv[++index])
    } else if (arg === '--max-field-chars') {
      options.maxFieldChars = Number(argv[++index])
    } else if (arg === '--latest-failed') {
      // Default behavior; accepted for explicit scripts and aliases.
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

function printUsage() {
  console.log(`Usage:
  node recover_codex_turn.mjs [--codex-home <path>] [--session <jsonl>] [--output <dir>]

Options:
  --codex-home <path>      Codex home directory. Defaults to <home>/.codex.
  --session <jsonl>        Recover this exact Codex session file.
  --latest-failed          Recover the most recent failed stream session. This is the default.
  --output <dir>           Output directory. Defaults to ./.codex-recovery.
  --max-sessions <n>       Recent session files to inspect when --session is omitted. Defaults to 80.
  --tail-events <n>        Recent user/assistant/tool events to include. Defaults to 36.
  --max-field-chars <n>    Per-field truncation budget. Defaults to 6000.`)
}

async function findLatestRecoverableSession(codexHome, maxSessions) {
  const sessionsDir = join(codexHome, 'sessions')
  if (!existsSync(sessionsDir)) return undefined
  const sessions = collectJsonlFiles(sessionsDir)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxSessions)
  for (const session of sessions) {
    const summary = await inspectSessionForFailure(session.path)
    if (summary.recoverable) return session.path
  }
  return undefined
}

function collectJsonlFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const info = statSync(path)
        files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
      }
    }
  }
  return files
}

async function inspectSessionForFailure(path) {
  let hasRecoverableError = false
  let hasNullCompletionAfterError = false
  await readJsonLines(path, (entry) => {
    if (entry.type !== 'event_msg') return
    const payload = entry.payload ?? {}
    if (payload.type === 'error' && isRecoverableError(payload.message ?? '')) {
      hasRecoverableError = true
    }
    if (payload.type === 'task_complete' && payload.last_agent_message == null && hasRecoverableError) {
      hasNullCompletionAfterError = true
    }
  })
  return { recoverable: hasRecoverableError || hasNullCompletionAfterError }
}

async function recoverSession(path, options) {
  const turns = []
  const session = {
    generatedAt: new Date().toISOString(),
    sourceSession: path,
    sourceSessionName: basename(path),
    sessionMeta: {},
    failure: undefined,
    turn: undefined,
    notes: [
      'Sensitive tokens and blocked promotional/community URLs are redacted.',
      'Recovery is based on Codex session JSONL evidence and may omit hidden reasoning.'
    ]
  }
  let currentTurn = createTurn('(unknown)')

  await readJsonLines(path, (entry) => {
    const payload = entry.payload ?? {}
    if (entry.type === 'session_meta') {
      session.sessionMeta = pickSessionMeta(payload)
      return
    }

    if (entry.type === 'event_msg' && payload.type === 'task_started') {
      if (turnHasContent(currentTurn)) turns.push(finalizeTurn(currentTurn, options))
      currentTurn = createTurn(payload.turn_id ?? '(unknown)', entry.timestamp)
      currentTurn.startedAt = entry.timestamp
      currentTurn.modelContextWindow = payload.model_context_window
      return
    }

    captureEvent(currentTurn, entry, options)

    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      currentTurn.completedAt = entry.timestamp
      currentTurn.durationMs = payload.duration_ms
      currentTurn.lastAgentMessage = sanitizeText(payload.last_agent_message ?? '')
      currentTurn.nullCompletion = payload.last_agent_message == null
      turns.push(finalizeTurn(currentTurn, options))
      currentTurn = createTurn('(after-complete)')
    }
  })

  if (turnHasContent(currentTurn)) turns.push(finalizeTurn(currentTurn, options))

  const failedTurn = [...turns].reverse().find((turn) => isRecoverableTurn(turn))
  const latestTurn = turns.at(-1)
  const turn = failedTurn ?? latestTurn
  session.turn = turn
  session.failure = turn?.failure
  session.status = failedTurn ? 'recoverable_failed_turn' : 'latest_turn_without_detected_stream_failure'
  return session
}

function createTurn(turnId, timestamp) {
  return {
    turnId,
    startedAt: timestamp,
    completedAt: undefined,
    durationMs: undefined,
    modelContextWindow: undefined,
    userMessages: [],
    agentMessages: [],
    assistantFinalMessages: [],
    toolCalls: [],
    toolOutputs: [],
    recentEvents: [],
    failure: undefined,
    nullCompletion: false
  }
}

function captureEvent(turn, entry, options) {
  const payload = entry.payload ?? {}
  if (entry.type === 'event_msg') {
    if (payload.type === 'user_message') {
      const text = clamp(sanitizeText(payload.message ?? ''), options.maxFieldChars)
      turn.userMessages.push({ timestamp: entry.timestamp, text })
      addRecent(turn, options.tailEvents, {
        kind: 'user_message',
        timestamp: entry.timestamp,
        text: clamp(text, 1200)
      })
    } else if (payload.type === 'agent_message') {
      const text = clamp(sanitizeText(payload.message ?? ''), options.maxFieldChars)
      turn.agentMessages.push({ timestamp: entry.timestamp, phase: payload.phase, text })
      addRecent(turn, options.tailEvents, {
        kind: 'agent_message',
        timestamp: entry.timestamp,
        phase: payload.phase,
        text: clamp(text, 1200)
      })
    } else if (payload.type === 'error') {
      const message = clamp(sanitizeText(payload.message ?? ''), options.maxFieldChars)
      turn.failure = {
        timestamp: entry.timestamp,
        message,
        codexErrorInfo: payload.codex_error_info
      }
      addRecent(turn, options.tailEvents, {
        kind: 'error',
        timestamp: entry.timestamp,
        text: message
      })
    }
    return
  }

  if (entry.type !== 'response_item') return

  if (payload.type === 'message') {
    const text = payloadText(payload)
    if (!text) return
    if (payload.role === 'assistant') {
      const message = {
        timestamp: entry.timestamp,
        phase: payload.phase,
        text: clamp(sanitizeText(text), options.maxFieldChars)
      }
      if (payload.phase === 'final') turn.assistantFinalMessages.push(message)
      addRecent(turn, options.tailEvents, {
        kind: 'assistant_message',
        timestamp: entry.timestamp,
        phase: payload.phase,
        text: clamp(message.text, 1200)
      })
    } else if (payload.role === 'user') {
      const textValue = clamp(sanitizeText(text), options.maxFieldChars)
      turn.userMessages.push({ timestamp: entry.timestamp, text: textValue, source: 'response_item' })
    }
  } else if (payload.type === 'function_call') {
    const call = {
      timestamp: entry.timestamp,
      callId: payload.call_id,
      name: payload.name,
      arguments: clamp(sanitizeText(payload.arguments ?? ''), options.maxFieldChars),
      summary: summarizeCall(payload)
    }
    turn.toolCalls.push(call)
    addRecent(turn, options.tailEvents, {
      kind: 'tool_call',
      timestamp: entry.timestamp,
      callId: call.callId,
      text: call.summary
    })
  } else if (payload.type === 'function_call_output') {
    const output = {
      timestamp: entry.timestamp,
      callId: payload.call_id,
      output: clamp(sanitizeText(payload.output ?? ''), options.maxFieldChars),
      summary: summarizeOutput(payload.output ?? '')
    }
    turn.toolOutputs.push(output)
    addRecent(turn, options.tailEvents, {
      kind: 'tool_output',
      timestamp: entry.timestamp,
      callId: output.callId,
      text: output.summary
    })
  }
}

function finalizeTurn(turn, options) {
  const recentCallIds = new Set(turn.recentEvents.filter((event) => event.callId).map((event) => event.callId))
  const recentToolCalls = turn.toolCalls.filter((call) => recentCallIds.has(call.callId)).slice(-options.tailEvents)
  const recentToolOutputs = turn.toolOutputs.filter((output) => recentCallIds.has(output.callId)).slice(-options.tailEvents)
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    modelContextWindow: turn.modelContextWindow,
    failed: isRecoverableError(turn.failure?.message ?? '') || Boolean(turn.failure && turn.nullCompletion),
    nullCompletion: turn.nullCompletion,
    failure: turn.failure,
    lastUserMessage: chooseLastUserMessage(turn.userMessages),
    userMessages: compactMessages(turn.userMessages, 4),
    recentAgentMessages: compactMessages(turn.agentMessages, 8),
    assistantFinalMessages: compactMessages(turn.assistantFinalMessages, 3),
    recentToolCalls,
    recentToolOutputs,
    recentEvents: turn.recentEvents
  }
}

function isRecoverableTurn(turn) {
  return Boolean(turn?.failed || (turn?.failure && turn?.nullCompletion))
}

function turnHasContent(turn) {
  return Boolean(
    turn.failure
    || turn.userMessages.length
    || turn.agentMessages.length
    || turn.assistantFinalMessages.length
    || turn.toolCalls.length
    || turn.toolOutputs.length
  )
}

function chooseLastUserMessage(messages) {
  const realMessage = [...messages].reverse().find((message) => message.source !== 'response_item' || !looksLikeInjectedContext(message.text))
  return realMessage ?? messages.at(-1)
}

function looksLikeInjectedContext(text) {
  return text.startsWith('# AGENTS.md instructions') || text.startsWith('<permissions instructions>')
}

function compactMessages(messages, count) {
  return messages
    .filter((message) => message.text && !looksLikeInjectedContext(message.text))
    .slice(-count)
}

function addRecent(turn, limit, event) {
  turn.recentEvents.push(event)
  while (turn.recentEvents.length > limit) turn.recentEvents.shift()
}

function payloadText(payload) {
  if (typeof payload.content === 'string') return payload.content
  if (!Array.isArray(payload.content)) return ''
  return payload.content
    .map((item) => item?.text ?? '')
    .filter(Boolean)
    .join('\n')
}

function summarizeCall(payload) {
  const argsText = sanitizeText(payload.arguments ?? '')
  let args
  try {
    args = JSON.parse(payload.arguments)
  } catch {
    return `${payload.name} ${clamp(argsText, 300)}`
  }
  if (payload.name === 'shell_command' || payload.name?.endsWith('.shell_command')) {
    const workdir = args.workdir ? ` cwd=${args.workdir}` : ''
    return `${payload.name}:${workdir} ${clamp(args.command ?? '', 500)}`
  }
  if (payload.name === 'apply_patch') {
    return `${payload.name}: patch (${argsText.length} chars)`
  }
  return `${payload.name}: ${clamp(JSON.stringify(args), 500)}`
}

function summarizeOutput(output) {
  const text = sanitizeText(output)
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const exitLine = lines.find((line) => /^Exit code:/i.test(line))
  const outputLine = lines.find((line) => /^Output:/i.test(line))
  const useful = lines.filter((line) => !/^Wall time:/i.test(line)).slice(0, 8)
  return clamp([exitLine, outputLine, ...useful].filter(Boolean).join('\n'), 1200)
}

function pickSessionMeta(payload) {
  return {
    id: payload.id,
    timestamp: payload.timestamp,
    cwd: payload.cwd,
    originator: payload.originator,
    cliVersion: payload.cli_version,
    source: payload.source,
    modelProvider: payload.model_provider,
    model: payload.model,
    approvalPolicy: payload.approval_policy,
    sandboxPolicy: payload.sandbox_policy
  }
}

async function readJsonLines(path, onEntry) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of reader) {
    if (!line.trim()) continue
    try {
      onEntry(JSON.parse(line))
    } catch {
      // Ignore partial or corrupt JSONL lines. Recovery should be best-effort.
    }
  }
}

function buildPrompt(recovery) {
  const meta = recovery.sessionMeta ?? {}
  const turn = recovery.turn ?? {}
  const lastUser = turn.lastUserMessage?.text ?? '(not found)'
  const agentMessages = turn.recentAgentMessages ?? []
  const toolCalls = turn.recentToolCalls ?? []
  const toolOutputs = turn.recentToolOutputs ?? []

  return `# Codex Session Recovery Prompt

You are continuing a Codex task after the previous streaming response disconnected before normal completion. Use the recovered evidence below to continue the work instead of restarting from scratch.

## Source

- Session file: ${recovery.sourceSession}
- Session id: ${meta.id ?? '(unknown)'}
- Working directory: ${meta.cwd ?? '(unknown)'}
- Originator: ${meta.originator ?? '(unknown)'}
- CLI version: ${meta.cliVersion ?? '(unknown)'}
- Model provider: ${meta.modelProvider ?? '(unknown)'}
- Model: ${meta.model ?? '(unknown)'}
- Turn id: ${turn.turnId ?? '(unknown)'}
- Failure: ${turn.failure?.message ?? '(no stream failure detected in selected turn)'}
- Failure time: ${turn.failure?.timestamp ?? '(unknown)'}

## Last User Request

${asBlock(lastUser)}

## Recent Assistant Progress

${agentMessages.length ? agentMessages.map((message) => `- ${message.timestamp ?? ''} ${message.phase ? `[${message.phase}] ` : ''}${singleLine(message.text)}`).join('\n') : '- (none recovered)'}

## Recent Tool Calls

${toolCalls.length ? toolCalls.map((call) => `- ${call.timestamp ?? ''} ${call.callId ?? ''} ${singleLine(call.summary)}`).join('\n') : '- (none recovered)'}

## Recent Tool Outputs

${toolOutputs.length ? toolOutputs.map((output) => `- ${output.timestamp ?? ''} ${output.callId ?? ''}\n${asBlock(output.output || output.summary)}`).join('\n\n') : '- (none recovered)'}

## Continue Instructions

1. Continue the user's task from the recovered state.
2. Treat recovered tool outputs as evidence, but re-check files or commands when correctness matters.
3. Do not repeat work that the recovered evidence shows is already complete.
4. If an output was truncated or redacted, say what you need to re-run and then proceed.
5. Preserve all current workspace, safety, and user instructions in the new Codex turn.
`
}

function asBlock(text) {
  const value = String(text || '').trim()
  if (!value) return '```text\n(not available)\n```'
  return `\`\`\`text\n${value}\n\`\`\``
}

function singleLine(text) {
  return clamp(String(text || '').replace(/\s+/g, ' ').trim(), 500)
}

function sanitizeText(value) {
  let sanitized = String(value ?? '')
  for (const { pattern, replacement } of secretPatterns) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized
}

function isRecoverableError(message) {
  return recoverableErrorPatterns.some((pattern) => pattern.test(message))
}

function clamp(value, maxChars) {
  const text = String(value ?? '')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`
}

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
