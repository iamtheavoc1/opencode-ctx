// opencode-context-plugin: reduces per-turn Anthropic token usage by
// compressing the fixed overhead that ships with every request.
//
// Three independent interventions, each with its own kill switch:
//
//   1. tool.definition        - compresses built-in + oh-my-openagent tool
//                               descriptions (bash, todowrite, task,
//                               multiedit, read, write, edit, grep, glob,
//                               webfetch, websearch, lsp, codesearch,
//                               session_*, call_omo_agent, look_at,
//                               ast_grep_search, question). 21 overrides
//                               total; saves ~13KB on fresh requests.
//
//   2. experimental.chat.
//      system.transform       - replaces the provider system prompt's verbose
//                               tutorial examples with a compact equivalent
//                               while preserving every behavioral rule.
//
//   3. experimental.session.
//      compacting             - supplies a denser compaction prompt that
//                               produces structured, signal-rich summaries
//                               instead of narrative retellings.
//
//   4. experimental.chat.
//      messages.transform     - trims stale tool outputs from accumulated
//                               message history (file reads, bash dumps,
//                               webfetch pages). Preserves the last N tool
//                               calls intact. Only targets per-turn GROWTH;
//                               fresh sessions see no change.
//
//   5. tool.execute.after      - losslessly cleans every tool output at
//                               write time: strips ANSI escapes, progress-bar
//                               carriage returns, trailing whitespace, and
//                               excessive blank-line runs. Fires BEFORE the
//                               result persists in the transcript, so savings
//                               compound on every turn thereafter. Applied
//                               only to tools with free-form text output;
//                               structured tools (task, todowrite, question,
//                               call_omo_agent, skill, patch) are skipped.
//
//   6. cache-ttl (layered on the same messages.transform hook as #4) upgrades
//      the most-recent assistant-turn Anthropic cache breakpoint from the
//      default 5m TTL to 1h by injecting part-level providerMetadata. Safe
//      under the 4-breakpoint limit: skips assistant messages containing
//      completed tool parts (those would map to a split ModelMessage pair
//      outside the last-2 cache window). Upgrades 1 of 4 breakpoints - the
//      largest cached prefix, highest-ROI one. See src/cache-ttl.ts for the
//      full safety analysis.
//
// Kill switches:
//   OPENCODE_CTX_PLUGIN=0             disable the whole plugin
//   OPENCODE_CTX_TRIM=0               skip tool description + system prompt trim
//   OPENCODE_CTX_OMOA=0               skip oh-my-openagent prompt compressor
//   OPENCODE_CTX_COMPACT=0            skip compaction prompt replacement
//   OPENCODE_CTX_MSGS=0               skip message-history tool-output trim
//   OPENCODE_CTX_MSGS_KEEP=N          preserve last N tool outputs (default 3)
//   OPENCODE_CTX_MSGS_CAP=N           byte threshold for trimming (default 600)
//   OPENCODE_CTX_MSGS_HEAD=N          head bytes kept on trim (default 300)
//   OPENCODE_CTX_MSGS_TAIL=N          tail bytes kept on trim (default 150)
//   OPENCODE_CTX_SUPERSEDE=0          skip superseded-read collapse pass
//   OPENCODE_CTX_DEDUP=0              skip duplicate tool-call collapse
//   OPENCODE_CTX_DEDUP_MIN=N          min output bytes to consider for dedup (default 200)
//   OPENCODE_CTX_CLEAN=0              skip tool-output ANSI/progress-bar clean
//   OPENCODE_CTX_TTL=0                skip Anthropic cache TTL upgrade
//   OPENCODE_CTX_TTL_VALUE=1h|5m      TTL target (default 1h)
//   OPENCODE_CTX_CAVEMAN=lite|full|ultra
//                                     opt-in caveman output style (default off)
//   OPENCODE_CTX_DEBUG=1              log decisions to stderr
//   OPENCODE_CTX_DUMP=<path>          dump system[0] to file on first fire
//
// Cache determinism: every transform here is a pure function of its input.
// The Anthropic prefix cache (applied by opencode's provider/transform.ts)
// relies on the system[] and tools[] arrays being byte-identical across
// turns; our transforms preserve that invariant. First post-install turn is
// a cache miss (expected); subsequent turns hit the new, smaller cache.
//
// Style: follows opencode AGENTS.md conventions - no try/catch, no else,
// const over let, Bun APIs where applicable, early returns, avoid `any`
// except where hook signatures force it.

import type { Plugin } from "@opencode-ai/plugin"
import { TOOL_DESCRIPTION_OVERRIDES } from "./tool-overrides"
import { compressSystem } from "./system-trim"
import { compressOmoa } from "./omoa-trim"
import { buildCavemanPrompt, parseCavemanLevel } from "./caveman-prompt"
import { CUSTOM_COMPACTION_PROMPT } from "./compaction-prompt"
import { trimMessageHistory } from "./messages-trim"
import { cleanToolOutput } from "./tool-output-clean"
import { applyCacheTtl } from "./cache-ttl"

const DISABLED = process.env.OPENCODE_CTX_PLUGIN === "0"
const TRIM_ENABLED = process.env.OPENCODE_CTX_TRIM !== "0"
const OMOA_ENABLED = process.env.OPENCODE_CTX_OMOA !== "0"
const COMPACT_ENABLED = process.env.OPENCODE_CTX_COMPACT !== "0"
const MSGS_ENABLED = process.env.OPENCODE_CTX_MSGS !== "0"
const CLEAN_ENABLED = process.env.OPENCODE_CTX_CLEAN !== "0"
const TTL_ENABLED = process.env.OPENCODE_CTX_TTL !== "0"
const CAVEMAN_LEVEL = parseCavemanLevel(process.env.OPENCODE_CTX_CAVEMAN)
const DEBUG = process.env.OPENCODE_CTX_DEBUG === "1"

