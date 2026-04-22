# Getting started

This page gets you from "I have opencode installed" to "the plugin is proven active on my machine" in about 2 minutes.

## Prerequisites

- [opencode](https://opencode.ai) installed and working
- `bun` or `node` available on `PATH` (opencode ships with bun; this plugin has no extra runtime deps)
- Git

Tested on macOS and Linux. No Windows support has been verified.

## Install

opencode loads plugins from `~/.local/share/opencode-context-plugin` (Linux / macOS) or the platform equivalent. Clone there:

```bash
# macOS / Linux
mkdir -p "$HOME/.local/share"
git clone https://github.com/iamtheavoc1/opencode-ctx "$HOME/.local/share/opencode-context-plugin"
```

No build step is required. opencode compiles the plugin on first load.

## Verify it is active

Start any opencode session with debug logging:

```bash
OPENCODE_CTX_DEBUG=1 opencode run --format json -- "Reply with exactly: OK"
```

You should see a line like this on stderr:

```
[ctx-plugin] active: trim=on omoa=on compact=on msgs=on clean=on ttl=on caveman=off overrides=22
```

If you see that line, the plugin is compressing every request. If you don't, see [troubleshooting](./troubleshooting.md#the-plugin-does-not-seem-to-run).

## 2-minute quickstart

Once active, there is nothing else to do for the default savings story:

- Anthropic sessions: expect about **38–41%** fewer prompt-side tokens on long tool-heavy sessions
- OpenAI `gpt-5.4-mini`: expect about **45–50%** fewer prompt-side tokens

Optional opt-ins:

```bash
# terse "caveman" output style (fewer completion tokens, too)
export OPENCODE_CTX_CAVEMAN=lite

# keep more recent tool outputs intact if long sessions feel amnesiac
export OPENCODE_CTX_MSGS_KEEP=5
```

## Disable quickly

If anything feels off, the plugin has a kill switch:

```bash
OPENCODE_CTX_PLUGIN=0 opencode run ...
```

That bypasses every transform. Compare that run to a default run to attribute any behavior change to the plugin.

## Next

- [How it works](./how-it-works.md) for the module-by-module walk-through
- [Configuration](./configuration.md) for every knob
- [Troubleshooting](./troubleshooting.md) if something looks wrong
