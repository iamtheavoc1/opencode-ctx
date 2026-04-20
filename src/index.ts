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
// Kill switches:
//   OPENCODE_CTX_PLUGIN=0             disable the whole plugin
//   OPENCODE_CTX_TRIM=0               skip tool description + system prompt trim
//   OPENCODE_CTX_OMOA=0               skip oh-my-openagent prompt compressor
//   OPENCODE_CTX_COMPACT=0            skip compaction prompt replacement
//   OPENCODE_CTX_MSGS=0               skip message-history tool-output trim
//   OPENCODE_CTX_MSGS_KEEP=N          preserve last N tool outputs (default 5)
//   OPENCODE_CTX_MSGS_CAP=N           byte threshold for trimming (default 1000)
//   OPENCODE_CTX_MSGS_HEAD=N          head bytes kept on trim (default 500)
//   OPENCODE_CTX_MSGS_TAIL=N          tail bytes kept on trim (default 250)
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

const DISABLED = process.env.OPENCODE_CTX_PLUGIN === "0"
const TRIM_ENABLED = process.env.OPENCODE_CTX_TRIM !== "0"
const OMOA_ENABLED = process.env.OPENCODE_CTX_OMOA !== "0"
const COMPACT_ENABLED = process.env.OPENCODE_CTX_COMPACT !== "0"
const MSGS_ENABLED = process.env.OPENCODE_CTX_MSGS !== "0"
const CAVEMAN_LEVEL = parseCavemanLevel(process.env.OPENCODE_CTX_CAVEMAN)
const DEBUG = process.env.OPENCODE_CTX_DEBUG === "1"

const log = (msg: string) => DEBUG && process.stderr.write(`[ctx-plugin] ${msg}\n`)

export const ContextPlugin: Plugin = async () => {
  if (DISABLED) {
    log("disabled via OPENCODE_CTX_PLUGIN=0")
    return {}
  }

  log(
    `active: trim=${TRIM_ENABLED ? "on" : "off"} omoa=${OMOA_ENABLED ? "on" : "off"} compact=${
      COMPACT_ENABLED ? "on" : "off"
    } msgs=${MSGS_ENABLED ? "on" : "off"} caveman=${CAVEMAN_LEVEL ?? "off"} overrides=${
      Object.keys(TOOL_DESCRIPTION_OVERRIDES).length
    }`,
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

  if (MSGS_ENABLED) {
    hooks["experimental.chat.messages.transform"] = async (_input, output) => {
      if (!output.messages || output.messages.length === 0) return
      const result = trimMessageHistory(output.messages as unknown as Parameters<typeof trimMessageHistory>[0])
      if (result.trimmed > 0) {
        log(`messages.transform: ${result.before}B -> ${result.after}B across ${result.trimmed} old tool outputs`)
      }
    }
  }

  return hooks
}

export default ContextPlugin
