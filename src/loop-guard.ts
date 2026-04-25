// Per-session loop guard: short-circuits tool calls that the agent has
// already issued in this session.
//
// Why this exists:
//   - messages-trim.ts collapses superseded/duplicate tool outputs AFTER the
//     fact, hiding them from the model on subsequent turns.
//   - That still pays the per-call cost: the tool_use call's own output
//     tokens, and the input tokens of the result on its arrival turn.
//   - If the model's reasoning is stuck in a loop ("read foo.ts at offset 0,
//     then offset 100, then offset 0 again, ..."), trim helps the NEXT turn
//     but not the current one. The loop keeps re-firing.
//
// What this does:
//   - tool.execute.before: records every Read/Bash/WebFetch call. If the
//     incoming call repeats prior work (same file w/ subsumed range, same
//     bash command, same url), flags the callID for short-circuit.
//   - tool.execute.after: if flagged, replaces the tool output with a terse
//     marker pointing at the prior call. Lossy but intentional - the marker
//     tells the model "you already did this, stop".
//
// Why short-circuit at .after rather than skip in .before:
//   - The plugin API for tool.execute.before only mutates input args, it
//     cannot abort tool execution or supply a synthetic result. So we let
//     the call run, then overwrite its result. The wasted compute is local
//     to opencode (Read syscall, Bash exec); the wasted TOKENS are killed.
//
// Heuristics (tuned conservative; goal is high precision, not recall):
//   - Read: subsumed if [offset, offset+limit) is contained in union of
//     prior ranges for same filePath. Also flagged if count >= LOOP_HARD_LIMIT.
//   - Bash: flagged if exact same command string seen >= LOOP_HARD_LIMIT.
//   - WebFetch: flagged if same url seen >= 2 (web pages don't change).
//
// Kill switch: OPENCODE_CTX_LOOP=0 disables.
// Tunables:
//   OPENCODE_CTX_LOOP_LIMIT=N   per-key call count threshold (default 3)
//   OPENCODE_CTX_LOOP_DEBUG=1   log decisions to stderr

const DISABLED = process.env.OPENCODE_CTX_LOOP === "0"
const LOOP_HARD_LIMIT = Number(process.env.OPENCODE_CTX_LOOP_LIMIT ?? "3")
const DEBUG = process.env.OPENCODE_CTX_LOOP_DEBUG === "1"

const log = (msg: string) => DEBUG && process.stderr.write(`[ctx-plugin loop] ${msg}\n`)

// Bound the in-memory state. Real opencode sessions can be very long-lived;
// we cap by recency to avoid unbounded growth.
const MAX_SESSIONS = 32
const MAX_KEYS_PER_SESSION = 256

type Range = readonly [number, number]

type ReadEntry = {
  ranges: Range[]
  count: number
  firstCallID: string
  lastCallID: string
}

type CallEntry = {
  count: number
  firstCallID: string
  lastCallID: string
}

type SessionState = {
  reads: Map<string, ReadEntry>
  bash: Map<string, CallEntry>
  webfetch: Map<string, CallEntry>
  pending: Map<string, string>
  touched: number
}

const sessions = new Map<string, SessionState>()

// Delegation sub-sessions (tool call IDs) should not have loop guard applied
// so that their full outputs are visible in the parent session's UI.
function isDelegationSession(sessionID: string): boolean {
  return sessionID.startsWith("tool_")
}

// Returns a no-op state for delegation sessions so loop guard doesn't interfere.
const noopState: SessionState = {
  reads: new Map(),
  bash: new Map(),
  webfetch: new Map(),
  pending: new Map(),
  touched: 0,
}

function getSession(sessionID: string): SessionState {
  // Skip loop guard entirely for delegation sub-sessions
  if (isDelegationSession(sessionID)) {
    return noopState
  }

  let s = sessions.get(sessionID)
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      // Evict oldest by `touched` timestamp.
      let oldestId: string | undefined
      let oldestTs = Number.POSITIVE_INFINITY
      for (const [id, state] of sessions) {
        if (state.touched < oldestTs) {
          oldestTs = state.touched
          oldestId = id
        }
      }
      if (oldestId) sessions.delete(oldestId)
    }
    s = {
      reads: new Map(),
      bash: new Map(),
      webfetch: new Map(),
      pending: new Map(),
      touched: Date.now(),
    }
    sessions.set(sessionID, s)
  }
  s.touched = Date.now()
  return s
}

function trimMap<T>(m: Map<string, T>, cap: number): void {
  if (m.size <= cap) return
  const drop = m.size - cap
  let i = 0
  for (const k of m.keys()) {
    if (i++ >= drop) break
    m.delete(k)
  }
}

// Merge a new range into a sorted-merged union; return new union and whether
// the new range was already fully covered by the prior union.
function mergeRange(union: Range[], next: Range): { merged: Range[]; subsumed: boolean } {
  let subsumed = false
  for (const [lo, hi] of union) {
    if (next[0] >= lo && next[1] <= hi) {
      subsumed = true
      break
    }
  }
  const all = [...union, next].sort((a, b) => a[0] - b[0])
  const merged: Range[] = []
  for (const r of all) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], r[1])]
      continue
    }
    merged.push([r[0], r[1]])
  }
  // Cap union length to keep merge cheap; collapse adjacent if too many.
  while (merged.length > 64) merged.shift()
  return { merged, subsumed }
}

function getString(v: unknown, key: string): string | undefined {
  if (!v || typeof v !== "object") return undefined
  const x = (v as Record<string, unknown>)[key]
  return typeof x === "string" ? x : undefined
}

