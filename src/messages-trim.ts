// Trim stale tool outputs in message history before sending to LLM.
//
// Targets the biggest per-turn context growth: tool outputs from earlier turns
// that accumulate in history and get re-sent every request. Deterministic by
// design - same input produces same output - so Anthropic's prefix cache still
// hits on subsequent turns.
//
// Three passes applied in order:
//
// 1. Superseded-read collapse (lossless):
//    - A `read` of file X is superseded when a later `read` of X exists
//      (newer snapshot available) OR a later `write` of X exists (file was
//      fully replaced). In both cases the old read's output is definitionally
//      stale. Replaced with a compact `[ctx-plugin: ...]` marker.
//    - Edit-supersedes-Read is intentionally NOT applied: edits are partial,
//      old read output is still valid for unaffected regions.
//    - Always keeps the MOST RECENT read per file.
//
// 2. Duplicate-call dedup (lossless):
//    - If the same tool is called with identical args AND produces byte-
//      identical output on two or more turns, older instances are collapsed
//      to a compact marker pointing at the latest occurrence. Model has
//      full access to the latest copy; older ones are semantically
//      redundant by definition (same args, same output).
//    - Applied to non-structured tools only: read/write/edit are already
//      handled by pass 1; task/todowrite/question/call_omo_agent/patch are
//      always skipped.
//
// 3. Size-based trim:
//    - Preserve the LAST N tool outputs intact (recent work matters).
//    - Only touch `completed` tool parts; never touch pending/running/error.
//    - Skip structured-output tools (same skip list as pass 2).
//    - For eligible older tool outputs over the threshold, keep HEAD + TAIL
//      bytes and replace the middle with a compact marker.
//
// Cache safety: deterministic. Defensive: replaces `state` with a shallow
// clone instead of in-place property mutation, so the source objects (which
// may be live session references) are left untouched.

const PRESERVE_RECENT = Number(process.env.OPENCODE_CTX_MSGS_KEEP ?? "3")
const MAX_BYTES = Number(process.env.OPENCODE_CTX_MSGS_CAP ?? "600")
const HEAD_BYTES = Number(process.env.OPENCODE_CTX_MSGS_HEAD ?? "300")
const TAIL_BYTES = Number(process.env.OPENCODE_CTX_MSGS_TAIL ?? "150")
const SUPERSEDE_ENABLED = process.env.OPENCODE_CTX_SUPERSEDE !== "0"
const DEDUP_ENABLED = process.env.OPENCODE_CTX_DEDUP !== "0"
const DEDUP_MIN_BYTES = Number(process.env.OPENCODE_CTX_DEDUP_MIN ?? "200")

const SKIP_TOOLS = new Set(["task", "call_omo_agent", "patch", "todowrite", "question"])
const WRITE_TOOLS = new Set(["write"])
const DEDUP_SKIP_TOOLS = new Set([
  "task",
  "call_omo_agent",
  "patch",
  "todowrite",
  "question",
  "read",
  "write",
  "edit",
  "multiedit",
])

type LooseMsg = {
  info?: { role?: string }
  parts: Array<Record<string, unknown>>
}

type PartRef = { msg: LooseMsg; partIdx: number; order: number }

function getToolName(part: Record<string, unknown>): string {
  return typeof part.tool === "string" ? part.tool : ""
}

function getFilePath(part: Record<string, unknown>): string | undefined {
  const state = part.state as { input?: { filePath?: unknown } } | undefined
  const fp = state?.input?.filePath
  return typeof fp === "string" ? fp : undefined
}

function supersedeRead(msg: LooseMsg, partIdx: number, marker: string): number {
  const part = msg.parts[partIdx] as {
    state: { status: string; output: string; [k: string]: unknown }
    [k: string]: unknown
  }
  const before = part.state.output.length
  const newState = { ...part.state, output: marker }
  const newPart = { ...part, state: newState }
  msg.parts[partIdx] = newPart
  return before - marker.length
}

