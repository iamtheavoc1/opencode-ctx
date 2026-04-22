# opencode-ctx documentation

This folder is the long-form documentation for `opencode-ctx`. The top-level [`README.md`](../README.md) is the marketing / TL;DR page. These pages are the reference.

## Start here

- [Getting started](./getting-started.md) — install, verify it is active, 2-minute quickstart
- [How it works](./how-it-works.md) — what each module does, in execution order
- [Configuration](./configuration.md) — every environment variable, with defaults and examples

## Evidence

- [Benchmarks](./benchmarks.md) — measured savings on Anthropic and OpenAI, methodology, how to reproduce
- [Quality](./quality.md) — what "no quality regression" actually means for this plugin

## Operations

- [Troubleshooting](./troubleshooting.md) — common issues, how to disable safely, how to check it is running
- [Architecture](./architecture.md) — hook order, provider-shape constraints, cache-safety invariants

## Contributing

- [Contributing](./contributing.md) — repo layout, type-check, run the benches, add a module

---

## Conventions used in these docs

- **"Prompt-side tokens"** = tokens opencode sends *to* the model on each request. This is what the plugin shrinks. Completion-side tokens are not affected.
- **"Measured"** numbers come from live `opencode run --format json` calls whose receipts live in [`../bench/`](../bench/).
- **"Estimated"** numbers are linear extrapolations from a single measured point and are labeled as such in tables.
- No emojis, no marketing fluff — these pages are for engineers deciding whether to trust the plugin.