function getNumber(v: unknown, key: string): number | undefined {
  if (!v || typeof v !== "object") return undefined
  const x = (v as Record<string, unknown>)[key]
  return typeof x === "number" && Number.isFinite(x) ? x : undefined
}

function readMarker(filePath: string, count: number, firstCallID: string, reason: "subsumed" | "limit"): string {
  const why =
    reason === "subsumed"
      ? `range already covered by prior read(s)`
      : `read ${count} times this session - looks like a loop`
  return `[ctx-plugin loop guard: refusing to re-read ${filePath} - ${why}. First call: ${firstCallID}. If you need fresh content, edit the file or change approach.]`
}

function bashMarker(command: string, count: number, firstCallID: string): string {
  const head = command.length > 80 ? command.slice(0, 77) + "..." : command
  return `[ctx-plugin loop guard: refusing to re-run bash \`${head}\` - already ran ${count} times this session. First call: ${firstCallID}. Output is the same; vary the command or stop.]`
}

function webfetchMarker(url: string, count: number, firstCallID: string): string {
  return `[ctx-plugin loop guard: refusing to re-fetch ${url} - already fetched ${count} times this session. First call: ${firstCallID}. Web pages do not change between turns.]`
}

export type LoopGuardBeforeInput = {
  tool: string
  sessionID: string
  callID: string
}

export type LoopGuardBeforeOutput = {
  args: unknown
}

export function noteToolCallBefore(input: LoopGuardBeforeInput, output: LoopGuardBeforeOutput): void {
  if (DISABLED) return
  const tool = input.tool
  if (tool !== "read" && tool !== "bash" && tool !== "webfetch") return

  const session = getSession(input.sessionID)

  if (tool === "read") {
    const filePath = getString(output.args, "filePath")
    if (!filePath) return
    const offset = getNumber(output.args, "offset") ?? 1
    const limit = getNumber(output.args, "limit") ?? 2000
    const range: Range = [offset, offset + limit]

    const prior = session.reads.get(filePath)
    if (!prior) {
      session.reads.set(filePath, {
        ranges: [range],
        count: 1,
        firstCallID: input.callID,
        lastCallID: input.callID,
      })
      trimMap(session.reads, MAX_KEYS_PER_SESSION)
      return
    }

    const { merged, subsumed } = mergeRange(prior.ranges, range)
    prior.ranges = merged
    prior.count += 1
    prior.lastCallID = input.callID
    const overLimit = prior.count >= LOOP_HARD_LIMIT
    if (subsumed || overLimit) {
      const reason = subsumed ? "subsumed" : "limit"
      session.pending.set(input.callID, readMarker(filePath, prior.count, prior.firstCallID, reason))
      log(`flag read ${filePath} call=${input.callID} reason=${reason} count=${prior.count}`)
    }
    return
  }

  if (tool === "bash") {
    const command = getString(output.args, "command")
    if (!command) return
    const prior = session.bash.get(command)
    if (!prior) {
      session.bash.set(command, { count: 1, firstCallID: input.callID, lastCallID: input.callID })
      trimMap(session.bash, MAX_KEYS_PER_SESSION)
      return
    }
    prior.count += 1
    prior.lastCallID = input.callID
    if (prior.count >= LOOP_HARD_LIMIT) {
      session.pending.set(input.callID, bashMarker(command, prior.count, prior.firstCallID))
      log(`flag bash call=${input.callID} count=${prior.count}`)
    }
    return
  }

  // webfetch: same URL twice is already wasteful (pages stable per session).
  const url = getString(output.args, "url")
  if (!url) return
  const prior = session.webfetch.get(url)
  if (!prior) {
    session.webfetch.set(url, { count: 1, firstCallID: input.callID, lastCallID: input.callID })
    trimMap(session.webfetch, MAX_KEYS_PER_SESSION)
    return
  }
  prior.count += 1
  prior.lastCallID = input.callID
  if (prior.count >= 2) {
    session.pending.set(input.callID, webfetchMarker(url, prior.count, prior.firstCallID))
    log(`flag webfetch call=${input.callID} count=${prior.count}`)
  }
}

export type LoopGuardAfterInput = {
  tool: string
  sessionID: string
  callID: string
}

export type LoopGuardAfterOutput = {
  output?: unknown
  content?: Array<{ type?: string; text?: string }>
}

// Returns the byte delta (positive = bytes saved). Returns 0 if no marker.
export function replaceLoopOutputAfter(input: LoopGuardAfterInput, output: LoopGuardAfterOutput): number {
  if (DISABLED) return 0
  // Skip for delegation sessions - their outputs should be fully visible
  if (isDelegationSession(input.sessionID)) return 0
  const session = sessions.get(input.sessionID)
  if (!session) return 0
  const marker = session.pending.get(input.callID)
  if (!marker) return 0
  session.pending.delete(input.callID)

  if (typeof output.output === "string") {
    const before = output.output.length
    output.output = marker
    log(`replace ${input.tool} call=${input.callID}: ${before}B -> ${marker.length}B`)
    return before - marker.length
  }
  if (Array.isArray(output.content)) {
    let before = 0
    for (const item of output.content) {
      if (item?.type === "text" && typeof item.text === "string") before += item.text.length
    }
    output.content = [{ type: "text", text: marker }]
    log(`replace ${input.tool} (mcp) call=${input.callID}: ${before}B -> ${marker.length}B`)
    return before - marker.length
  }
  return 0
}

// Test helper: clear all session state.
export function _resetForTests(): void {
  sessions.clear()
}

export * as LoopGuard from "./loop-guard"
