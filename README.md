# opencode-ctx

**A stable plugin for the opencode coding agent that makes each model request smaller before it is sent to Anthropic or OpenAI.**

Stable **v0.5.0** is focused on the part we could prove well: prompt/context compression.

> **Proven today:** about **38-41% fewer prompt-side tokens** in live Anthropic benchmarks and about **45-50% fewer** in the published OpenAI `gpt-5.4-mini` benchmark.
> **Best fit:** long coding sessions with lots of tool output.
> **Important:** this stable release does **not** rely on experimental reasoning/file trimming.

## Full documentation

Long-form reference lives in [`docs/`](./docs/README.md):

- [Getting started](./docs/getting-started.md) — install, verify, 2-minute quickstart
- [How it works](./docs/how-it-works.md) — every module, in execution order
- [Configuration](./docs/configuration.md) — every environment variable
- [Benchmarks](./docs/benchmarks.md) — measured savings + how to reproduce
- [Quality](./docs/quality.md) — what "no regression" actually means here
- [Troubleshooting](./docs/troubleshooting.md) — known failure modes and fixes
- [Architecture](./docs/architecture.md) — hook ordering, provider-shape invariants
- [Contributing](./docs/contributing.md) — how to add or remove a module safely

The rest of this README is a short summary of the same information.

---

## What this plugin is, in beginner terms

If you have never seen a tool like this before, here is the simple version: opencode is a coding agent, and every time it asks a model something, it does **not** send only your latest prompt. It also sends a big packet of extra context, including things like:

- the system prompt
- tool descriptions
- recent conversation history
- tool output from earlier turns
- terminal noise like ANSI/progress junk

This plugin makes that packet **smaller** before it goes to the provider.

That means:
- **less context used per request**
- **lower prompt-side cost**
- **longer sessions before the context window fills up**

It does **not** change your files by itself.
It does **not** replace the model.
It does **not** need risky “hidden reasoning” tricks for the stable savings story.

---

## TL;DR

| If you care about... | Short answer |
|---|---|
| **Per-request savings** | A trivial Anthropic request dropped from **25,898** tokens to **15,601** (**-39.8%**) |
| **OpenAI savings** | The published `gpt-5.4-mini` benchmark landed at **-45.3%** on a simple request and **-49.6%** on a 5-turn tool-heavy session |
| **Long-session savings** | A 10-turn Anthropic tool-heavy session dropped from **334,152** to **198,284** prompt-side tokens (**-40.7%**) |
| **Context window reach** | In the measured tool-heavy projection, **200k** grows from **108** turns to **225** turns; **1M** grows from **610** to **1,206** turns |
| **Quality story** | The stable release only ships the parts we were comfortable proving. Under-proven reasoning/file trim was removed from the stable runtime. |

---

## What the savings mean in plain English

If opencode would normally send **100 tokens**, this plugin tends to send around:

- **60 tokens** on the Anthropic benchmarked path
- **50-55 tokens** on the published OpenAI `gpt-5.4-mini` benchmark

A concrete Anthropic example:

```text
Single-turn Anthropic example

Without plugin  ████████████████████████  25,898
With plugin     ██████████████            15,601
Saved           ██████████                10,297  (-39.8%)
```

A concrete OpenAI example:

```text
Single-turn OpenAI gpt-5.4-mini example (3-run average)

Without plugin  ████████████████████████  19,402
With plugin     █████████████             10,620
Saved           ███████████               8,782  (-45.3%)
```

This is not a tiny micro-optimization. The plugin mainly removes:

- repeated prompt overhead
- bloated tool descriptions
- stale old tool output
- duplicate tool output
- terminal junk that does not help the model answer better

---

## What the stable plugin actually does

| Feature | What it does | Status |
|---|---|---|
| Tool description compression | Shrinks opencode + oh-my-openagent tool definitions | **Stable** |
| System prompt compression | Shrinks the big fixed system prompt | **Stable** |
| Message-history tool trim | Collapses stale old tool output and duplicate reads/calls | **Stable** |
| Tool-output cleaning | Removes ANSI noise, progress bars, extra blank lines | **Stable** |
| Anthropic 1h cache TTL upgrade | Keeps the most valuable cache breakpoint alive longer | **Stable** |
| Caveman mode | Optional terse output style | **Optional** |

