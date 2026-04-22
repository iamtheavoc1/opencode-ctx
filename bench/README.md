# Bench artifacts

This folder contains the scripts and raw CSV outputs behind the stable README claims.

## Top-line results

- **Single-turn Anthropic example:** `25,898 -> 15,601` (**-39.8%**)
- **5-turn normal chat session:** `129,747 -> 78,264` (**-39.7%**)
- **10-turn tool-heavy session:** `334,152 -> 198,284` (**-40.7%**)

## What each file is for

- `run-matrix.sh`: single-turn 3-iteration matrix for `anthropic/claude-haiku-4-5` and `openai/gpt-5.4-mini`
- `run-multiturn.sh`: 5-turn plain-chat benchmark on `anthropic/claude-haiku-4-5`
- `run-tools.sh`: 5-turn tool-heavy benchmark on `anthropic/claude-haiku-4-5`
- `run-more-scenarios.py`: expanded 10-turn scenarios, `anthropic/claude-opus-4-7` sanity check, and OpenAI attempts
- `results.csv`: raw single-turn output
- `multi-results.csv`: raw 5-turn plain-chat output
- `tools-results.csv`: raw 5-turn tool-heavy output
- `more-results.csv`: raw 10-turn/scenario output
- `run-quality-fixtures.ts`: quality/research fixture from the reasoning-trim investigation
- `run-quality-live.py`: live quality/research harness from the reasoning-trim investigation
- `quality-live-results.csv`: latest quality/research result artifact

## Notes

- OpenAI requests failed live with `401 token_invalidated`; those failed attempts are recorded in `results.csv` and `more-results.csv`.
- The 200k/1M context-window projections in the top-level README are derived from prompt-side growth rates in `more-results.csv`.
- The quality harness files are kept as research artifacts. They are **not** required for the stable plugin's ~40% savings story.
