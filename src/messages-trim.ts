// Trim stale tool outputs in message history before sending to LLM.
//
// Targets the biggest per-turn context growth: tool outputs from earlier turns
// that accumulate in history and get re-sent every request. Deterministic by
// design - same input produces same output - so Anthropic's prefix cache still
// hits on subsequent turns.
//
// Two passes applied in order:
//
// 1. Superseded-read collapse (Round 8, lossless):
//    - A `read` of file X is superseded when a later `read` of X exists
//      (newer snapshot available) OR a later `write` of X exists (file was
//      fully replaced). In both cases the old read's output is definitionally
//      stale. Replaced with a compact `[superseded ...]` marker.
//    - Edit-supersedes-Read is intentionally NOT applied: edits are partial,
//      old read output is still valid for unaffected regions.
//    - Always keeps the MOST RECENT read per file (even if later overwritten
//      - the path's current state lives in the write's args, but the last
//      read remains the only snapshot of file structure).
//
// 2. Size-based trim (Round 4):
//    - Preserve the LAST N tool outputs intact (recent work matters).
//    - Only touch `completed` tool parts; never touch pending/running/error.
//    - Skip tools whose output is typically structured and expected to be
//      referenced later: task, call_omo_agent, patch, todowrite, question.
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

const SKIP_TOOLS = new Set(["task", "call_omo_agent", "patch", "todowrite", "question"])
const WRITE_TOOLS = new Set(["write"])

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

export function trimMessageHistory(messages: LooseMsg[]): {
  before: number
  after: number
  trimmed: number
  superseded: number
  supersedeSaved: number
} {
  let supersededCount = 0
  let supersedeSaved = 0
  if (SUPERSEDE_ENABLED) {
    const r = collapseSupersededReads(messages)
    supersededCount = r.collapsed
    supersedeSaved = r.saved
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

  return { before, after, trimmed: trimmedCount, superseded: supersededCount, supersedeSaved }
}

export * as MessagesTrim from "./messages-trim"