What the stable release **does not** ship in runtime:
- historical reasoning trim
- historical file trim

Those were investigated, but not kept in the stable path because the proof was not strong enough.

---

## Proven benchmark summary

These are the easiest numbers to trust and understand.

| Scenario | Without plugin | With plugin | Saved | What it means |
|---|---:|---:|---:|---|
| **Anthropic single-turn request** | 25,898 | 15,601 | **10,297 (-39.8%)** | Fixed prompt/tool overhead got much smaller |
| **Anthropic 5-turn normal chat session** | 129,747 | 78,264 | **51,483 (-39.7%)** | Savings stay consistent across turns |
| **Anthropic 10-turn tool-heavy session** | 334,152 | 198,284 | **135,868 (-40.7%)** | Old tool output gets trimmed too, so long sessions benefit most |
| **Anthropic Opus sanity check (single turn)** | 36,572 | 21,781 | **14,791 (-40.4%)** | The same pattern holds on a stronger Anthropic model |
| **OpenAI `gpt-5.4-mini` single-turn average (3 runs)** | 19,402 | 10,620 | **8,782 (-45.3%)** | The same fixed prompt/tool overhead shrinks on OpenAI too |
| **OpenAI `gpt-5.4-mini` 5-turn tool-heavy session** | 112,683 | 56,740 | **55,943 (-49.6%)** | Long tool-heavy OpenAI sessions benefit even more |

**Bottom line:** stable `v0.5.0` saves about **2/5 on Anthropic** and about **45-50% on the published OpenAI `gpt-5.4-mini` benchmark**.

---

## How much did we actually test this?

Published benchmark coverage in the repo today:

- **6 live Anthropic single-turn runs** (`3 off + 3 on`)
- **10 live Anthropic 5-turn plain-chat turns** (`5 off + 5 on`)
- **10 live Anthropic 5-turn tool-heavy turns** (`5 off + 5 on`)
- **42 additional Anthropic scenario runs** from the expanded benchmark (`10-turn plain-chat`, `10-turn tool-heavy`, and Opus sanity checks)
- **6 live OpenAI single-turn runs** (`3 off + 3 on` on `gpt-5.4-mini`)
- **10 live OpenAI 5-turn tool-heavy turns** (`5 off + 5 on` on `gpt-5.4-mini`)

That is **84 successful live benchmark requests/turns** in the published artifacts, plus extra post-release smoke tests:

- Anthropic `read` smoke
- Anthropic `bash` smoke
- OpenAI plain smoke
- OpenAI `read` smoke

If you want the receipts, they are in [`bench/`](./bench/).

---

## Quality: why should you trust this?

### The short answer

Because the stable release only ships the parts we were willing to defend.

Here, **quality** means the plugin should still let the model produce the same kind of useful answer and use tools correctly, while sending less junk context to the provider. In other words: lower token usage **without** making the agent obviously dumber.

### What that means in practice

The plugin used to have a more ambitious branch exploring historical reasoning/file trimming.
That branch might have saved more tokens, but the proof was not strong enough for a stable release.

So for **stable v0.5.0** we did the safer thing:
- keep the clearly-proven compression work
- cut the under-proven runtime pieces from the stable path
- keep the research harness only as **bench artifacts**, not as the shipped feature set

### Quality claim for the stable release

The stable release mainly compresses **repeated overhead and stale tool noise**.
It does **not** depend on rewriting hidden reasoning, and it does **not** depend on fragile message surgery for the stable path.

So the quality claim is intentionally narrower and easier to trust:

> **Stable v0.5.0 reduces context without relying on the risky parts we could not prove well enough.**

That is why this release is complete: the shipped scope matches the proven scope.

---

## Context window impact

The plugin matters most when the transcript keeps growing because of tool output.

### Tool-heavy projection from measured data

| Context window | Without plugin | With plugin | Practical effect |
|---|---:|---:|---|
| **200k** | 108 turns | 225 turns | about **2.1x longer** |
| **1M** | 610 turns | 1,206 turns | about **2.0x longer** |

