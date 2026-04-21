# opencode-ctx

Aggressive context compression plugin for [opencode](https://opencode.ai). Cuts per-request Anthropic token usage by roughly **40% on fresh sessions and ~50-55% deep into long sessions** while preserving every behavioral rule and Anthropic's prefix cache.

## What it does

Seven independent, cache-deterministic transforms. Every transform is a pure function of its input, so Anthropic's prefix cache still hits on subsequent turns.

| Hook | Target | Typical saving |
|---|---|---|
| `tool.definition` | Compresses 22 opencode + oh-my-openagent tool descriptions | ~13KB per request |
| `experimental.chat.system.transform` | Replaces opencode's `anthropic.txt` and oh-my-openagent's Sisyphus prompt with equivalent compressed versions; dedupes the env/skills tail | ~14KB per request |
| `experimental.chat.messages.transform` (trim) | Three passes: (a) lossless superseded-read collapse — replaces reads of files that were later re-read or overwritten; (b) lossless duplicate-call dedup — collapses older identical (tool, args, output) triples to a pointer; (c) size-based trim of remaining stale tool outputs; preserves the last N intact | scales with session length, ~13K+ tokens/turn on long sessions |
| `experimental.chat.messages.transform` (cache-ttl) | Upgrades the most-recent assistant-turn Anthropic cache breakpoint from the default 5m TTL to 1h by injecting part-level providerMetadata. Safe under the 4-breakpoint cap (skips tool-call assistant turns that map to split ModelMessages). Covers 1 of 4 breakpoints — the largest cached prefix | survives 5m–1h idle gaps between turns; +0.75x write cost, 10x read savings across the gap |
| `tool.execute.after` | Lossless strip of ANSI escapes, progress-bar carriage returns, trailing whitespace, and blank-line runs from every tool output before it persists in the transcript | -30% avg on noisy outputs, -70%+ on progress-bar heavy commands; compounds every turn |
| `experimental.session.compacting` | Supplies a denser compaction prompt for signal-rich summaries | on compaction events |
| Caveman output mode (opt-in) | Optional system prompt append that constrains model output style | -62% on output tokens |

## Measured savings

Measured with `opencode run --format json "hi"` against a fresh session in the same directory, same model.

| Config | Total tokens | Δ vs baseline |
|---|---:|---:|
| Baseline (plugin off) | 36,580 | — |
| With plugin (fresh session) | **21,782** | **-40.5%** |
| With plugin (typical long-session turn) | ~37K (was ~76K) | **~-52%** |

Cache determinism verified: `cache.write: 0, cache.read: 21,769` on replay. 100% cache hit across turns.

## Install

```bash
cd ~/.local/share
git clone https://github.com/iamtheavoc1/opencode-ctx.git
cd opencode-ctx
bun install
```

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "file:///Users/YOU/.local/share/opencode-ctx/src/index.ts"
  ]
}
```

Restart opencode. Verify with `OPENCODE_CTX_DEBUG=1 opencode run "hi"` — you should see `[ctx-plugin] active: ...` on stderr.

## Kill switches

All env-var toggles. Default is plugin on, caveman off.

| Var | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_PLUGIN=0` | on | Disable the whole plugin |
| `OPENCODE_CTX_TRIM=0` | on | Skip tool description + system prompt trim |
| `OPENCODE_CTX_OMOA=0` | on | Skip oh-my-openagent prompt compressor |
| `OPENCODE_CTX_COMPACT=0` | on | Skip compaction prompt replacement |
| `OPENCODE_CTX_MSGS=0` | on | Skip message-history tool-output trim |
| `OPENCODE_CTX_MSGS_KEEP=N` | 3 | Preserve last N tool outputs intact |
| `OPENCODE_CTX_MSGS_CAP=N` | 600 | Byte threshold before trimming kicks in |
| `OPENCODE_CTX_MSGS_HEAD=N` | 300 | Head bytes kept when trimming |
| `OPENCODE_CTX_MSGS_TAIL=N` | 150 | Tail bytes kept when trimming |
| `OPENCODE_CTX_SUPERSEDE=0` | on | Skip lossless superseded-read collapse |
| `OPENCODE_CTX_DEDUP=0` | on | Skip lossless duplicate tool-call dedup |
| `OPENCODE_CTX_DEDUP_MIN=N` | 200 | Min output bytes to consider for dedup |
| `OPENCODE_CTX_CLEAN=0` | on | Skip lossless tool-output cleaner |
| `OPENCODE_CTX_TTL=0` | on | Skip Anthropic cache TTL upgrade (1h) |
| `OPENCODE_CTX_TTL_VALUE=1h\|5m` | `1h` | Cache TTL target for the upgraded breakpoint |
| `OPENCODE_CTX_CAVEMAN=lite\|full\|ultra` | off | Opt-in caveman output style |
| `OPENCODE_CTX_DEBUG=1` | off | Log decisions to stderr |
| `OPENCODE_CTX_DUMP=<path>` | off | Dump `system[0]` to file on first fire (for debugging) |