const CLEAN_SKIP_TOOLS = new Set([
  "task",
  "todowrite",
  "question",
  "call_omo_agent",
  "skill",
  "patch",
])

const log = (msg: string) => DEBUG && process.stderr.write(`[ctx-plugin] ${msg}\n`)

export const ContextPlugin: Plugin = async () => {
  if (DISABLED) {
    log("disabled via OPENCODE_CTX_PLUGIN=0")
    return {}
  }

  log(
    `active: trim=${TRIM_ENABLED ? "on" : "off"} omoa=${OMOA_ENABLED ? "on" : "off"} compact=${
      COMPACT_ENABLED ? "on" : "off"
    } msgs=${MSGS_ENABLED ? "on" : "off"} clean=${CLEAN_ENABLED ? "on" : "off"} ttl=${
      TTL_ENABLED ? "on" : "off"
    } caveman=${CAVEMAN_LEVEL ?? "off"} overrides=${Object.keys(TOOL_DESCRIPTION_OVERRIDES).length}`,
  )

  const hooks: ReturnType<Plugin> extends Promise<infer H> ? H : never = {}

  if (TRIM_ENABLED) {
    hooks["tool.definition"] = async (input, output) => {
      const replacement = TOOL_DESCRIPTION_OVERRIDES[input.toolID]
      if (!replacement) {
        log(`tool.definition ${input.toolID}: NO_MATCH len=${output.description?.length ?? 0}`)
        return
      }
      const before = output.description?.length ?? 0
      output.description = replacement
      log(`tool.definition ${input.toolID}: ${before}B -> ${replacement.length}B`)
    }

    hooks["experimental.chat.system.transform"] = async (_input, output) => {
      if (!output.system || output.system.length === 0) {
        log(`system.transform fired: system empty/undefined`)
        return
      }
      const before = output.system[0]?.length ?? 0
      const head = (output.system[0] ?? "").slice(0, 80).replace(/\n/g, "\\n")
      log(`system.transform fired: len=${output.system.length} [0]=${before}B head="${head}"`)
      if (process.env.OPENCODE_CTX_DUMP && output.system[0] && output.system[0].length > 10000) {
        const dumpPath = process.env.OPENCODE_CTX_DUMP
        await Bun.write(dumpPath, output.system[0])
        log(`system.transform DUMPED ${before}B to ${dumpPath}`)
      }
      if (OMOA_ENABLED) {
        const omoaResult = compressOmoa(output.system)
        if (omoaResult.before !== omoaResult.after) {
          log(`system.transform omoa: ${omoaResult.before}B -> ${omoaResult.after}B`)
        }
      }
      compressSystem(output.system)
      const after = output.system[0]?.length ?? 0
      if (before !== after && OMOA_ENABLED === false) log(`system.transform anthropic: ${before}B -> ${after}B`)
      if (CAVEMAN_LEVEL && before > 10000) {
        output.system.push(buildCavemanPrompt(CAVEMAN_LEVEL))
        log(`system.transform caveman: appended level=${CAVEMAN_LEVEL}`)
      }
    }
  }

  if (COMPACT_ENABLED) {
    hooks["experimental.session.compacting"] = async (input, output) => {
      output.prompt = CUSTOM_COMPACTION_PROMPT
      log(`session.compacting sessionID=${input.sessionID}: custom prompt applied`)
    }
  }

  if (MSGS_ENABLED || TTL_ENABLED) {
    hooks["experimental.chat.messages.transform"] = async (_input, output) => {
      if (!output.messages || output.messages.length === 0) return
      if (MSGS_ENABLED) {
        const result = trimMessageHistory(output.messages as unknown as Parameters<typeof trimMessageHistory>[0])
        if (result.superseded > 0) {
          log(`messages.transform: collapsed ${result.superseded} superseded reads, saved ${result.supersedeSaved}B`)
        }
        if (result.deduped > 0) {
          log(`messages.transform: deduped ${result.deduped} identical tool outputs, saved ${result.dedupSaved}B`)
        }
        if (result.trimmed > 0) {
          log(`messages.transform: ${result.before}B -> ${result.after}B across ${result.trimmed} old tool outputs`)
        }
      }
      if (TTL_ENABLED) {
        const ttlResult = applyCacheTtl(output.messages as unknown as Parameters<typeof applyCacheTtl>[0])
        if (ttlResult.applied) {
          log(`messages.transform ttl: upgraded last-assistant breakpoint to ${ttlResult.ttl}`)
        }
      }
    }
  }

  if (CLEAN_ENABLED) {
    hooks["tool.execute.after"] = async (input, output) => {
      if (CLEAN_SKIP_TOOLS.has(input.tool)) return
      const anyOut = output as unknown as {
        output?: unknown
        content?: Array<{ type?: string; text?: string }>
      }
      if (typeof anyOut.output === "string") {
        const before = anyOut.output.length
        const cleaned = cleanToolOutput(anyOut.output)
        if (cleaned.length !== before) {
          anyOut.output = cleaned
          log(`tool.execute.after ${input.tool}: ${before}B -> ${cleaned.length}B`)
        }
        return
      }
      if (Array.isArray(anyOut.content)) {
        let before = 0
        let after = 0
        for (const item of anyOut.content) {
          if (item?.type !== "text" || typeof item.text !== "string") continue
          const cleaned = cleanToolOutput(item.text)
          before += item.text.length
          after += cleaned.length
          if (cleaned.length !== item.text.length) item.text = cleaned
        }
        if (after !== before) log(`tool.execute.after ${input.tool} (mcp): ${before}B -> ${after}B`)
      }
    }
  }

  return hooks
}

export default ContextPlugin
