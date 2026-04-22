# opencode-ctx

Shrink opencode's prompt/context before it hits the model.

> **Stable today:** about **38-41% fewer prompt-side tokens** in live Anthropic benchmarks.
> **Best fit:** long sessions with lots of tool output.
> **Scope:** prompt/tool/history compression only — no risky reasoning tricks required.

## TL;DR

| If you care about... | Short answer |
|---|---|
| **Per-request savings** | A trivial Anthropic request dropped from **25,898** tokens to **15,601** (**-39.8%**) |
| **Long-session savings** | A 10-turn tool-heavy session dropped from **334,152** to **198,284** prompt-side tokens (**-40.7%**) |
| **Context window reach** | In the measured tool-heavy projection, **200k** grows from **108** turns to **225** turns; **1M** grows from **610** to **1,206** turns |
| **What it actually does** | Compresses prompt/tool overhead, stale tool history, duplicate output, and terminal noise |
| **What it does not rely on** | No experimental reasoning-trim path is required for the proven savings |

## What the savings mean in plain English

If opencode would normally send **100 tokens**, this plugin tends to send about **60** instead.

A concrete example from the live benchmark:

```text
Single-turn Anthropic example

Without plugin  ████████████████████████  25,898
With plugin     ██████████████            15,601
Saved           ██████████                10,297  (-39.8%)
```

This is not a tiny micro-optimization. The plugin mainly removes repeated prompt overhead, bloated tool descriptions, stale old tool output, duplicate tool output, and terminal junk that does not help the model answer better.

## What the stable plugin does

| Feature | What it does | Status |
|---|---|---|
| Tool description compression | Shrinks opencode + oh-my-openagent tool definitions | **Stable** |
| System prompt compression | Shrinks the big fixed system prompt | **Stable** |
| Message-history tool trim | Collapses stale old tool output and duplicate reads/calls | **Stable** |
| Tool-output cleaning | Removes ANSI noise, progress bars, extra blank lines | **Stable** |
| Anthropic 1h cache TTL upgrade | Keeps the most valuable cache breakpoint alive longer | **Stable** |

## Proven benchmark summary

These are the easiest numbers to trust and understand.

| Scenario | Without plugin | With plugin | Saved | What it means |
|---|---:|---:|---:|---|
| **Single-turn Anthropic request** | 25,898 | 15,601 | **10,297 (-39.8%)** | Fixed prompt/tool overhead got much smaller |
| **5-turn normal chat session** | 129,747 | 78,264 | **51,483 (-39.7%)** | Savings stay consistent across turns |
| **10-turn tool-heavy session** | 334,152 | 198,284 | **135,868 (-40.7%)** | Old tool output gets trimmed too, so long sessions benefit most |
| **Opus sanity check (single turn)** | 36,572 | 21,781 | **14,791 (-40.4%)** | The same pattern holds on a stronger Anthropic model |

**Bottom line:** the stable plugin consistently saves about **2/5 of the prompt/context tokens** in the live Anthropic runs we measured.

## Context window impact

The plugin matters most when the transcript keeps growing because of tool output.

### Tool-heavy projection from measured data

| Context window | Without plugin | With plugin | Practical effect |
|---|---:|---:|---|
| **200k** | 108 turns | 225 turns | about **2.1x longer** |
| **1M** | 610 turns | 1,206 turns | about **2.0x longer** |

For plain chat, the growth was already tiny, so the context-window gain is much smaller. This plugin pays off most when the session contains large reads, greps, bash output, or similar tool noise.

## Cost examples

At a fixed prompt size, ~40% fewer prompt tokens means ~40% lower prompt-side cost.

### 200k prompt
- **Claude Haiku 4.5:** `$0.20 -> $0.12`
- **Claude Opus 4.7:** `$1.00 -> $0.60`
- **OpenAI GPT-5.4:** `$0.50 -> $0.30` *(linear estimate only; live OpenAI benchmark still blocked by auth)*

### 1M prompt
- **Claude Haiku 4.5:** `$1.00 -> $0.60`
- **Claude Opus 4.7:** `$5.00 -> $3.00`
- **OpenAI GPT-5.4:** `$2.50 -> $1.50` *(linear estimate only; live OpenAI benchmark still blocked by auth)*

## Quality and safety

### What is actually proven safe today?

The **proven savings** in this repo come from:
- tool definition compression
- system prompt compression
- stale tool-output trimming
- duplicate output collapse
- tool-output cleaning
- Anthropic TTL cache upgrade

The stable plugin does **not** depend on historical reasoning trim or historical file trim.

### Cache safety

This plugin is designed to preserve deterministic prefixes. If the same prompt/session state produces the same transformed output, Anthropic prompt caching still works — it just caches the smaller transformed prefix instead of the larger original one.

### OpenAI status

Live OpenAI runs were attempted against:
- `openai/gpt-5.4-mini`
- `openai/gpt-5.4`

Both failed before inference with:

