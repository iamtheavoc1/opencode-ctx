# opencode-ctx

Aggressive context compression plugin for [opencode](https://opencode.ai). Cuts per-request Anthropic token usage by roughly **40% on fresh sessions and ~50-55% deep into long sessions** while preserving every behavioral rule and Anthropic's prefix cache.

## What it does

Five independent, cache-deterministic transforms. Every transform is a pure function of its input, so Anthropic's prefix cache still hits on subsequent turns.

| Hook | Target | Typical saving |
|---|---|---|
| `tool.definition` | Compresses 22 opencode + oh-my-openagent tool descriptions | ~13KB per request |
| `experimental.chat.system.transform` | Replaces opencode's `anthropic.txt` and oh-my-openagent's Sisyphus prompt with equivalent compressed versions; dedupes the env/skills tail | ~14KB per request |
| `experimental.chat.messages.transform` | Trims stale tool outputs (file reads, bash dumps, webfetches) in message history; preserves the last N intact | scales with session length, ~13K+ tokens/turn on long sessions |
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
  index.ts              # Plugin entry, 4 hooks wired, kill-switch parsing
  tool-overrides.ts     # 22 tool description overrides
  omoa-trim.ts          # oh-my-openagent Sisyphus compressor + tail dedupe
  messages-trim.ts      # Message history tool-output trim
  system-trim.ts        # opencode anthropic.txt compressor
  compaction-prompt.ts  # Denser compaction prompt
  caveman-prompt.ts     # Opt-in output style compressor
```

## License

MIT.
