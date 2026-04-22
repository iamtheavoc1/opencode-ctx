# Benchmarks

This page is the long form of the numbers the top-level README quotes. Raw CSVs live in [`../bench/`](../bench/).

## Headline results

| Scenario | Provider / model | Tokens off → on | Δ |
|---|---|---:|---:|
| Single-turn | Anthropic `haiku-4-5` | 25,898 → 15,601 | **−39.8%** |
| 5-turn plain chat | Anthropic `haiku-4-5` | 129,747 → 78,264 | **−39.7%** |
| 10-turn tool-heavy | Anthropic `haiku-4-5` | 334,152 → 198,284 | **−40.7%** |
| Single-turn (Opus) | Anthropic `opus-4-7` | 36,572 → 21,781 | **−40.4%** |
| Single-turn (3-run avg) | OpenAI `gpt-5.4-mini` | 19,402 → 10,620 | **−45.3%** |
| 5-turn tool-heavy | OpenAI `gpt-5.4-mini` | 112,683 → 56,740 | **−49.6%** |

All numbers are prompt-side tokens reported by the provider in the response envelope — not estimates.

## Coverage

The published dataset consists of **84 successful live benchmark requests/turns**:

| Bucket | Runs |
|---|---:|
| Anthropic single-turn | 6 |
| Anthropic 5-turn plain chat | 10 |
| Anthropic 5-turn tool-heavy | 10 |
| Anthropic expanded scenarios | 42 |
| OpenAI single-turn | 6 |
| OpenAI 5-turn tool-heavy | 10 |
| **Total** | **84** |

Each bucket has its own CSV under `bench/`. All savings percentages are computed per run, then averaged — no cherry-picked single points.

## Methodology

For every scenario, each run is executed twice with identical prompts and identical opencode version:

1. **OFF:** `OPENCODE_CTX_PLUGIN=0 opencode run --format json -- <prompt>`
2. **ON:** `OPENCODE_CTX_DEBUG=1 opencode run --format json -- <prompt>` (all defaults on)

The JSON envelope includes prompt-side token counts from the provider. The harness captures those counts directly — it never estimates from character length.

Each multi-turn scenario uses a fixed prompt sequence so the ON and OFF runs see byte-identical user input. The only variable between runs is the plugin.

## Cost

Cost figures in the top-level README derive from these measured token reductions multiplied by provider list prices at the time of the run. Specifically:

- **Measured** rows: Anthropic `haiku-4-5`, Anthropic `opus-4-7`, OpenAI `gpt-5.4-mini`.
- **Estimated** rows: OpenAI `gpt-5.4` (full) — extrapolated linearly from the measured `gpt-5.4-mini` reduction. Labeled as such in the README table.

Estimates are included because they are the most common reader question ("does this work on the big model?"), but they are not evidence.

## Reproducing

You will need live API access to the provider you want to benchmark.

### Anthropic

```bash
# single-turn matrix
bash bench/run-matrix.sh

# 5-turn plain chat
bash bench/run-multiturn.sh

# 5-turn tool-heavy
bash bench/run-tools.sh

# expanded scenarios (longer, more variety)
python bench/run-more-scenarios.py
```

Each script writes a CSV (see [bench/README.md](../bench/README.md) for file names) and prints the ON/OFF delta. Runs are sequential; expect several minutes per script.

### OpenAI

```bash
python bench/run-openai-bench.py
```

This writes `openai-single-results.csv` and `openai-tools-results.csv`. It expects `openai/gpt-5.4-mini` to be the active opencode provider.

## What these benchmarks don't prove

- They do not measure **model output quality**. See [quality](./quality.md) for that story.
- They do not measure **latency**. Reductions in prompt size do shorten first-token latency a little, but that is not the point of this plugin.
- They do not measure **cache hit rates** — the Anthropic TTL upgrade helps here, but we have not published a dedicated cache-hit benchmark yet.
- They do not prove savings on models not listed. In particular, `openai/gpt-5.4` (full) has **no** direct benchmark. Its row in cost tables is an estimate.

If you need a measurement on a model not listed here, the scripts above are the starting point.