If you observe the model losing context on long sessions, bump `OPENCODE_CTX_MSGS_KEEP=5` or disable `MSGS` entirely.

## How cache safety works

Anthropic's prefix cache matches the beginning of input against cached content. If you mutate message N, the prefix up to N-1 still caches and only N onward re-processes. This plugin guarantees determinism — same input produces the same output on every call — so the mutated prefix itself becomes the new stable cache key. First post-install turn is a cache miss (expected); subsequent turns hit the new, smaller cache.

The `messages.transform` hook defensively shallow-clones `state` before rewriting `state.output` to avoid mutating live session DB references.

## What's preserved

Compression drops:
- Tutorial-style example conversations with `<reasoning>` blocks
- Redundant "when to use / when not to use" tables that duplicate the text
- Multi-paragraph git/PR walkthroughs (the model knows git; project policy lives in AGENTS.md)
- Emphatic restatements of the same rule
- Duplicated skill lists (once in system prompt, once in the `skill` tool description)

Compression preserves:
- Every behavioral rule, constraint, and decision matrix
- All parameter names and semantics
- Safety constraints (git force-push, `--no-verify`, `--amend` rules)
- Tool-selection policy and parallelism guidance
- Dynamic content (env, skill names, project paths) byte-for-byte

## File layout

```
src/
  index.ts              # Plugin entry, 5 hooks wired, kill-switch parsing
  tool-overrides.ts     # 22 tool description overrides
  omoa-trim.ts          # oh-my-openagent Sisyphus compressor + tail dedupe
  messages-trim.ts      # Message history tool-output trim
  cache-ttl.ts          # Anthropic 1h-TTL cache breakpoint upgrade
  tool-output-clean.ts  # Lossless ANSI/progress-bar cleaner
  system-trim.ts        # opencode anthropic.txt compressor
  compaction-prompt.ts  # Denser compaction prompt
  caveman-prompt.ts     # Opt-in output style compressor
```

## Cache TTL upgrade (v0.4+)

opencode's `provider/transform.ts` applies `{ type: "ephemeral" }` at message level to the first 2 system messages and the last 2 non-system messages — producing 4 Anthropic cache breakpoints per request, each with the default 5-minute TTL. Interactive sessions routinely idle >5m between turns (user reviews output, thinks, steps away), so the cache expires and every turn pays a cache-miss write cost.

Anthropic's 1-hour TTL (`{ type: "ephemeral", ttl: "1h" }`) costs 2x base on write (vs 1.25x for 5m) but enables cache hits across gaps up to 60 minutes. Net-positive for any session with N≥2 turns separated by 5m–1h gaps.

**Plugin scope: opencode exposes no hook to register AI SDK middleware or mutate message-level `providerOptions`.** The only available channel is part-level `metadata` on assistant text/reasoning parts, which propagates through `message-v2.ts` → `UIMessage.providerMetadata` → `ModelMessage.providerOptions`. Anthropic's provider reads part-level `cacheControl` before the message-level fallback, so part-level `{ ttl: "1h" }` wins over opencode's message-level `{ type: "ephemeral" }`.

**Breakpoint-overflow safety:** Anthropic caps active breakpoints at 4 per request; opencode consumes all 4. Injecting on a message outside the "last 2 non-system" window creates a 5th breakpoint and returns HTTP 400. `convertToModelMessages` splits opencode assistant messages containing ANY completed tool part into TWO ModelMessages (assistant + tool), which pushes the assistant out of the cache window. The plugin therefore **only injects when the target assistant message has no completed tool parts**, guaranteeing a 1:1 mapping that lands inside the window.

**Coverage:** upgrades AT MOST 1 of the 4 breakpoints — the most recent one, which represents the largest cached prefix and the highest per-turn read savings. The other 3 breakpoints (system[0], system[1], and the tool/user in the last window) remain at 5m TTL; reaching them would require an upstream patch to `provider/transform.ts`.

## License

MIT.
