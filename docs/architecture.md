# Architecture

This page is for people who are going to read, modify, or audit the plugin source. If you just want to use the plugin, [how it works](./how-it-works.md) is enough.

## Runtime shape

The plugin is a single TypeScript module (`src/index.ts`) that exports a default `Plugin` function. When opencode loads the plugin, it calls the export, which returns a hooks object:

```ts
{
  "chat.params": async (input, output) => { … },
  "experimental.chat.messages.transform": async (_input, output) => { … },
}
```

- `chat.params` runs once per request before the request is serialized to the provider. It receives the full parameter object (tools, system, model, etc.) and can mutate it in place.
- `experimental.chat.messages.transform` runs once per request on the messages array. It can mutate each message's parts.

Neither hook has access to the provider's transport layer. Neither hook can cancel a request.

## Why two hooks

The opencode plugin API splits mutation points for a reason:

- `chat.params` sees tool schemas, so it is the right place to rewrite them.
- `experimental.chat.messages.transform` sees the messages, so it is the right place to rewrite historical tool outputs.

Trying to do both in one hook forces ordering hacks. The split mirrors opencode's internal stages.

## Hook ordering guarantees

Within `chat.params`, the module order matters because some transforms read what earlier ones wrote:

1. `tool-overrides.ts` replaces tool definitions first because later modules may inspect tool names.
2. `system-trim.ts` then works on the system prompt array.
3. `omoa-trim.ts` runs next so that OMOA content is trimmed before any prefix-cache prefix comparison.
4. `compaction-prompt.ts` swaps the compaction prompt token only when present.
5. `caveman-prompt.ts` appends to system prompts last, so the addendum does not interfere with trim heuristics.

Within `experimental.chat.messages.transform`:

1. `messages-trim.ts` runs before `cache-ttl.ts` because trim changes which assistant turn is "last completed," which the TTL upgrade targets.
2. `tool-output-clean.ts` runs at the end because its edits are lossless and never affect targeting.

## Provider-shape constraints

Each provider has request-shape rules. The plugin respects them:

### Anthropic

- **Cache breakpoint count.** Anthropic allows up to 4 `cache_control` markers per request. opencode places up to 4 at known-good breakpoints. The TTL upgrade never adds a new marker — it only promotes an existing 5-minute marker to 1 hour. This keeps total count constant.
- **Assistant-turn shape.** Anthropic rejects requests where an assistant turn contains *completed* tool-use blocks interleaved with text in a way that produces an implicit cache slot. The TTL upgrade checks for this shape and skips the promotion rather than risk a 400.
- **Reasoning blocks.** Extended-thinking outputs come back as `thinking` blocks. The stable runtime does **not** rewrite reasoning. Earlier prototypes did; they were cut because the emission conditions for reasoning blocks are model-dependent and the blast radius of a wrong trim there is too high.

### OpenAI

- **No prompt caching control.** Breakpoint / TTL logic short-circuits on OpenAI requests; it does not have a safe no-op.
- **Tool-shape invariant.** OpenAI enforces strict tool parameter schemas. The tool-description rewrite only touches `description` fields, never `parameters.*`.
- **OAuth path.** The plugin never touches auth. Auth failures on OpenAI (`401 token_invalidated`) are fully upstream.

## Cache-safety invariants

Two invariants let the system + tool rewrites remain cache-friendly:

1. **The rewrite is deterministic.** Given the same opencode version and the same environment variables, the rewrite produces byte-identical output. This is why every toggle is a boolean: a non-deterministic knob would cache-bust every run.
2. **The rewrite is stable across turns within a session.** opencode calls the same hook with the same params shape every turn, so Anthropic's prefix cache sees the same prefix every turn.

If you introduce a new transform, both invariants must hold for the cache hit rate not to collapse.

## Failure modes the plugin refuses to introduce

These are hard rules embedded in the current design:

- The plugin must never raise during `chat.params` or the transform hook in a way that prevents the request from being sent. Any internal error is caught and logged; the original params pass through unchanged. Fail-safe, never fail-closed.
- The plugin must never mutate a user message.
- The plugin must never remove a tool from the tool list.
- The plugin must never remove a historical assistant message.
- The plugin must never change the ordering of messages.

Every transform either shortens a string field or replaces a description block. No structural edits.

## Source layout

```
src/
  index.ts              Plugin entry; wires hooks in order
  tool-overrides.ts     Tool description rewrite
  system-trim.ts        System prompt trim
  omoa-trim.ts          oh-my-openagent prompt trim
  compaction-prompt.ts  Compaction prompt swap
  caveman-prompt.ts     Opt-in terse output style
  tool-output-clean.ts  ANSI / progress-bar cleaner
  messages-trim.ts      History trim + dedup
  cache-ttl.ts          Anthropic 1-hour TTL upgrade
```

Each module exports a single pure function that takes the current params or messages and returns the modified version (or mutates in place where opencode's API expects it).

## See also

- [How it works](./how-it-works.md) — plain-language version of this page
- [Contributing](./contributing.md) — how to add a new module safely
