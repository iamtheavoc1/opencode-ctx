function cfg() {
  return {
    preserveRecent: Number(process.env.OPENCODE_CTX_MSGS_KEEP ?? "3"),
    maxBytes: Number(process.env.OPENCODE_CTX_MSGS_CAP ?? "600"),
    headBytes: Number(process.env.OPENCODE_CTX_MSGS_HEAD ?? "300"),
    tailBytes: Number(process.env.OPENCODE_CTX_MSGS_TAIL ?? "150"),
    supersedeEnabled: process.env.OPENCODE_CTX_SUPERSEDE !== "0",
    dedupEnabled: process.env.OPENCODE_CTX_DEDUP !== "0",
    dedupMinBytes: Number(process.env.OPENCODE_CTX_DEDUP_MIN ?? "200"),
    retrieveEnabled: process.env.OPENCODE_CTX_RETRIEVE === "1",
    retrieveKeep: Number(process.env.OPENCODE_CTX_RETRIEVE_KEEP ?? "3"),
    retrieveQueryTurns: Number(process.env.OPENCODE_CTX_RETRIEVE_QUERY_TURNS ?? "2"),
    retrieveSnippetLines: Number(process.env.OPENCODE_CTX_RETRIEVE_SNIPPET_LINES ?? "2"),
    retrieveSnippetChars: Number(process.env.OPENCODE_CTX_RETRIEVE_SNIPPET_CHARS ?? "240"),
    retrieveVisible: process.env.OPENCODE_CTX_RETRIEVE_VISIBLE === "1",
    retrieveVisibleChars: Number(process.env.OPENCODE_CTX_RETRIEVE_VISIBLE_CHARS ?? "180"),
  }
}

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

type EligibleRef = { msg: LooseMsg; partIdx: number; index: number }

const STOP_WORDS = new Set([
  "the",
  "and",
  "that",
  "with",
  "from",
  "this",
  "have",
  "your",
  "just",
  "into",
  "what",
  "when",
  "where",
  "which",
  "then",
  "than",
  "they",
  "them",
  "will",
  "would",
  "could",
  "should",
  "about",
  "after",
  "before",
  "using",
  "like",
  "need",
  "want",
  "make",
  "made",
  "also",
  "only",
  "been",
  "does",
  "dont",
  "cant",
  "through",
  "there",
])

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

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
    return
  }
  if (!value || typeof value !== "object") return
  for (const item of Object.values(value)) collectStrings(item, out)
}

function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? []
  const expanded = new Set<string>()

  for (const token of raw) {
    if (!STOP_WORDS.has(token)) expanded.add(token)
    for (const part of token.split(/[\/._:-]+/g)) {
      if (part.length < 3) continue
      if (STOP_WORDS.has(part)) continue
      expanded.add(part)
    }
  }

  return [...expanded]
}

function tokenizeRaw(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? []).filter((token) => !STOP_WORDS.has(token))
}

