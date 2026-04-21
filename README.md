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

Verified v0.4.0 on 2026-04-21 with live `opencode run --format json` requests. Working artifacts were collected in `/tmp/octx-bench`, and the scripts/result CSVs used for the final write-up were copied into `bench/`. Every benchmark used the same working directory and compared `OPENCODE_CTX_PLUGIN=0` vs `OPENCODE_CTX_PLUGIN=1`.

**Commands used:**
- Single-turn: `opencode run --format json --model <model> -- "Reply with exactly: OK"`
- Multi-turn: `opencode run --session <id> --format json --model <model> -- "<prompt>"`
- Tool-heavy: same as multi-turn plus `--dangerously-skip-permissions`

**Models actually exercised:**
- `anthropic/claude-haiku-4-5`
- `anthropic/claude-opus-4-7`
- attempted: `openai/gpt-5.4-mini`, `openai/gpt-5.4`

For context-window estimates below, **prompt-side context** means `input + cache.write + cache.read`. Output tokens are excluded from the 200k / 1M projections because they do not consume request context.

### Round 1 — Single-turn, 3 iterations (`anthropic/claude-haiku-4-5`)

Prompt: `"Reply with exactly: OK"`.

| Run | Plugin OFF total | Plugin ON total | Saved |
|---|---:|---:|---:|
| 1 (cold cache) | 25,898 | 15,601 | 10,297 (-39.8%) |
| 2 (warm cache) | 25,898 | 15,601 | 10,297 (-39.8%) |
| 3 (warm cache) | 25,898 | 15,601 | 10,297 (-39.8%) |

**Consistent -39.8% per request. Zero output variance.**

### Round 2 — Multi-turn 5×, no tools (`anthropic/claude-haiku-4-5`)

Sequential prompts via `--session`. Isolates cache accumulation without tool-output fat.

| Metric | Plugin OFF | Plugin ON | Saved | % |
|---|---:|---:|---:|---:|
| Session total | 129,747 | 78,264 | 51,483 | **-39.7%** |
| Cache read | 129,259 | 77,770 | 51,489 | -39.8% |
| Cache write | 419 | 415 | 4 | -1.0% |

Per-turn delta stayed flat at ~10.3K tokens — mostly the fixed system-prompt reduction.

### Round 3 — Multi-turn 5×, tool-heavy (`anthropic/claude-haiku-4-5`)

Each turn triggers real tool use (`read`, `grep`, `ls`). This exercises both system-prompt trim and message-history tool-output trim.

| Metric | Plugin OFF | Plugin ON | Saved | % |
|---|---:|---:|---:|---:|
| Session total | 142,774 | 88,591 | 54,183 | **-38.0%** |
| Cache read | 138,775 | 83,325 | 55,450 | -40.0% |

| Turn | Saved |
|---|---:|
| 1 | 10,306 |
| 2 | 10,315 |
| 3 | 10,841 |
| 4 | 11,361 |
| 5 | 11,360 |

Turn 4 captured the tool-output trim firing: plugin ON cache_read dropped by ~2K as stale tool output was elided from history, then rebuilt against a smaller prefix.

### Round 4 — Multi-turn 10×, plain chat (`anthropic/claude-haiku-4-5`)

Ten short memory-style turns. This is the low-growth case: short prompts, no tools, little transcript bloat.

| Metric | Plugin OFF | Plugin ON | Saved | % |
|---|---:|---:|---:|---:|
| Prompt-side session total | 259,963 | 157,031 | 102,932 | **-39.6%** |
| First-turn prompt size | 25,893 | 15,596 | 10,297 | -39.8% |
| Last-turn prompt size | 26,096 | 15,797 | 10,299 | -39.5% |
| Prompt growth / turn | 22.6 | 22.3 | 0.3 | -1.3% |

Interpretation: v0.4.0 removes a large fixed chunk every call, but in short plain-chat sessions the turn-to-turn growth was already tiny, so the 200k / 1M reach gain is modest.

### Round 5 — Multi-turn 10×, tool-heavy (`anthropic/claude-haiku-4-5`)

Ten turns with real tool usage and transcript accumulation.

