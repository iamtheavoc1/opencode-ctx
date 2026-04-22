# Troubleshooting

Every section below is a failure mode we have actually seen, the signal that distinguishes it, and the fix.

## The plugin does not seem to run

**Signal.** You set `OPENCODE_CTX_DEBUG=1` but never see a `[ctx-plugin] active: …` line.

**Checks, in order:**

1. Confirm the clone location. opencode looks in `~/.local/share/opencode-context-plugin` on macOS / Linux.
   ```bash
   ls ~/.local/share/opencode-context-plugin/src/index.ts
   ```
   If that path does not exist, clone there.
2. Confirm the master switch is not off.
   ```bash
   echo "$OPENCODE_CTX_PLUGIN"
   ```
   Must be unset or anything other than `0`.
3. Confirm opencode itself sees the plugin. Run with opencode's own debug on:
   ```bash
   OPENCODE_DEBUG=1 OPENCODE_CTX_DEBUG=1 opencode run --format json -- "hi"
   ```
   opencode will log the plugins it loaded. If `opencode-context-plugin` is absent, opencode is not looking where you cloned.

## I see `[ctx-plugin] active:` but no reduction in my costs

**Signal.** Plugin is active. Savings look minimal.

**Most common causes:**

- Your sessions are short. The single-turn saving is ~25–30%. The 40–50% numbers come from long, tool-heavy sessions where history trim dominates.
- You are using a model the plugin does not specifically optimize for. The baseline savings (system + tool-description trim) still apply; the cache-TTL upgrade does not apply on OpenAI.
- `OPENCODE_CTX_MSGS=0` is set somewhere in your environment. Check:
  ```bash
  env | grep OPENCODE_CTX
  ```

Then run a targeted before/after:

```bash
OPENCODE_CTX_PLUGIN=0 opencode run --format json -- "<prompt>" | jq '.metadata.tokens'
opencode run --format json -- "<prompt>" | jq '.metadata.tokens'
```

The delta between those is your *actual* saving on your workload.

## Anthropic returns 400 on the first request

**Signal.** The first message fails immediately with an Anthropic 400, often mentioning `cache_control` or breakpoint count.

**Cause.** A third-party tool, proxy, or another plugin is also inserting cache breakpoints, pushing the total over Anthropic's limit.

**Fix.** Disable this plugin's TTL upgrade temporarily and see if the 400 persists:

```bash
OPENCODE_CTX_TTL=0 opencode run ...
```

- 400 goes away ⇒ something else in your stack is also adding breakpoints. Remove it, or keep `OPENCODE_CTX_TTL=0`.
- 400 persists ⇒ not caused by this plugin.

## OpenAI returns `401 token_invalidated`

**Signal.** OpenAI requests fail with `401 token_invalidated`.

**Cause.** Stale OAuth token cached by opencode. Unrelated to this plugin.

**Fix.** Re-authenticate with opencode. A fresh `opencode` login resolves it.

## The model feels amnesiac on long sessions

**Signal.** After 8+ tool-heavy turns, the model asks "what was that file again?" about files you read earlier.

**Cause.** Default `OPENCODE_CTX_MSGS_*` settings are trimming older tool outputs aggressively enough that the detail the model needed fell into the trimmed middle.

**Fix.** Loosen the history trim:

```bash
export OPENCODE_CTX_MSGS_KEEP=5
export OPENCODE_CTX_MSGS_CAP=2000
export OPENCODE_CTX_MSGS_HEAD=1000
export OPENCODE_CTX_MSGS_TAIL=500
```

Or disable that module entirely and keep all the other savings:

```bash
export OPENCODE_CTX_MSGS=0
```

You will lose roughly half the long-session saving but keep the baseline ~25% system+tool-description saving plus the cache-TTL upgrade.

## Something looks wrong and I want to bisect

Toggle one module at a time, baseline first:

```bash
OPENCODE_CTX_PLUGIN=0  opencode run ...   # total bypass
OPENCODE_CTX_MSGS=0    opencode run ...   # everything except history trim
OPENCODE_CTX_TRIM=0    opencode run ...   # everything except system + tool trim
OPENCODE_CTX_OMOA=0    opencode run ...   # everything except oh-my-openagent trim
OPENCODE_CTX_COMPACT=0 opencode run ...   # everything except compaction prompt swap
OPENCODE_CTX_CLEAN=0   opencode run ...   # everything except ANSI cleaner
OPENCODE_CTX_TTL=0     opencode run ...   # everything except cache TTL upgrade
```

The first run that restores the behavior you want identifies the responsible module. That narrows a bug report from "your plugin broke something" to "your plugin's history trim broke something," which is something we can act on.

## I want to save the exact system prompt opencode is sending

```bash
OPENCODE_CTX_DUMP=/tmp/opencode-system-prompt.txt opencode run ...
cat /tmp/opencode-system-prompt.txt
```

When the incoming system prompt is larger than ~10k characters, the plugin writes the raw pre-trim prompt to that path. Useful when trim looks less effective than expected.

## See also

- [Configuration](./configuration.md) — every toggle with defaults
- [How it works](./how-it-works.md) — what each module touches
- [Quality](./quality.md) — how to verify there is no regression on your workload
