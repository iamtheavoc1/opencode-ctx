# Bench artifacts

This folder contains the scripts and CSV outputs used for the 2026-04-21 benchmark write-up in the top-level README.

Files:
- `run-matrix.sh`: single-turn 3-iteration matrix for `anthropic/claude-haiku-4-5` and `openai/gpt-5.4-mini`
- `run-multiturn.sh`: 5-turn plain chat benchmark on `anthropic/claude-haiku-4-5`
- `run-tools.sh`: 5-turn tool-heavy benchmark on `anthropic/claude-haiku-4-5`
- `run-more-scenarios.py`: expanded 10-turn scenarios, `anthropic/claude-opus-4-7` sanity check, and OpenAI attempts
- `results.csv`: raw single-turn output
- `multi-results.csv`: raw 5-turn plain-chat output
- `tools-results.csv`: raw 5-turn tool-heavy output
- `more-results.csv`: raw 10-turn/scenario output

Notes:
- OpenAI requests failed live with `401 token_invalidated`; those failed attempts are recorded in `results.csv` and `more-results.csv`.
- The 200k/1M context-window projections in the top-level README are derived from the prompt-side growth rates in `more-results.csv`.