For plain chat, the growth was already tiny, so the context-window gain is much smaller. This plugin pays off most when the session contains large reads, greps, bash output, or similar tool noise.

---

## Cost examples

At a fixed prompt size, fewer prompt tokens means lower prompt-side cost. This section mixes two kinds of numbers on purpose, so here is the rule: Anthropic rows below are grounded in the live benchmark story above, while some OpenAI rows are still **linear estimates** unless they explicitly mention the published `gpt-5.4-mini` benchmark.

### 200k prompt
- **Claude Haiku 4.5:** `$0.20 -> $0.12`
- **Claude Opus 4.7:** `$1.00 -> $0.60`
- **OpenAI GPT-5.4:** `$0.50 -> $0.30` *(still a linear estimate; the published live OpenAI benchmark is on `gpt-5.4-mini`)*
- **OpenAI GPT-5.4-mini:** published benchmark landed at about **-45.1% cost** on the single-turn test and **-45.3% cost** on the 5-turn tool-heavy session

### 1M prompt
- **Claude Haiku 4.5:** `$1.00 -> $0.60`
- **Claude Opus 4.7:** `$5.00 -> $3.00`
- **OpenAI GPT-5.4:** `$2.50 -> $1.50` *(still a linear estimate; the published live OpenAI benchmark is on `gpt-5.4-mini`)*

---

## OpenAI status

OpenAI is now **benchmarked live** on `openai/gpt-5.4-mini`:

- **single-turn average (3 runs):** `19,402 -> 10,620` (**-45.3%**)
- **5-turn tool-heavy session:** `112,683 -> 56,740` (**-49.6%**)
- plugin confirmed active on stderr during both the plain and tool-use runs

Observed OpenAI benchmark cost movement:
- **single-turn average:** `$0.01465 -> $0.00805` (**-45.1%**)
- **5-turn tool-heavy session total:** `$0.01253 -> $0.00686` (**-45.3%**)

So OpenAI is no longer just “smoke-verified.” It now has a published benchmark in the repo. The published OpenAI benchmark here is currently specific to **`gpt-5.4-mini`**.

---

## Install

```bash
cd ~/.local/share
git clone https://github.com/iamtheavoc1/opencode-ctx.git
cd opencode-ctx
bun install
```

Add the plugin to `~/.config/opencode/opencode.json` using an **absolute** path.

### macOS example

```json
{
  "plugin": [
    "file:///Users/YOU/.local/share/opencode-ctx/src/index.ts"
  ]
}
```

### Linux example

```json
{
  "plugin": [
    "file:///home/YOU/.local/share/opencode-ctx/src/index.ts"
  ]
}
```

Restart opencode. Verify with:

```bash
OPENCODE_CTX_DEBUG=1 opencode run "hi"
```

You should see `[ctx-plugin] active: ...` on stderr.

---

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

---

## Bench artifacts

Raw scripts and CSV outputs live in [`bench/`](./bench/).

That folder contains:
- Anthropic benchmark scripts/results
- OpenAI benchmark scripts/results
- expanded scenario benchmarks
- research artifacts from the reasoning-trim investigation

If you want the receipts, that folder is the receipts.

---

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
- `openai/gpt-5.4-mini`
- attempted earlier: `openai/gpt-5.4`

The raw CSVs are in `bench/`.
</details>

<details>
<summary><strong>How cache safety works</strong></summary>

This plugin is designed to preserve deterministic prefixes. If the same prompt/session state produces the same transformed output, prompt caching still works — it just caches the smaller transformed prefix instead of the larger original one.
</details>

<details>
<summary><strong>Anthropic TTL upgrade details</strong></summary>

opencode's `provider/transform.ts` applies `{ type: "ephemeral" }` at message level to the first 2 system messages and the last 2 non-system messages — producing 4 Anthropic cache breakpoints per request, each with the default 5-minute TTL.

This plugin upgrades the most-recent assistant-turn breakpoint to `1h` when it is safe to do so. It only targets a message shape that keeps the breakpoint count inside Anthropic's limit and avoids assistant turns that contain completed tool parts.
</details>

---

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