function collapseSupersededReads(messages: LooseMsg[]): { saved: number; collapsed: number } {
  const readsByPath = new Map<string, PartRef[]>()
  const firstWriteByPath = new Map<string, number>()
  let order = 0

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (part?.type !== "tool") continue
      const tool = getToolName(part)
      const state = part.state as { status?: string; output?: string } | undefined
      if (state?.status !== "completed") continue
      const filePath = getFilePath(part)
      if (!filePath) continue
      if (tool === "read" && typeof state.output === "string") {
        if (state.output.startsWith("[ctx-plugin:")) {
          order += 1
          continue
        }
        const list = readsByPath.get(filePath) ?? []
        list.push({ msg, partIdx: p, order })
        readsByPath.set(filePath, list)
      }
      if (WRITE_TOOLS.has(tool)) {
        if (!firstWriteByPath.has(filePath)) firstWriteByPath.set(filePath, order)
      }
      order += 1
    }
  }

  let saved = 0
  let collapsed = 0

  for (const [filePath, reads] of readsByPath) {
    if (reads.length === 0) continue
    const writeOrder = firstWriteByPath.get(filePath)
    const lastReadOrder = reads[reads.length - 1].order
    for (const ref of reads) {
      const isLastRead = ref.order === lastReadOrder
      const supersededByWrite = writeOrder !== undefined && ref.order < writeOrder
      const supersededByRead = !isLastRead && reads.some((r) => r.order > ref.order)
      if (!supersededByWrite && !supersededByRead) continue
      const reason = supersededByWrite ? "write" : "later read"
      const marker = `[ctx-plugin: read of ${filePath} superseded by ${reason} in a later turn]`
      saved += supersedeRead(ref.msg, ref.partIdx, marker)
      collapsed += 1
    }
  }

  return { saved, collapsed }
}

function getArgsJson(part: Record<string, unknown>): string | undefined {
  const state = part.state as { input?: unknown } | undefined
  if (!state || state.input === undefined) return undefined
  return JSON.stringify(state.input)
}

function collapseDuplicateCalls(messages: LooseMsg[]): { saved: number; collapsed: number } {
  const byKey = new Map<string, PartRef[]>()
  let order = 0

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (part?.type !== "tool") continue
      const tool = getToolName(part)
      if (DEDUP_SKIP_TOOLS.has(tool)) continue
      const state = part.state as { status?: string; output?: string } | undefined
      if (state?.status !== "completed") continue
      if (typeof state.output !== "string") continue
      if (state.output.startsWith("[ctx-plugin:")) {
        order += 1
        continue
      }
      if (state.output.length < DEDUP_MIN_BYTES) {
        order += 1
        continue
      }
      const argsJson = getArgsJson(part) ?? ""
      const key = `${tool}||${argsJson}||${state.output}`
      const list = byKey.get(key) ?? []
      list.push({ msg, partIdx: p, order })
      byKey.set(key, list)
      order += 1
    }
  }

  let saved = 0
  let collapsed = 0

  for (const [, refs] of byKey) {
    if (refs.length < 2) continue
    const latest = refs[refs.length - 1]
    for (const ref of refs) {
      if (ref.order === latest.order) continue
      const marker = `[ctx-plugin: identical tool output produced again at turn order ${latest.order}]`
      saved += supersedeRead(ref.msg, ref.partIdx, marker)
      collapsed += 1
    }
  }

  return { saved, collapsed }
}

export function trimMessageHistory(messages: LooseMsg[]): {
  before: number
  after: number
  trimmed: number
  superseded: number
  supersedeSaved: number
  deduped: number
  dedupSaved: number
} {
  let supersededCount = 0
  let supersedeSaved = 0
  if (SUPERSEDE_ENABLED) {
    const r = collapseSupersededReads(messages)
    supersededCount = r.collapsed
    supersedeSaved = r.saved
  }

  let dedupedCount = 0
  let dedupSaved = 0
  if (DEDUP_ENABLED) {
    const r = collapseDuplicateCalls(messages)
    dedupedCount = r.collapsed
    dedupSaved = r.saved
  }

  const eligible: Array<{ msg: LooseMsg; partIdx: number }> = []

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (part?.type !== "tool") continue
      const toolName = getToolName(part)
      if (SKIP_TOOLS.has(toolName)) continue
      const state = part.state as { status?: string; output?: string } | undefined
      if (state?.status !== "completed") continue
      if (typeof state.output !== "string") continue
      eligible.push({ msg, partIdx: p })
    }
  }

  const cutoff = Math.max(0, eligible.length - PRESERVE_RECENT)
  let before = 0
  let after = 0
  let trimmedCount = 0

  for (let i = 0; i < cutoff; i++) {
    const { msg, partIdx } = eligible[i]
    const part = msg.parts[partIdx] as {
      state: { status: string; output: string; [k: string]: unknown }
      [k: string]: unknown
    }
    const original = part.state.output
    before += original.length
    if (original.length <= MAX_BYTES) {
      after += original.length
      continue
    }
    const head = original.slice(0, HEAD_BYTES)
    const tail = original.slice(-TAIL_BYTES)
    const compressed = `${head}\n\n[... ${original.length - HEAD_BYTES - TAIL_BYTES}B trimmed by ctx-plugin (stale tool output) ...]\n\n${tail}`
    const newState = { ...part.state, output: compressed }
    const newPart = { ...part, state: newState }
    msg.parts[partIdx] = newPart
    after += compressed.length
    trimmedCount += 1
  }

  return {
    before,
    after,
    trimmed: trimmedCount,
    superseded: supersededCount,
    supersedeSaved,
    deduped: dedupedCount,
    dedupSaved,
  }
}

export * as MessagesTrim from "./messages-trim"
