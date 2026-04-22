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

type LoosePart = Record<string, unknown>
type LooseMsg = {
  info?: { role?: string }
  parts: LoosePart[]
}

type PartRef = { msg: LooseMsg; partIdx: number; order: number }

type ToolState = {
  status?: string
  output?: string
  input?: unknown
}

type ToolPart = LoosePart & {
  state?: ToolState
}

function getToolName(part: LoosePart): string {
  return typeof part.tool === "string" ? part.tool : ""
}

function getFilePath(part: LoosePart): string | undefined {
  const state = part.state as { input?: { filePath?: unknown } } | undefined
  const filePath = state?.input?.filePath
  if (typeof filePath === "string") return filePath
  return undefined
}

function replaceToolOutput(msg: LooseMsg, partIdx: number, marker: string): number {
  const part = msg.parts[partIdx] as ToolPart
  const state = part.state
  const output = typeof state?.output === "string" ? state.output : ""
  const nextState = { ...state, output: marker }
  msg.parts[partIdx] = { ...part, state: nextState }
  return output.length - marker.length
}

function collapseSupersededReads(messages: LooseMsg[]): { saved: number; collapsed: number } {
  const readsByPath = new Map<string, PartRef[]>()
  const firstWriteByPath = new Map<string, number>()
  let order = 0

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let partIdx = 0; partIdx < msg.parts.length; partIdx += 1) {
      const part = msg.parts[partIdx]
      if (part?.type !== "tool") continue
      const tool = getToolName(part)
      const state = (part as ToolPart).state
      if (state?.status !== "completed") {
        order += 1
        continue
      }
      const filePath = getFilePath(part)
      if (!filePath) {
        order += 1
        continue
      }
      if (tool === "read" && typeof state.output === "string") {
        if (!state.output.startsWith("[ctx-plugin:")) {
          const refs = readsByPath.get(filePath) ?? []
          refs.push({ msg, partIdx, order })
          readsByPath.set(filePath, refs)
        }
      }
      if (WRITE_TOOLS.has(tool) && !firstWriteByPath.has(filePath)) firstWriteByPath.set(filePath, order)
      order += 1
    }
  }

  let saved = 0
  let collapsed = 0

  for (const [filePath, refs] of readsByPath) {
    if (refs.length === 0) continue
    const writeOrder = firstWriteByPath.get(filePath)
    const lastReadOrder = refs[refs.length - 1].order
    for (const ref of refs) {
      const supersededByWrite = writeOrder !== undefined && ref.order < writeOrder
      const supersededByRead = ref.order < lastReadOrder
      if (!supersededByWrite && !supersededByRead) continue
      const reason = supersededByWrite ? "write" : "later read"
      const marker = `[ctx-plugin: read of ${filePath} superseded by ${reason} in a later turn]`
      saved += replaceToolOutput(ref.msg, ref.partIdx, marker)
      collapsed += 1
    }
  }

  return { saved, collapsed }
}

function getArgsJson(part: LoosePart): string | undefined {
  const state = (part as ToolPart).state
  if (!state || state.input === undefined) return undefined
  return JSON.stringify(state.input)
}

function collapseDuplicateCalls(messages: LooseMsg[]): { saved: number; collapsed: number } {
  const byKey = new Map<string, PartRef[]>()
  let order = 0

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let partIdx = 0; partIdx < msg.parts.length; partIdx += 1) {
      const part = msg.parts[partIdx]
      if (part?.type !== "tool") continue
      const tool = getToolName(part)
      if (DEDUP_SKIP_TOOLS.has(tool)) {
        order += 1
        continue
      }
      const state = (part as ToolPart).state
      if (state?.status !== "completed") {
        order += 1
        continue
      }
      if (typeof state.output !== "string") {
        order += 1
        continue
      }
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
      const refs = byKey.get(key) ?? []
      refs.push({ msg, partIdx, order })
      byKey.set(key, refs)
      order += 1
    }
  }

  let saved = 0
  let collapsed = 0

  for (const refs of byKey.values()) {
    if (refs.length < 2) continue
    const latest = refs[refs.length - 1]
    for (const ref of refs) {
      if (ref.order === latest.order) continue
      const marker = `[ctx-plugin: identical tool output produced again at turn order ${latest.order}]`
      saved += replaceToolOutput(ref.msg, ref.partIdx, marker)
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
    const result = collapseSupersededReads(messages)
    supersededCount = result.collapsed
    supersedeSaved = result.saved
  }

  let dedupedCount = 0
  let dedupSaved = 0
  if (DEDUP_ENABLED) {
    const result = collapseDuplicateCalls(messages)
    dedupedCount = result.collapsed
    dedupSaved = result.saved
  }

  const eligible: Array<{ msg: LooseMsg; partIdx: number }> = []

  for (const msg of messages) {
    if (!msg?.parts) continue
    for (let partIdx = 0; partIdx < msg.parts.length; partIdx += 1) {
      const part = msg.parts[partIdx]
      if (part?.type !== "tool") continue
      const toolName = getToolName(part)
      if (SKIP_TOOLS.has(toolName)) continue
      const state = (part as ToolPart).state
      if (state?.status !== "completed") continue
      if (typeof state.output !== "string") continue
      eligible.push({ msg, partIdx })
    }
  }

  const cutoff = Math.max(0, eligible.length - PRESERVE_RECENT)
  let before = 0
  let after = 0
  let trimmedCount = 0

  for (let index = 0; index < cutoff; index += 1) {
    const { msg, partIdx } = eligible[index]
    const part = msg.parts[partIdx] as ToolPart
    const state = part.state
    const original = typeof state?.output === "string" ? state.output : ""
    before += original.length
    if (original.length <= MAX_BYTES) {
      after += original.length
      continue
    }
    const head = original.slice(0, HEAD_BYTES)
    const tail = original.slice(-TAIL_BYTES)
    const compressed = `${head}

[... ${original.length - HEAD_BYTES - TAIL_BYTES}B trimmed by ctx-plugin (stale tool output) ...]

${tail}`
    const nextState = { ...state, output: compressed }
    msg.parts[partIdx] = { ...part, state: nextState }
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
