# Configuration

Every knob is an environment variable. No config files, no JSON schemas. The plugin is fully functional with zero env vars set.

All variables are read once at plugin load, so changes take effect on the next `opencode` start.

## Master switch

| Var | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_PLUGIN` | unset (on) | Set to `0` to bypass every transform. The plugin still loads; it just short-circuits. |

## Per-module kill switches

Each of these defaults to on. Set to `0` to disable only that module.

| Var | Disables |
|---|---|
| `OPENCODE_CTX_TRIM` | Tool-description rewrite + system-prompt trim |
| `OPENCODE_CTX_OMOA` | oh-my-openagent prompt compressor |
| `OPENCODE_CTX_COMPACT` | Compaction-prompt swap |
| `OPENCODE_CTX_MSGS` | History trim (stale tool outputs, superseded reads, duplicate tool calls) |
| `OPENCODE_CTX_CLEAN` | Lossless tool-output cleaner (ANSI/progress-bar strip) |
| `OPENCODE_CTX_TTL` | Anthropic 1-hour cache-TTL upgrade |

## History-trim tuning

These affect the single biggest saving on long sessions. Defaults are conservative.

| Var | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_MSGS_KEEP` | `3` | Number of recent turns that are never trimmed |
| `OPENCODE_CTX_MSGS_CAP` | `600` | Bytes above which a stale tool output gets shortened |
| `OPENCODE_CTX_MSGS_HEAD` | `300` | Bytes kept from the start of a shortened output |
| `OPENCODE_CTX_MSGS_TAIL` | `150` | Bytes kept from the end of a shortened output |
| `OPENCODE_CTX_SUPERSEDE` | on | Set `0` to keep every historical file read |
| `OPENCODE_CTX_DEDUP` | on | Set `0` to keep every duplicate tool call |
| `OPENCODE_CTX_DEDUP_MIN` | `200` | Bytes below which dedup does not bother |

**Conservative override** (keeps more recent history, still cleans obvious waste):

```bash
export OPENCODE_CTX_MSGS_KEEP=5
export OPENCODE_CTX_MSGS_CAP=2000
export OPENCODE_CTX_MSGS_HEAD=1000
export OPENCODE_CTX_MSGS_TAIL=500
```

**Aggressive override** (smallest prompts, only recommended on short-horizon tasks):

```bash
export OPENCODE_CTX_MSGS_KEEP=1
export OPENCODE_CTX_MSGS_CAP=200
export OPENCODE_CTX_MSGS_HEAD=100
export OPENCODE_CTX_MSGS_TAIL=50
```

## Cache TTL

| Var | Default | Effect |
|---|---|---|
| `OPENCODE_CTX_TTL` | on | See [Anthropic TTL upgrade](./how-it-works.md#8-anthropic-ttl-upgrade-cache-ttlts) |
| `OPENCODE_CTX_TTL_VALUE` | `1h` | Any value accepted by Anthropic's `ephemeral.ttl` field |

Anthropic-only. The module short-circuits on OpenAI requests.

## Caveman (opt-in output style)

Disabled by default. Three escalating levels:

| Value | Behavior |
|---|---|
| unset | No addendum appended. |
| `lite` | Ask the model for short answers with minimal preamble. |
| `full` | Ask for terse, enumerated, no-filler responses. |
| `ultra` | Terse to the point of telegraphic. Useful only for very specific throughput tasks. |

```bash
# most users who opt in
export OPENCODE_CTX_CAVEMAN=lite
```

This is the only module that affects completion-side tokens.

## Debug + dump

| Var | Effect |
|---|---|
| `OPENCODE_CTX_DEBUG=1` | Emit `[ctx-plugin]` lines on stderr, including the `active: …` banner and per-stage byte deltas. |
| `OPENCODE_CTX_DUMP=<path>` | When the incoming system prompt exceeds ~10k chars, write the raw prompt to `<path>` for inspection. Useful when diagnosing why trim savings look low. |

## Worked example: verify a specific module is responsible for a change

```bash
# baseline
OPENCODE_CTX_PLUGIN=0 opencode run --format json -- "…"

# plugin on, but cache TTL disabled
OPENCODE_CTX_DEBUG=1 OPENCODE_CTX_TTL=0 opencode run --format json -- "…"

# plugin on, but history trim disabled
OPENCODE_CTX_DEBUG=1 OPENCODE_CTX_MSGS=0 opencode run --format json -- "…"
```

Comparing the three reveals how much each module contributes on *your* workload.

## See also

- [How it works](./how-it-works.md) — what each toggle actually does
- [Troubleshooting](./troubleshooting.md) — when toggling doesn't seem to change anything