```text
401 token_invalidated: Your authentication token has been invalidated. Please try signing in again.
```

So the README includes OpenAI **cost math**, but not live OpenAI savings claims.

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
    "file://$HOME/.local/share/opencode-ctx/src/index.ts"
  ]
}
```

Restart opencode. Verify with:

```bash
OPENCODE_CTX_DEBUG=1 opencode run "hi"
```

You should see `[ctx-plugin] active: ...` on stderr.

## Main toggles

### Core on/off toggles

| Var | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_PLUGIN=0` | on | Disable the whole plugin |
| `OPENCODE_CTX_TRIM=0` | on | Skip tool description + system prompt trim |
| `OPENCODE_CTX_OMOA=0` | on | Skip oh-my-openagent prompt compressor |
| `OPENCODE_CTX_COMPACT=0` | on | Skip compaction prompt replacement |
| `OPENCODE_CTX_MSGS=0` | on | Skip message-history tool-output trim |
| `OPENCODE_CTX_CLEAN=0` | on | Skip lossless tool-output cleaner |
| `OPENCODE_CTX_TTL=0` | on | Skip Anthropic cache TTL upgrade (1h) |
| `OPENCODE_CTX_TTL_VALUE=1h|5m` | `1h` | Cache TTL target for the upgraded breakpoint |
| `OPENCODE_CTX_CAVEMAN=lite|full|ultra` | off | Opt-in terse output style |
| `OPENCODE_CTX_DEBUG=1` | off | Log decisions to stderr |
| `OPENCODE_CTX_DUMP=<path>` | off | Dump `system[0]` to file on first fire |

### Tuning knobs

| Var | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_MSGS_KEEP=N` | 3 | Preserve the last N tool outputs intact |
| `OPENCODE_CTX_MSGS_CAP=N` | 600 | Byte threshold before stale tool-output trim kicks in |
| `OPENCODE_CTX_MSGS_HEAD=N` | 300 | Head bytes kept when trimming |
| `OPENCODE_CTX_MSGS_TAIL=N` | 150 | Tail bytes kept when trimming |
| `OPENCODE_CTX_SUPERSEDE=0` | on | Skip superseded-read collapse |
| `OPENCODE_CTX_DEDUP=0` | on | Skip duplicate tool-call dedup |
| `OPENCODE_CTX_DEDUP_MIN=N` | 200 | Min output bytes to consider for dedup |

If the model seems to lose context on long sessions, bump `OPENCODE_CTX_MSGS_KEEP=5` or disable message-history trimming entirely with `OPENCODE_CTX_MSGS=0`.

## Bench artifacts

Raw scripts and CSV outputs live in [`bench/`](./bench/).

That folder contains:
- the single-turn benchmark
- multi-turn plain-chat benchmark
- multi-turn tool-heavy benchmark
- expanded 10-turn scenario benchmark
- quality/research artifacts from the reasoning-trim investigation

If you want the receipts, that folder is the receipts.

## Advanced notes

<details>
<summary><strong>Detailed benchmark methodology</strong></summary>

Benchmarks were run with live `opencode run --format json` requests in the same working directory, comparing `OPENCODE_CTX_PLUGIN=0` vs `OPENCODE_CTX_PLUGIN=1`.

**Commands used:**
- Single-turn: `opencode run --format json --model <model> -- "Reply with exactly: OK"`
- Multi-turn: `opencode run --session <id> --format json --model <model> -- "<prompt>"`
- Tool-heavy: same as multi-turn plus `--dangerously-skip-permissions`

**Models actually exercised:**
- `anthropic/claude-haiku-4-5`
- `anthropic/claude-opus-4-7`
- attempted: `openai/gpt-5.4-mini`, `openai/gpt-5.4`

The raw CSVs are in `bench/`.
</details>

<details>
<summary><strong>Anthropic TTL upgrade details</strong></summary>

opencode's `provider/transform.ts` applies `{ type: "ephemeral" }` at message level to the first 2 system messages and the last 2 non-system messages — producing 4 Anthropic cache breakpoints per request, each with the default 5-minute TTL.

This plugin upgrades the most-recent assistant-turn breakpoint to `1h` when it is safe to do so. It only targets a message shape that keeps the breakpoint count inside Anthropic's limit and avoids assistant turns that contain completed tool parts.
</details>

## File layout

```text
src/
  index.ts              # Plugin entry and hook wiring
  tool-overrides.ts     # Tool description compression
  system-trim.ts        # System prompt compression
  omoa-trim.ts          # oh-my-openagent prompt compression
  messages-trim.ts      # History trimming, dedup, and stale tool-output compression
  cache-ttl.ts          # Anthropic 1h TTL upgrade
  tool-output-clean.ts  # Lossless ANSI/progress-bar cleaner
  compaction-prompt.ts  # Denser compaction prompt
  caveman-prompt.ts     # Opt-in terse output style
```

## License

MIT.
