// Round 4: trim stale tool outputs in message history before sending to LLM.
//
// Targets the biggest per-turn context growth: tool outputs from earlier turns
// that accumulate in history and get re-sent every request. Deterministic by
// design - same input produces same output - so Anthropic's prefix cache still
// hits on subsequent turns.
//
// Policy:
//   - Preserve the LAST N tool outputs intact (recent work matters).
//   - Only touch `completed` tool parts; never touch pending/running/error.
//   - Skip tools whose output is typically structured and expected to be
//     referenced later: task, call_omo_agent, patch, todowrite.
//   - For eligible older tool outputs over the threshold, keep HEAD + TAIL
//     bytes and replace the middle with a compact marker.
//
// Cache safety: deterministic. Defensive: replaces `state` with a shallow
// clone instead of in-place property mutation, so the source objects (which
// may be live session references) are left untouched.

const PRESERVE_RECENT = Number(process.env.OPENCODE_CTX_MSGS_KEEP ?? "3")
const MAX_BYTES = Number(process.env.OPENCODE_CTX_MSGS_CAP ?? "600")
const HEAD_BYTES = Number(process.env.OPENCODE_CTX_MSGS_HEAD ?? "300")
const TAIL_BYTES = Number(process.env.OPENCODE_CTX_MSGS_TAIL ?? "150")

const SKIP_TOOLS = new Set(["task", "call_omo_agent", "patch", "todowrite", "question"])

type LooseMsg = {
  info?: { role?: string }
  parts: Array<Record<string, unknown>>
}

export function trimMessageHistory(messages: LooseMsg[]): { before: number; after: number; trimmed: number } {
  const eligible: Array<{ msg: LooseMsg; partIdx: number }> = []

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let p = 0; p < msg.parts.length; p++) {
      const part = msg.parts[p]
      if (part?.type !== "tool") continue
      const toolName = typeof part.tool === "string" ? part.tool : ""
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
    // Shallow-clone state and part to avoid mutating live session refs.
    const newState = { ...part.state, output: compressed }
    const newPart = { ...part, state: newState }
    msg.parts[partIdx] = newPart
    after += compressed.length
    trimmedCount += 1
  }

  return { before, after, trimmed: trimmedCount }
}

export * as MessagesTrim from "./messages-trim"