| Metric | Plugin OFF | Plugin ON | Saved | % |
|---|---:|---:|---:|---:|
| Prompt-side session total | 334,152 | 198,284 | 135,868 | **-40.7%** |
| First-turn prompt size | 26,853 | 16,547 | 10,306 | -38.4% |
| Last-turn prompt size | 41,219 | 23,886 | 17,333 | -42.0% |
| Prompt growth / turn | 1,596.2 | 815.4 | 780.8 | -48.9% |

Interpretation: once the session accumulates tool output, v0.4.0 nearly halves growth. That is where it meaningfully extends practical context-window reach.

### Round 6 — Cross-model sanity check (`anthropic/claude-opus-4-7`)

Single-turn prompt: `"Reply with exactly: OK"`.

| Metric | Plugin OFF | Plugin ON | Saved | % |
|---|---:|---:|---:|---:|
| Prompt-side tokens | 36,572 | 21,781 | 14,791 | **-40.4%** |
| Output tokens | 6 | 6 | 0 | 0.0% |

### OpenAI status

Actual live requests were attempted against `openai/gpt-5.4-mini` and `openai/gpt-5.4` through opencode's configured OAuth path. Both failed **before inference** with the same provider error:

`401 token_invalidated: Your authentication token has been invalidated. Please try signing in again.`

So this README does **not** claim OpenAI savings numbers yet. `opencode auth list` showed OpenAI OAuth configured, but the live requests still failed at the provider auth layer.

### Does removing old thinking make the model worse?

**Not in v0.4.0 today**, because v0.4.0 is not stripping historical reasoning parts yet. The measured 38-40.7% savings in this document came from system-prompt compression, tool-definition compression, tool-output cleaning, tool-history trimming, and cache behavior.

Experimental reasoning trim now exists behind `OPENCODE_CTX_REASONING=1`, but it is **not** claimed as a proven live token win yet. In the current Anthropic `opencode run` path we tested, the benchmark observed **zero reasoning parts and zero reasoning tokens** (`reasoning_supported=false`), so we cannot honestly measure provider-side savings there. The feature is therefore opt-in only, skips assistant turns that contain tool parts, and should be treated as experimental until a real reasoning-emitting provider/model path is verified.

### Context-window scaling

Prompt-side growth from the 10-turn scenarios projects to very different horizons depending on session shape:

| Scenario | Turns to 200k context | Turns to 1M context | Capacity gain |
|---|---:|---:|---:|
| Plain chat OFF | 7,719 | 43,187 | — |
| Plain chat ON | 8,257 | 44,078 | +7.0% @ 200k, +2.1% @ 1M |
| Tool-heavy OFF | 108 | 610 | — |
| Tool-heavy ON | 225 | 1,206 | +108.3% @ 200k, +97.7% @ 1M |

```text
Tool-heavy prompt-side context growth

 220k |                              ██                             ▓▓▓|
 207k |                            ██                           ▓▓▓▓   |
 194k |··························██·························▓▓▓▓·······|
 181k |                        ██                       ▓▓▓▓           |
 168k |                      ██                     ▓▓▓▓               |
 155k |                    ██                   ▓▓▓▓                   |
 142k |                  ██                 ▓▓▓▓                       |
 129k |                ██               ▓▓▓▓                           |
 116k |              ██             ▓▓▓▓                               |
 103k |            ██           ▓▓▓▓                                   |
  90k |          ██         ▓▓▓▓                                       |
  77k |       ███       ▓▓▓▓                                           |
  64k |     ██      ▓▓▓▓                                               |
  51k |   ██    ▓▓▓▓                                                   |
  38k | ██  ▓▓▓▓                                                       |
  25k |█▓▓▓▓                                                           |
  12k |▓                                                               |
   0k |                                                                |
     +----------------------------------------------------------------+
      0                                                    250 turns
      OFF=█  ON=▓  200k=·
```

### Estimated cost at fixed 200k / 1M context

These are **linear token-cost estimates**, not extra live benchmark runs. They assume the same ~40% prompt-side reduction observed above, so a 200k prompt becomes ~120k and a 1M prompt becomes ~600k. Output tokens are ignored here; this table is only about prompt-side spend.

#### Standard input pricing

