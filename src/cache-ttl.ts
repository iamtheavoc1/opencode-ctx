// Upgrade Anthropic prefix-cache TTL from 5m to 1h on the most-recent
// assistant turn when it's safe to do so.
//
// Why this matters
// ----------------
// opencode's provider/transform.ts applies `{ type: "ephemeral" }` at message
// level to the first 2 system messages and the last 2 non-system messages -
// producing 4 Anthropic cache breakpoints per request, each with the default
// 5-minute TTL. Interactive agent sessions routinely see >5m idle gaps
// between turns (user steps away, reviews output, thinks), so the cache
// expires and every turn pays a cache-miss write cost.
//
// Anthropic supports a 1-hour TTL (`{ type: "ephemeral", ttl: "1h" }`) that
// costs 2x base on write vs 1.25x for 5m, but enables cache hits across gaps
// up to 60 minutes. Net-positive for any session with N>=2 turns and a gap
// between 5m and 1h.
//
// Plugin-scope constraints
// ------------------------
// opencode exposes no hook to register an AI SDK `LanguageModelV3Middleware`
// or to mutate message-level providerOptions. The only channel is part-level
// `metadata` on assistant text/reasoning parts - `message-v2.ts#L133, #L213`
// propagates `part.metadata` to UIMessage `providerMetadata`, which
// `convertToModelMessages` maps to part-level `providerOptions` on the
// ModelMessage. Anthropic's provider reads part-level `cacheControl` BEFORE
// falling back to message-level, so a part-level `{ type: "ephemeral",
// ttl: "1h" }` on the LAST part of a breakpoint message wins over
// opencode's message-level `{ type: "ephemeral" }` and upgrades that
// breakpoint's TTL.
//
// Safety: breakpoint-overflow avoidance
// -------------------------------------
// Anthropic caps active cache breakpoints at 4 per request. opencode already
// consumes all 4. If we inject part-level cacheControl on a message that is
// NOT in opencode's "last 2 non-system" window, we create a 5th breakpoint
// and the request fails.
//
// `convertToModelMessages` splits an opencode assistant message containing
// ANY completed tool part into TWO ModelMessages: one assistant (text +
// tool-call) + one tool (tool-result). When the last opencode turn had
// tool use, the ModelMessage layout becomes `[..., assistant, tool, user]`
// and opencode's "last 2 non-system" = `[tool, user]` - the assistant is
// OUT of scope. Injecting on it would overflow breakpoints.
//
// So we only inject when the target assistant message has NO tool parts,
// guaranteeing it maps 1:1 to a ModelMessage that lands in the last-2 window.
// In practice this captures text-only reply turns (the common conversational
// pattern) while safely skipping tool-heavy turns.
//
// Coverage: this upgrades AT MOST 1 of the 4 breakpoints - the most recent
// one, which represents the largest cached prefix and therefore the highest
// per-turn read savings. The other 3 breakpoints (system[0], system[1], and
// the tool/user in the last window) remain at the default 5m TTL; reaching
// them requires an upstream patch to `provider/transform.ts`.
//
// Cache determinism: the injection is a pure function of input. Same
// messages + same TTL produce byte-identical output, so Anthropic's prefix
// cache still hits on subsequent turns.

const TTL_ENABLED = process.env.OPENCODE_CTX_TTL !== "0"
const TTL_VALUE = iifeTtl()

function iifeTtl(): "1h" | "5m" {
  const raw = process.env.OPENCODE_CTX_TTL_VALUE
  if (raw === "5m") return "5m"
  return "1h"
}

type LooseMsg = {
  info?: { role?: string }
  parts: Array<Record<string, unknown>>
}

type Candidate = { msg: LooseMsg; partIdx: number }

function findLastTextOrReasoningPartIdx(parts: Array<Record<string, unknown>>): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i]?.type
    if (t === "text" || t === "reasoning") return i
  }
  return -1
}

function hasCompletedToolPart(msg: LooseMsg): boolean {
  return msg.parts.some((p) => {
    if (p.type !== "tool") return false
    const state = p.state as { status?: string } | undefined
    return state?.status === "completed"
  })
}

function findSafeCandidate(messages: LooseMsg[]): Candidate | undefined {
  if (messages.length < 2) return undefined

  // Prefer the penultimate opencode message (position -2). This is the
  // previous assistant reply; if it has no tool parts, it maps 1:1 to a
  // ModelMessage that lands in opencode's "last 2 non-system" cache window
  // (the latest user message being the other).
  const penultimate = messages[messages.length - 2]
  if (penultimate?.info?.role === "assistant" && !hasCompletedToolPart(penultimate)) {
    const idx = findLastTextOrReasoningPartIdx(penultimate.parts)
    if (idx !== -1) return { msg: penultimate, partIdx: idx }
  }

  // Fall back to the last opencode message (position -1) if it happens to
  // be an assistant turn (rare, usually user-last).
  const last = messages[messages.length - 1]
  if (last?.info?.role === "assistant" && !hasCompletedToolPart(last)) {
    const idx = findLastTextOrReasoningPartIdx(last.parts)
    if (idx !== -1) return { msg: last, partIdx: idx }
  }

  return undefined
}

export function applyCacheTtl(messages: LooseMsg[]): { applied: boolean; ttl: "1h" | "5m" | null } {
  if (!TTL_ENABLED) return { applied: false, ttl: null }
  const candidate = findSafeCandidate(messages)
  if (!candidate) return { applied: false, ttl: null }

  const part = candidate.msg.parts[candidate.partIdx] as Record<string, unknown> & {
    metadata?: Record<string, any>
  }
  const existing = part.metadata ?? {}
  const existingAnthropic = (existing.anthropic ?? {}) as Record<string, any>
  const existingCache = (existingAnthropic.cacheControl ?? {}) as Record<string, any>

  // Merge order: our TTL wins over pre-existing; `type` always "ephemeral"
  // (Anthropic's zod validator requires it as a literal).
  const merged = {
    ...existing,
    anthropic: {
      ...existingAnthropic,
      cacheControl: {
        ...existingCache,
        type: "ephemeral",
        ttl: TTL_VALUE,
      },
    },
  }

  part.metadata = merged
  return { applied: true, ttl: TTL_VALUE }
}

export * as CacheTtl from "./cache-ttl"