function extractRecentContext(messages: LooseMsg[], retrieveQueryTurns: number) {
  const tokens = new Set<string>()
  const filePaths = new Set<string>()
  const queryFilePaths = new Set<string>()
  let turnsSeen = 0

  for (let msgIdx = messages.length - 1; msgIdx >= 0 && turnsSeen < retrieveQueryTurns; msgIdx -= 1) {
    const msg = messages[msgIdx]
    if (!msg?.parts?.length) continue
    turnsSeen += 1
    for (const part of msg.parts) {
      if (!part || typeof part !== "object") continue
      if (part.type === "tool") {
        const filePath = getFilePath(part)
        if (filePath) filePaths.add(filePath)
        continue
      }
      const strings: string[] = []
      collectStrings(part, strings)
      for (const value of strings) {
        for (const token of tokenize(value)) tokens.add(token)
        const pathMatches = value.match(/(?:\.?\.?\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g) ?? []
        for (const match of pathMatches) {
          filePaths.add(match)
          queryFilePaths.add(match)
        }
      }
    }
  }

  return { tokens, filePaths, queryFilePaths }
}

function getOutput(part: ToolPart): string {
  return typeof part.state?.output === "string" ? part.state.output : ""
}

function scoreEligible(ref: EligibleRef, context: ReturnType<typeof extractRecentContext>): number {
  const part = ref.msg.parts[ref.partIdx] as ToolPart
  const toolName = getToolName(part)
  const output = getOutput(part)
  const inputStrings: string[] = []
  collectStrings(part.state?.input, inputStrings)
  let score = 0

  const filePath = getFilePath(part)

  const outputTokens = tokenize(`${toolName} ${filePath ?? ""} ${inputStrings.join(" ")} ${output}`)
  let overlap = 0
  for (const token of outputTokens) {
    if (!context.tokens.has(token)) continue
    overlap += 1
    if (overlap >= 12) break
  }
  score += overlap * 5

  return score
}

function chooseProtectedIndices(
  messages: LooseMsg[],
  eligible: EligibleRef[],
  cutoff: number,
  options: ReturnType<typeof cfg>,
): Set<number> {
  if (!options.retrieveEnabled) return new Set()
  if (options.retrieveKeep <= 0) return new Set()
  if (cutoff <= 0) return new Set()

  const context = extractRecentContext(messages, options.retrieveQueryTurns)
  if (
    context.tokens.size === 0 &&
    context.filePaths.size === 0 &&
    context.queryFilePaths.size === 0
  ) {
    return new Set()
  }

  const pool = eligible.slice(0, cutoff)
  const exactQueryFileMatches = pool.filter((ref) => {
    const part = ref.msg.parts[ref.partIdx] as ToolPart
    const filePath = getFilePath(part)
    return Boolean(filePath && context.queryFilePaths.has(filePath))
  })

  const scored = (exactQueryFileMatches.length > 0 ? exactQueryFileMatches : pool)
    .map((ref) => ({ index: ref.index, score: scoreEligible(ref, context) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, options.retrieveKeep)

  return new Set(scored.map((item) => item.index))
}

function summarizeOutput(output: string, maxChars: number): string {
  const compact = output.replace(/\s+/g, " ").trim()
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, maxChars)}…`
}

function scoreLine(line: string, contextTokens: Set<string>, globalFreq: Map<string, number>): number {
  const tokens = tokenize(line)
  const rawTokens = tokenizeRaw(line)
  if (tokens.length === 0) return 0
  const uniqueTokens = [...new Set(tokens)]
  let score = 0
  for (const token of uniqueTokens) {
    if (contextTokens.has(token)) score += 20
    score += 10 / Math.max(1, globalFreq.get(token) ?? 1)
  }
  const repetitionRatio = rawTokens.length > 0 ? 1 - new Set(rawTokens).size / rawTokens.length : 0
  score -= repetitionRatio * 25
  if (/[A-Z]{2,}|\d/.test(line)) score += 8
  if (line.length < 120) score += 2
  return score
}

function buildRetrievedSnippet(
  output: string,
  contextTokens: Set<string>,
  maxLines: number,
  maxChars: number,
): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return summarizeOutput(output, maxChars)

  const globalFreq = new Map<string, number>()
  for (const line of lines) {
    for (const token of tokenize(line)) {
      globalFreq.set(token, (globalFreq.get(token) ?? 0) + 1)
    }
  }

  const scored = lines
    .map((line, index) => ({ line, index, score: scoreLine(line, contextTokens, globalFreq) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const top = scored.slice(0, Math.max(1, maxLines))

  const pickedIndexes: number[] = []
  const seenIndexes = new Set<number>()
  for (const item of top) {
    if (!seenIndexes.has(item.index)) {
      seenIndexes.add(item.index)
      pickedIndexes.push(item.index)
    }
  }
  for (const item of top) {
    if (pickedIndexes.length >= maxLines) break
    if (item.index + 1 < lines.length && !seenIndexes.has(item.index + 1)) {
      seenIndexes.add(item.index + 1)
      pickedIndexes.push(item.index + 1)
    }
    if (pickedIndexes.length >= maxLines) break
    if (item.index > 0 && !seenIndexes.has(item.index - 1)) {
      seenIndexes.add(item.index - 1)
      pickedIndexes.push(item.index - 1)
    }
  }

  const picked = pickedIndexes.slice(0, maxLines).map((index) => lines[index])

  const chosen = picked.length > 0 ? picked : lines.slice(0, maxLines)
  return summarizeOutput(chosen.join(" | "), maxChars)
}

function replaceRetrievedOutputsWithSnippets(
  eligible: EligibleRef[],
  protectedIndices: Set<number>,
  contextTokens: Set<string>,
  maxLines: number,
  maxChars: number,
  visible: boolean,
  visibleChars: number,
): { replaced: number; before: number; after: number; visibleInjected: number } {
  let replaced = 0
  let before = 0
  let after = 0
  let visibleInjected = 0

  for (let index = 0; index < eligible.length; index += 1) {
    if (!protectedIndices.has(index)) continue
    const { msg, partIdx } = eligible[index]
    const part = msg.parts[partIdx] as ToolPart
    const state = part.state
    const output = getOutput(part)
    if (!output) continue
    if (output.startsWith("[ctx-plugin:retrieved:") || output.startsWith("[ctx-plugin retrieved")) continue

    const toolName = getToolName(part) || "tool"
    const filePath = getFilePath(part)
    const label = filePath ? `${toolName} ${filePath}` : toolName
    const snippet = buildRetrievedSnippet(output, contextTokens, maxLines, maxChars)
    const prefix = visible
      ? `[ctx-plugin retrieved memory]\nSource: ${label}\nSummary: ${summarizeOutput(output, visibleChars)}\nRelevant snippet: ${snippet}`
      : `[ctx-plugin:retrieved:v1]\n${snippet}`
    const nextOutput = prefix

    msg.parts[partIdx] = {
      ...part,
      state: {
        ...state,
        output: nextOutput,
      },
    }

    before += output.length
    after += nextOutput.length
    replaced += 1
    if (visible) visibleInjected += 1
  }

  return { replaced, before, after, visibleInjected }
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
      // FIX: Only supersede reads if there's a subsequent WRITE to the same file.
      // A later read of the same file does NOT mean the content changed - the agent
      // may be intentionally re-reading for context. Superseding those wastes tokens
      // and causes the agent to re-read the file repeatedly in later turns.
      const supersededByRead = false  // was: ref.order < lastReadOrder
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

function collapseDuplicateCalls(messages: LooseMsg[], dedupMinBytes: number): { saved: number; collapsed: number } {
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
      if (state.output.length < dedupMinBytes) {
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
  retrieved: number
  retrieveVisibleInjected: number
} {
  const options = cfg()
  let supersededCount = 0
  let supersedeSaved = 0
  if (options.supersedeEnabled) {
    const result = collapseSupersededReads(messages)
    supersededCount = result.collapsed
    supersedeSaved = result.saved
  }

  let dedupedCount = 0
  let dedupSaved = 0
  if (options.dedupEnabled) {
    const result = collapseDuplicateCalls(messages, options.dedupMinBytes)
    dedupedCount = result.collapsed
    dedupSaved = result.saved
  }

  const eligible: EligibleRef[] = []

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
      eligible.push({ msg, partIdx, index: eligible.length })
    }
  }

  const cutoff = Math.max(0, eligible.length - options.preserveRecent)
  const context = extractRecentContext(messages, options.retrieveQueryTurns)
  const protectedIndices = chooseProtectedIndices(messages, eligible, cutoff, options)
  let before = 0
  let after = 0
  let trimmedCount = 0

  for (let index = 0; index < cutoff; index += 1) {
    if (protectedIndices.has(index)) continue
    const { msg, partIdx } = eligible[index]
    const part = msg.parts[partIdx] as ToolPart
    const state = part.state
    const original = typeof state?.output === "string" ? state.output : ""
    before += original.length
    if (original.length <= options.maxBytes) {
      after += original.length
      continue
    }
    const head = original.slice(0, options.headBytes)
    const tail = original.slice(-options.tailBytes)
    const compressed = `${head}

[... ${original.length - options.headBytes - options.tailBytes}B trimmed by ctx-plugin (stale tool output) ...]

${tail}`
    const nextState = { ...state, output: compressed }
    msg.parts[partIdx] = { ...part, state: nextState }
    after += compressed.length
    trimmedCount += 1
  }

  let retrieveVisibleInjected = 0
  if (protectedIndices.size > 0) {
    const retrieved = replaceRetrievedOutputsWithSnippets(
      eligible,
      protectedIndices,
      context.tokens,
      options.retrieveSnippetLines,
      options.retrieveSnippetChars,
      options.retrieveVisible,
      options.retrieveVisibleChars,
    )
    before += retrieved.before
    after += retrieved.after
    retrieveVisibleInjected = retrieved.visibleInjected
  }

  return {
    before,
    after,
    trimmed: trimmedCount,
    superseded: supersededCount,
    supersedeSaved,
    deduped: dedupedCount,
    dedupSaved,
    retrieved: protectedIndices.size,
    retrieveVisibleInjected,
  }
}

export * as MessagesTrim from "./messages-trim"
