# How it works

`opencode-ctx` is a single opencode plugin that registers two hooks and nine small transforms. Every transform is lossy in a bounded, predictable way — the model still receives everything it needs to reason correctly; it just receives a smaller version of it.

## Hook surface

The plugin attaches to two opencode extension points:

1. **`chat.params`** — runs once per request, before the request is serialized to the provider. This is where tool definitions, the system prompt, and the oh-my-openagent prompt are rewritten. See [`src/index.ts`](../src/index.ts).
2. **`experimental.chat.messages.transform`** — runs once per request, on the message array. This is where stale tool output is trimmed, duplicates are collapsed, ANSI noise is removed, and the Anthropic 1-hour TTL upgrade is applied.

Both hooks receive the raw provider payload. Neither hook touches the provider's network layer.

## Execution order

Every request flows through these stages, in this order:

| # | Module | Purpose |
|---|---|---|
| 1 | `tool-overrides.ts` | Rewrite opencode's built-in tool descriptions to a dense schema (large fixed saving per request) |
| 2 | `system-trim.ts` | Remove verbose examples and repeated sections from the system prompt |
| 3 | `omoa-trim.ts` | Compress the oh-my-openagent prompt that opencode injects when present |
| 4 | `compaction-prompt.ts` | Swap the compaction trigger prompt for a denser variant |
| 5 | `caveman-prompt.ts` | *Opt-in.* Append a terse output-style addendum |
| 6 | `tool-output-clean.ts` | Strip ANSI escapes, CR-heavy progress bars, and leading/trailing whitespace from every tool result (lossless) |
| 7 | `messages-trim.ts` | History trim: cap stale tool outputs, collapse superseded reads, dedup repeated tool calls |
| 8 | `cache-ttl.ts` | Promote the last safe Anthropic cache breakpoint from 5 minutes to 1 hour |
| 9 | `index.ts` | Wire everything and emit the `[ctx-plugin] active:` debug line |

Each module has its own kill switch. See [configuration](./configuration.md).

## What each module actually does

### 1. Tool description compression (`tool-overrides.ts`)

opencode ships ~22 built-in tools whose descriptions include multi-paragraph usage examples. Every request re-sends every description. This module replaces each description with a terse schema that preserves:

- the tool name
- every parameter name, type, and required/optional flag
- a one-line summary of purpose

It removes: prose examples, anti-patterns, redundant warnings, style guidance.

This is the single biggest fixed saving. Tool-heavy sessions see ~20–30% of the total reduction come from here.

### 2. System prompt trim (`system-trim.ts`)

opencode's system prompt includes large blocks that repeat information the agent already encodes in tool descriptions or environment metadata. This module drops duplicates, keeps invariants.

### 3. oh-my-openagent prompt trim (`omoa-trim.ts`)

When opencode is driven by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent), an additional prompt is injected. This module compresses it using the same principles as the system trim.

Guarded by `OPENCODE_CTX_OMOA=0` because the prefix must remain byte-identical for prompt caching to hit.

### 4. Compaction prompt swap (`compaction-prompt.ts`)

When a session crosses opencode's compaction threshold, opencode asks the model to summarize the transcript so far. This module swaps that prompt for a denser variant that produces shorter summaries with equivalent fidelity.

### 5. Caveman output style (`caveman-prompt.ts`) — opt-in

Disabled by default. Setting `OPENCODE_CTX_CAVEMAN=lite|full|ultra` appends a style addendum that asks the model for terse, no-preamble responses. This also reduces completion-side tokens, which the other modules do not.

### 6. Lossless tool-output cleaner (`tool-output-clean.ts`)

Strips things no model benefits from:

- ANSI escape sequences
- Carriage-return-heavy progress bars (e.g. `npm`, `yarn`, `cargo`)
- Trailing whitespace
- Redundant blank lines

Skipped for tools whose output depends on exact whitespace (`patch`, `question`, `task`, `todowrite`, `call_omo_agent`, `skill`).

### 7. History trim + dedup (`messages-trim.ts`)

The biggest saving on long sessions. Three sub-passes, each independently disableable:

1. **Stale tool-output trim.** For tool outputs older than `OPENCODE_CTX_MSGS_KEEP` turns (default 3), if the output exceeds `OPENCODE_CTX_MSGS_CAP` bytes (default 600), keep the first `MSGS_HEAD` bytes (default 300) and the last `MSGS_TAIL` bytes (default 150), with an explicit `[... trimmed by ctx-plugin ...]` marker in between.
2. **Superseded-read collapse.** If the same file was read multiple times, keep only the most recent read. Controlled by `OPENCODE_CTX_SUPERSEDE`.
3. **Duplicate tool-call dedup.** If the same tool was called with the same args producing a large output, later duplicates collapse to a pointer back to the first. Controlled by `OPENCODE_CTX_DEDUP` with min-bytes threshold `OPENCODE_CTX_DEDUP_MIN`.

### 8. Anthropic TTL upgrade (`cache-ttl.ts`)

opencode's provider layer places `{ type: "ephemeral" }` markers at up to 4 Anthropic cache breakpoints per request. Each breakpoint defaults to Anthropic's 5-minute TTL.

When safe, this module promotes the most-recent assistant-turn breakpoint to 1 hour via `{ type: "ephemeral", ttl: "1h" }`. "Safe" means the surrounding message shape keeps total breakpoint count inside Anthropic's limit and avoids assistant turns that contain completed tool parts — both of which would otherwise produce a 400 from Anthropic.

Anthropic-only. OpenAI requests pass through unchanged.

### 9. The wire-up (`index.ts`)

Runs the nine transforms in order, emits the `[ctx-plugin] active: …` debug line, and respects `OPENCODE_CTX_PLUGIN=0` as the single master kill switch.

## What the plugin never does

- It never changes the user's message.
- It never changes an assistant message that has already been sent.
- It never calls the provider directly.
- It never writes files or mutates the opencode session store.
- It does not attempt to influence the model's reasoning style beyond the opt-in `OPENCODE_CTX_CAVEMAN` addendum.

If any of those things start happening, that is a bug.