| Model | 200k without | 200k with plugin | Save | 1M without | 1M with plugin | Save |
|---|---:|---:|---:|---:|---:|---:|
| Claude Haiku 4.5 ($1.00 / MTok input) | $0.20 | $0.12 | $0.08 | $1.00 | $0.60 | $0.40 |
| Claude Opus 4.7 ($5.00 / MTok input) | $1.00 | $0.60 | $0.40 | $5.00 | $3.00 | $2.00 |
| OpenAI GPT-5.4 ($2.50 / MTok input) | $0.50 | $0.30 | $0.20 | $2.50 | $1.50 | $1.00 |
| OpenAI GPT-5.4 mini ($0.75 / MTok input) | $0.15 | $0.09 | $0.06 | $0.75 | $0.45 | $0.30 |

#### Cached-input pricing

| Model | 200k without | 200k with plugin | Save | 1M without | 1M with plugin | Save |
|---|---:|---:|---:|---:|---:|---:|
| Claude Haiku 4.5 ($0.10 / MTok cached read) | $0.020 | $0.012 | $0.008 | $0.100 | $0.060 | $0.040 |
| Claude Opus 4.7 ($0.50 / MTok cached read) | $0.100 | $0.060 | $0.040 | $0.500 | $0.300 | $0.200 |
| OpenAI GPT-5.4 ($0.25 / MTok cached input) | $0.050 | $0.030 | $0.020 | $0.250 | $0.150 | $0.100 |
| OpenAI GPT-5.4 mini ($0.075 / MTok cached input) | $0.015 | $0.009 | $0.006 | $0.075 | $0.045 | $0.030 |

OpenAI pricing is included because token billing is linear, but **OpenAI runtime savings are still unverified in this repo** until OAuth is fixed and the same live ON/OFF benchmarks can run there too.

### How to tell whether quality is affected

The current v0.4.0 numbers only prove **token savings**, not that every future trim is always quality-neutral. The right way to check quality is:

1. Keep the exact same prompt set and model.
2. Run plugin OFF and plugin ON on the same sessions.
3. Compare user-visible answers for correctness, tool choice, omissions, and follow-up consistency.
4. For long sessions, replay memory/tool-heavy transcripts and compare the final answer, not hidden reasoning verbosity.
5. For reasoning-trim specifically, benchmark it as a separate release because v0.4.0 does **not** remove old reasoning yet.

Practical rule: if the final answer, tool usage, and follow-up recall stay the same, then removing old prompt fat is helping cost/context without hurting quality.

### Experimental reasoning-trim status

Latest quality harness result for the experimental branch:

- `total_rows=84`
- `matches=80`
- `mismatches=4`
- `reasoning_token_rows=0`
- `reasoning_observed_rows=0`
- `reasoning_supported=false`

Interpretation: visible-behavior parity looks acceptable on the current suite, with the candidate still matching or beating baseline on every exercised suite, but the tested Anthropic run path did **not** emit real reasoning parts. That means the harness can currently prove "not obviously worse on these prompts", but it cannot prove real provider-side reasoning-token savings.

### Summary

| Benchmark | OFF | ON | Savings |
|---|---:|---:|---:|
| Single-turn × 3 (`haiku`) | 77,694 | 46,803 | **-39.8%** |
| Multi-turn 5× no-tools (`haiku`) | 129,747 | 78,264 | **-39.7%** |
| Multi-turn 5× tools (`haiku`) | 142,774 | 88,591 | **-38.0%** |
| Multi-turn 10× plain chat (`haiku`, prompt-side) | 259,963 | 157,031 | **-39.6%** |
| Multi-turn 10× tools (`haiku`, prompt-side) | 334,152 | 198,284 | **-40.7%** |
| Single-turn (`opus`) | 36,572 | 21,781 | **-40.4%** |

**Observed range today: 38.0% to 40.7% savings.** The fixed system-prompt cut dominates plain chat. The growth-rate win shows up in tool-heavy sessions, where v0.4.0 roughly doubles practical turns before hitting 200k / 1M ceilings. The next release should target reasoning parts and file parts, because those are the remaining large sources of long-session growth.

Cache determinism stayed intact: plugin ON continued hitting Anthropic prefix cache after the first rewritten turn.

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
| `OPENCODE_CTX_REASONING=1` | off | Experimental: trim historical reasoning on plain-chat turns only |
| `OPENCODE_CTX_REASONING_KEEP=N` | 2 | Experimental: keep last N assistant reasoning turns intact |
| `OPENCODE_CTX_FILES=1` | off | Experimental: replace older file parts with compact markers |
| `OPENCODE_CTX_FILES_KEEP=N` | 2 | Experimental: keep last N file parts intact |
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
