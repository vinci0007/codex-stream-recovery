#!/usr/bin/env node
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const defaultTailBytes = 512 * 1024
const defaultMaxLogFiles = 8

const secretPatterns = [
  { pattern: /sk-[A-Za-z0-9_-]{16,}/g, replacement: '[redacted]' },
  { pattern: /\bnvapi-[A-Za-z0-9_-]{12,}\b/g, replacement: '[redacted]' },
  { pattern: /\b[A-Za-z][A-Za-z0-9_-]{0,20}api-[A-Za-z0-9_-]{16,}\b/g, replacement: '[redacted]' },
  { pattern: /\b(?:ghp|github_pat|gsk|hf|xoxb|xoxp)_[A-Za-z0-9_-]{16,}\b/g, replacement: '[redacted]' },
  { pattern: /(api[_-]?key["':=\s]+)[A-Za-z0-9._-]{12,}/gi, replacement: '$1[redacted]' },
  { pattern: /(authorization["':=\s]+bearer\s+)[A-Za-z0-9._-]{12,}/gi, replacement: '$1[redacted]' },
  { pattern: /https?:\/\/dc\.hhhl\.cc\/chat\/room\/[A-Za-z0-9_-]+/g, replacement: '[redacted]' }
]

const markerGroups = {
  codex_stream: [
    'Reconnecting',
    'stream disconnected before completion',
    'Upstream request failed',
    'stream error',
    'stream interrupted',
    'response.failed'
  ],
  local_network: [
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'TLS',
    'certificate',
    'proxy',
    'VPN',
    'socket hang up'
  ],
  provider_or_gateway: [
    'upstream',
    'gateway',
    '502',
    '503',
    '504',
    '429',
    'rate limit',
    'overloaded',
    'capacity',
    'idle timeout',
    'SSE'
  ],
  auth_or_config: [
    '401',
    '403',
    'unauthorized',
    'forbidden',
    'invalid_api_key',
    'invalid token',
    'expired',
    'base_url',
    'model_not_found'
  ],
  prompt_or_payload: [
    'context_length',
    'context length',
    'payload too large',
    'request body',
    '413',
    'too many tokens',
    'maximum context'
  ]
}

const errorContextNeedles = [
  'error',
  'failed',
  'failure',
  'warn',
  'retry',
  'disconnect',
  'timeout',
  'unauthorized',
  'forbidden',
  'invalid',
  'refused',
  'reset',
  'overloaded',
  'capacity'
]

function main() {
  const options = parseArgs(process.argv.slice(2))
  const codexHome = resolve(options.codexHome ?? join(homedir(), '.codex'))
  const tailBytes = Number.isFinite(options.tailBytes) ? options.tailBytes : defaultTailBytes
  const maxLogFiles = Number.isFinite(options.maxLogFiles) ? options.maxLogFiles : defaultMaxLogFiles
  const logInputs = [
    ...(options.skipCodexHome ? [] : defaultCodexLogInputs(codexHome)),
    ...options.logs
  ]
  const logFiles = collectLogFiles(logInputs, maxLogFiles)
  const matches = scanLogs(logFiles, {
    tailBytes,
    query: options.query,
    traceId: options.traceId
  })
  const summary = summarizeMatches(matches)

  printHeader('Codex stream recovery report')
  console.log(`Codex home: ${options.skipCodexHome ? '(skipped)' : codexHome}`)
  console.log(`Trace filter: ${options.traceId ?? '(none)'}`)
  console.log(`Query filter: ${options.query ?? '(none)'}`)
  console.log('')

  printLogFiles(logFiles)
  printMatches(matches)
  printSummary(summary, matches, logFiles)
}

function parseArgs(argv) {
  const options = {
    codexHome: undefined,
    logs: [],
    traceId: undefined,
    query: undefined,
    tailBytes: defaultTailBytes,
    maxLogFiles: defaultMaxLogFiles,
    skipCodexHome: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--codex-home') {
      options.codexHome = argv[++index]
    } else if (arg === '--logs' || arg === '--log') {
      options.logs.push(argv[++index])
    } else if (arg === '--trace-id') {
      options.traceId = argv[++index]
    } else if (arg === '--query') {
      options.query = argv[++index]
    } else if (arg === '--tail-bytes') {
      options.tailBytes = Number(argv[++index])
    } else if (arg === '--max-log-files') {
      options.maxLogFiles = Number(argv[++index])
    } else if (arg === '--no-codex-home') {
      options.skipCodexHome = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
  }
  return options
}

function printUsage() {
  console.log(`Usage:
  node inspect_codex_stream_recovery.mjs [--codex-home <path>] [--logs <path>] [--trace-id <id>] [--query <text>]

Options:
  --codex-home <path>    Codex home directory. Defaults to <home>/.codex.
  --logs <path>          Extra text log file or directory. Can be repeated.
  --trace-id <id>        Only report matching log lines.
  --query <text>         Also match lines containing this text.
  --tail-bytes <bytes>   Bytes to read from each log tail. Defaults to 524288.
  --max-log-files <n>    Max recent files per directory. Defaults to 8.
  --no-codex-home        Do not scan default Codex logs.`)
}

function defaultCodexLogInputs(codexHome) {
  return [
    join(codexHome, 'log'),
    join(codexHome, 'logs'),
    join(codexHome, 'sandbox.log')
  ]
}

function collectLogFiles(inputs, maxFiles) {
  const files = []
  const seen = new Set()
  for (const input of inputs) {
    if (!input) continue
    const path = resolve(input)
    if (!existsSync(path)) continue
    const info = statSync(path)
    if (info.isFile() && isTextLogCandidate(path)) {
      addFile(files, seen, path, info)
      continue
    }
    if (info.isDirectory()) {
      const directoryFiles = readdirSync(path)
        .map((name) => {
          const filePath = join(path, name)
          const fileInfo = statSync(filePath)
          return fileInfo.isFile() && isTextLogCandidate(filePath)
            ? { path: filePath, mtimeMs: fileInfo.mtimeMs, size: fileInfo.size }
            : undefined
        })
        .filter(Boolean)
        .sort((left, right) => right.mtimeMs - left.mtimeMs)
        .slice(0, maxFiles)
      for (const file of directoryFiles) {
        addFile(files, seen, file.path, file)
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function addFile(files, seen, path, info) {
  const key = path.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
}

function isTextLogCandidate(path) {
  const name = basename(path).toLowerCase()
  return name.endsWith('.log') || name.endsWith('.txt') || name.endsWith('.jsonl')
}

function scanLogs(logFiles, options) {
  const matches = []
  const needles = [
    ...Object.values(markerGroups).flat(),
    ...(options.query ? [options.query] : [])
  ]
  for (const file of logFiles) {
    const text = readTail(file.path, options.tailBytes)
    const lines = text.split(/\r?\n/)
    for (const rawLine of lines) {
      if (!rawLine.trim()) continue
      const structured = parseCodexJsonlLine(rawLine)
      const searchableLine = structured ? structured.searchable : rawLine
      if (!searchableLine.trim()) continue
      if (options.traceId && !searchableLine.includes(options.traceId)) continue
      const groups = matchedGroups(searchableLine)
      const queryMatched = options.query ? searchableLine.includes(options.query) : false
      if (groups.length === 0 && !queryMatched) continue
      matches.push({
        file: file.path,
        groups,
        line: sanitizeLine(structured ? structured.display : rawLine)
      })
    }
  }
  return matches
}

function parseCodexJsonlLine(rawLine) {
  let entry
  try {
    entry = JSON.parse(rawLine)
  } catch {
    return undefined
  }
  if (!entry || typeof entry !== 'object' || !entry.type || !entry.payload) {
    return undefined
  }

  const payload = entry.payload
  if (entry.type === 'session_meta') {
    const display = `session_meta: cwd=${payload.cwd ?? '(unknown)'} origin=${payload.originator ?? '(unknown)'} provider=${payload.model_provider ?? '(unknown)'} cli=${payload.cli_version ?? '(unknown)'}`
    return { searchable: display, display }
  }

  if (entry.type === 'event_msg') {
    if (payload.type === 'error') {
      const message = payload.message ?? ''
      return {
        searchable: message,
        display: `event error: ${message}`
      }
    }
    if (payload.type === 'task_complete') {
      const message = payload.last_agent_message ?? ''
      return {
        searchable: message,
        display: `event task_complete: turn=${payload.turn_id ?? '(unknown)'} last_agent_message=${message ? truncateForDisplay(message) : '(none)'}`
      }
    }
    if (payload.type === 'user_message' || payload.type === 'agent_message') {
      const message = payload.message ?? ''
      return {
        searchable: message,
        display: `event ${payload.type}: ${truncateForDisplay(message)}`
      }
    }
    return { searchable: '', display: '' }
  }

  if (entry.type === 'response_item') {
    if (payload.type === 'function_call') {
      const text = `${payload.name ?? ''} ${payload.arguments ?? ''}`
      return {
        searchable: text,
        display: `tool_call ${payload.name ?? '(unknown)'}: ${truncateForDisplay(payload.arguments ?? '')}`
      }
    }
    if (payload.type === 'function_call_output') {
      return {
        searchable: payload.output ?? '',
        display: `tool_output ${payload.call_id ?? '(unknown)'}: ${truncateForDisplay(payload.output ?? '')}`
      }
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = payloadContentText(payload)
      return {
        searchable: text,
        display: `assistant ${payload.phase ?? 'message'}: ${truncateForDisplay(text)}`
      }
    }
  }

  return { searchable: '', display: '' }
}

function payloadContentText(payload) {
  if (typeof payload.content === 'string') return payload.content
  if (!Array.isArray(payload.content)) return ''
  return payload.content.map((item) => item?.text ?? '').filter(Boolean).join('\n')
}

function truncateForDisplay(text, maxChars = 1000) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)} [truncated ${value.length - maxChars} chars]`
}

function matchedGroups(line) {
  const normalized = line.toLowerCase()
  const groups = []
  for (const [group, needles] of Object.entries(markerGroups)) {
    if (needles.some((needle) => normalized.includes(needle.toLowerCase()))) {
      groups.push(group)
    }
  }
  if (
    groups.length > 0
    && !groups.includes('codex_stream')
    && !errorContextNeedles.some((needle) => normalized.includes(needle))
  ) {
    return []
  }
  return groups
}

function readTail(path, bytes) {
  const file = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const length = Math.min(Math.max(0, bytes), size)
    const offset = Math.max(0, size - length)
    const buffer = Buffer.alloc(length)
    readSync(file, buffer, 0, length, offset)
    return buffer.toString('utf8')
  } finally {
    closeSync(file)
  }
}

function summarizeMatches(matches) {
  const counts = new Map()
  for (const match of matches) {
    for (const group of match.groups) {
      counts.set(group, (counts.get(group) ?? 0) + 1)
    }
  }
  return counts
}

function printLogFiles(logFiles) {
  printHeader('Scanned logs')
  if (logFiles.length === 0) {
    console.log('No text logs found. Pass --logs <file-or-directory> to scan exported Codex, terminal, gateway, or proxy logs.')
    console.log('')
    return
  }
  for (const file of logFiles) {
    console.log(`- ${file.path} (${file.size} bytes)`)
  }
  console.log('')
}

function printMatches(matches) {
  printHeader('Matched evidence')
  if (matches.length === 0) {
    console.log('No reconnect, stream, network, provider, auth, or payload markers found in scanned tails.')
    console.log('')
    return
  }
  for (const match of matches.slice(-60)) {
    const groupText = match.groups.length > 0 ? `[${match.groups.join(',')}] ` : ''
    console.log(`- ${basename(match.file)}: ${groupText}${match.line}`)
  }
  if (matches.length > 60) {
    console.log(`... ${matches.length - 60} earlier match(es) omitted`)
  }
  console.log('')
}

function printSummary(summary, matches, logFiles) {
  printHeader('Next steps')
  if (summary.size === 0) {
    console.log(logFiles.length === 0
      ? 'Collect Codex logs or rerun with --logs. Also note the exact time, prompt size, network/proxy state, and provider/base URL.'
      : 'No direct markers were found. Reproduce once, record the time, then rerun this script with --tail-bytes increased or --query set to a known error fragment.')
    return
  }
  const ranked = [...summary.entries()].sort((left, right) => right[1] - left[1])
  console.log(`Likely bucket: ${ranked[0][0]}`)
  console.log(`Evidence groups: ${ranked.map(([group, count]) => `${group}=${count}`).join(', ')}`)
  if (summary.has('local_network')) {
    console.log('Next step: test without VPN/proxy or from another network, then retry a short Codex prompt.')
  } else if (summary.has('auth_or_config')) {
    console.log('Next step: verify credentials, base URL, selected model, and provider auth outside the failed turn.')
  } else if (summary.has('provider_or_gateway')) {
    console.log('Next step: inspect provider/gateway status and logs around the same timestamp for 429/5xx, idle timeout, or premature SSE close.')
  } else if (summary.has('prompt_or_payload')) {
    console.log('Next step: reproduce with a very short prompt, then add files/context gradually.')
  } else {
    console.log('Next step: retry once with a minimal prompt and capture the exact timestamp plus any trace/request id.')
  }
  console.log(`Residual risk: ${matches.length} matching line(s) are log clues, not proof of root cause without a timestamped reproduction.`)
}

function printHeader(title) {
  console.log(`== ${title} ==`)
}

function sanitizeLine(line) {
  let sanitized = line
  for (const { pattern, replacement } of secretPatterns) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized
}

main()
