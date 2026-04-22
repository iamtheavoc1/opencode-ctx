# Bench artifacts

This folder contains the scripts and raw CSV outputs behind the README claims.

## Top-line results

- **Anthropic single-turn example:** `25,898 -> 15,601` (**-39.8%**)
- **Anthropic 5-turn normal chat session:** `129,747 -> 78,264` (**-39.7%**)
- **Anthropic 10-turn tool-heavy session:** `334,152 -> 198,284` (**-40.7%**)
- **OpenAI `gpt-5.4-mini` single-turn average:** `19,402 -> 10,620` (**-45.3%**)
- **OpenAI `gpt-5.4-mini` 5-turn tool-heavy session:** `112,683 -> 56,740` (**-49.6%**)

## Coverage counts

Published successful benchmark requests/turns:

- 6 Anthropic single-turn runs
- 10 Anthropic 5-turn plain-chat turns
- 10 Anthropic 5-turn tool-heavy turns
- 42 additional Anthropic scenario runs from the expanded benchmark
- 6 OpenAI single-turn runs
- 10 OpenAI 5-turn tool-heavy turns

That is **84 successful live benchmark requests/turns** in the published artifacts.

## What each file is for

- `run-matrix.sh`: Anthropic single-turn matrix
- `run-multiturn.sh`: Anthropic 5-turn plain-chat benchmark
- `run-tools.sh`: Anthropic 5-turn tool-heavy benchmark
- `run-more-scenarios.py`: expanded Anthropic scenarios and historical OpenAI attempts
- `results.csv`: raw Anthropic single-turn output
- `multi-results.csv`: raw Anthropic 5-turn plain-chat output
- `tools-results.csv`: raw Anthropic 5-turn tool-heavy output
- `more-results.csv`: raw expanded scenario output
- `run-openai-bench.py`: published OpenAI `gpt-5.4-mini` benchmark runner
- `openai-single-results.csv`: raw OpenAI 3-run single-turn matrix
- `openai-tools-results.csv`: raw OpenAI 5-turn tool-heavy session results
- `run-quality-fixtures.ts`: research fixture from the earlier reasoning-trim investigation
- `run-quality-live.py`: research harness from the earlier reasoning-trim investigation
- `quality-live-results.csv`: latest research result artifact

## Notes

- Earlier OpenAI attempts failed with `401 token_invalidated`; the current `gpt-5.4-mini` benchmark now succeeds and the new raw results are included here. The old failed attempts remain in `results.csv` and `more-results.csv` as historical artifacts.
- The 200k/1M context-window projections in the top-level README are derived from prompt-side growth rates in `more-results.csv`.
- The quality/research harness files are kept as research artifacts. They are **not** required for the stable plugin's savings story.
