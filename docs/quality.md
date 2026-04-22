# Quality

The headline of this plugin is "fewer tokens." The second question everyone asks is: *"but does the model still do the job?"* This page is the honest answer to that question.

## What "quality" means here

For a compression plugin, quality is not "did the model write better prose?" — that depends on the model. Quality here means:

1. **Shape fidelity.** The model still receives every tool, every parameter, every user message, every assistant message that actually happened. No silent deletions.
2. **Tool-calling fidelity.** The model still picks the right tool with the right arguments. The plugin must not cause tool-choice regressions.
3. **Answer fidelity.** For a given task, the answer the model produces under the plugin is equivalent (not necessarily identical) to the answer without it. Different wording is fine; different correctness is not.

## What was checked

All 84 benchmark runs were sanity-checked for the three quality properties above:

- Every ON run produced a complete response (no truncation, no invalid tool calls).
- Every ON run that required a specific tool used the right tool.
- Every ON run's final answer matched the OFF run's final answer on correctness. Wording varies.

That is the live evidence.

## What was *not* checked

Being explicit about the limits of the claim:

- **There is no automated semantic diff** between ON and OFF answers. Equivalence was verified by reading every pair. That is fine for 84 runs; it will not scale forever.
- **Reasoning-style regression** is not covered. The stable v0.5.0 runtime does not touch reasoning content at all — the reasoning-trim module that existed in earlier versions was removed precisely because its regressions were harder to bound.
- **Long-horizon memory regression.** Aggressive `OPENCODE_CTX_MSGS_*` overrides *can* cause the model to "forget" older tool output. That is the intended trade-off and is why defaults are conservative. If you notice forgetfulness, raise `OPENCODE_CTX_MSGS_KEEP` and `OPENCODE_CTX_MSGS_CAP`.
- **Model-specific behavior.** Models not benchmarked here may react differently. Especially: very small local models may be more sensitive to the denser system prompt.

## Research harness

`bench/run-quality-fixtures.ts`, `bench/run-quality-live.py`, and `bench/quality-live-results.csv` are kept in the repo as research artifacts from an earlier quality sweep. They are **not** part of the stable quality claim, because:

- The reasoning-trim module they were built to validate is no longer in the runtime.
- The harness evaluates semantic equivalence with an LLM grader, which is itself model-dependent.

They are useful for future work. They are not evidence.

## If you suspect a quality regression

Run the specific scenario both ways:

```bash
# baseline
OPENCODE_CTX_PLUGIN=0 opencode run --format json -- "<your prompt>"

# plugin on
OPENCODE_CTX_DEBUG=1 opencode run --format json -- "<your prompt>"
```

If the ON run is materially worse, narrow down which module is responsible by disabling them one at a time:

```bash
OPENCODE_CTX_MSGS=0 opencode run --format json -- "<your prompt>"
OPENCODE_CTX_TRIM=0 opencode run --format json -- "<your prompt>"
OPENCODE_CTX_OMOA=0 opencode run --format json -- "<your prompt>"
```

The first of those to restore the baseline is the culprit. Please open an issue with both transcripts attached.

## Summary

- Token savings are measured. The evidence is [`../bench/`](../bench/).
- Quality is **spot-checked** across 84 live runs and holds. It is not exhaustively proven, and this page states exactly what "holds" means.
- If you are risk-averse, run the plugin with `OPENCODE_CTX_MSGS=0` first; that keeps the biggest-impact module off while still getting the system + tool-description savings.
