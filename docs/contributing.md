# Contributing

Contributions welcome. This page is the minimum you need to know before opening a PR.

## Repo layout

```
.
├── README.md              Public-facing landing page
├── package.json           Name, version, description
├── src/                   Plugin source (TypeScript, no build step required by opencode)
├── bench/                 Benchmark scripts + raw result CSVs
└── docs/                  This documentation folder
```

## Local development

opencode loads the plugin from `~/.local/share/opencode-context-plugin`. If you cloned elsewhere, symlink:

```bash
ln -s "$PWD" "$HOME/.local/share/opencode-context-plugin"
```

There is no build step. opencode compiles the TypeScript on first load.

## Type-check before every commit

```bash
bunx tsc --noEmit
```

Must be clean. The repo does not currently enforce this via CI; treat clean `tsc` as a PR-merge prerequisite.

## Running the benches locally

All bench scripts expect an active opencode session (auth, model selection).

```bash
# Anthropic single-turn matrix (~5 min)
bash bench/run-matrix.sh

# Anthropic 5-turn plain chat
bash bench/run-multiturn.sh

# Anthropic 10-turn tool-heavy
bash bench/run-tools.sh

# Expanded Anthropic scenarios
python bench/run-more-scenarios.py

# OpenAI gpt-5.4-mini
python bench/run-openai-bench.py
```

Each script writes a CSV next to itself. Check the CSV in to publish new numbers; update the top-level README and [docs/benchmarks.md](./benchmarks.md) in the same commit.

## Adding a new module

Checklist. Anything missed here tends to regress the cache-hit rate or break one provider.

1. **Single-purpose.** One transform per module. If you find yourself adding two, split them.
2. **Deterministic.** Given the same input + env, produce byte-identical output. No timestamps, no random IDs.
3. **Kill switch.** Gate on a new `OPENCODE_CTX_<NAME>` env var. Default on, `0` disables.
4. **Fail-safe.** Wrap every mutation in `try/catch`. On error, log via the plugin's `log(…)` helper and return input unchanged. Never raise out of a hook.
5. **Respect provider shape.** Read [architecture → provider-shape constraints](./architecture.md#provider-shape-constraints). The two most common PR rejections are new cache breakpoints on Anthropic and mutation of tool `parameters.*` on OpenAI.
6. **Register in `index.ts`.** Wire it into the correct hook at the correct position. See [hook ordering guarantees](./architecture.md#hook-ordering-guarantees).
7. **Update the active banner.** Add your module's name + on/off state to the `[ctx-plugin] active: …` line.
8. **Document.**
   - Add a row to `docs/how-it-works.md` execution-order table and a section below.
   - Add rows to `docs/configuration.md` for the new env var(s).
   - If behavior-affecting, update `docs/quality.md` to say how quality was verified for this module.
9. **Benchmark.** At least one before/after ON/OFF run with your module isolated. Attach numbers to the PR.

## Removing or weakening a module

If the benches show a module's saving has decayed (provider changed upstream, opencode changed upstream), cut it. The reasoning-trim removal in the v0.5.0 cycle is the template:

- Delete source file.
- Strip wiring from `index.ts`.
- Strip toggle from `docs/configuration.md` and the banner section in `docs/how-it-works.md`.
- Leave research artifacts in `bench/` if they are informative; mark them as research-only in their README.
- Commit message explains **why** (measurement, not preference).

## Commit hygiene

- Small, focused commits. "add OpenAI benchmark receipts" and "rewrite docs" are separate commits.
- Commit messages state the *effect*, not the diff.
- If the commit changes published numbers, the body of the commit message must include before / after.

## Licensing

MIT. Contributions are assumed to be under the same license unless stated otherwise in the PR.
