import csv
import json
import os
import subprocess
from pathlib import Path

bench = Path("/tmp/octx-bench")
bench.mkdir(parents=True, exist_ok=True)
rows = []

chat10 = [
    "Count to 3",
    "Now count to 5",
    "What number did you start with?",
    "List odd numbers 1-10",
    "Summarize this conversation in one sentence",
    "What was the second instruction?",
    "Reply with exactly: memory",
    "What word did I ask for?",
    "Reply with exactly: end",
    "What two special words did I ask you for?",
]

tools10 = [
    "Read /tmp/octx-bench/run-matrix.sh and tell me the total line count",
    "Read /tmp/octx-bench/run-multiturn.sh and tell me the total line count",
    "Grep for jq in /tmp/octx-bench/run-matrix.sh and count matches",
    "List all files in /tmp/octx-bench ending with .jsonl using ls",
    "In one sentence: what files have we looked at so far?",
    "Read /tmp/octx-bench/tools-results.csv and tell me the number of data rows",
    "Read /tmp/octx-bench/multi-results.csv and tell me the number of data rows",
    "Read /Users/goncalo/.local/share/opencode-context-plugin/README.md and tell me the total line count",
    "List all files in /tmp/octx-bench ending with .err using ls",
    "In one sentence: summarize every file or report we touched so far",
]

scenarios = [
    {"name": "haiku-chat10", "model": "anthropic/claude-haiku-4-5", "plugin_values": [0, 1], "prompts": chat10, "tools": False},
    {"name": "haiku-tools10", "model": "anthropic/claude-haiku-4-5", "plugin_values": [0, 1], "prompts": tools10, "tools": True},
    {"name": "opus-single", "model": "anthropic/claude-opus-4-7", "plugin_values": [0, 1], "prompts": ["Reply with exactly: OK"], "tools": False},
    {"name": "openai-gpt54mini-single", "model": "openai/gpt-5.4-mini", "plugin_values": [0], "prompts": ["Reply with exactly: OK"], "tools": False},
    {"name": "openai-gpt54-single", "model": "openai/gpt-5.4", "plugin_values": [0], "prompts": ["Reply with exactly: OK"], "tools": False},
]

for scenario in scenarios:
    for plugin in scenario["plugin_values"]:
        session = ""
        for index, prompt in enumerate(scenario["prompts"], start=1):
            stem = f'{scenario["name"]}-p{plugin}-t{index}'
            out = bench / f'{stem}.jsonl'
            err = bench / f'{stem}.err'
            cmd = ["opencode", "run"]
            if session:
                cmd += ["--session", session]
            if scenario["tools"]:
                cmd += ["--dangerously-skip-permissions"]
            cmd += ["--format", "json", "--model", scenario["model"], "--", prompt]
            env = dict(os.environ)
            env["OPENCODE_CTX_PLUGIN"] = str(plugin)
            result = subprocess.run(cmd, cwd=str(bench), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            out.write_text(result.stdout)
            err.write_text(result.stderr)
            step_finish = None
            error = None
            for line in result.stdout.splitlines():
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "step_finish":
                    step_finish = data
                if data.get("type") == "error":
                    error = data
            row = {
                "scenario": scenario["name"],
                "model": scenario["model"],
                "plugin": plugin,
                "turn": index,
                "session_id": "",
                "input": "",
                "output": "",
                "reasoning": "",
                "cache_write": "",
                "cache_read": "",
                "total": "",
                "cost": "",
                "status": "error" if error else "ok" if step_finish else "missing",
                "error_message": "",
            }
            if error:
                row["session_id"] = error.get("sessionID", "")
                row["error_message"] = error.get("error", {}).get("data", {}).get("message", error.get("error", {}).get("name", "unknown error"))
            if step_finish:
                session = step_finish.get("sessionID", session)
                tokens = step_finish.get("part", {}).get("tokens", {})
                cache = tokens.get("cache", {})
                row["session_id"] = session
                row["input"] = tokens.get("input", 0)
                row["output"] = tokens.get("output", 0)
                row["reasoning"] = tokens.get("reasoning", 0)
                row["cache_write"] = cache.get("write", 0)
                row["cache_read"] = cache.get("read", 0)
                row["total"] = tokens.get("total", 0)
                row["cost"] = step_finish.get("part", {}).get("cost", 0)
            rows.append(row)
            label = row["status"]
            total = row["total"] or "-"
            print(f'{scenario["name"]} plugin={plugin} turn={index} status={label} total={total}')
            if error:
                break

with (bench / "more-results.csv").open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=[
        "scenario", "model", "plugin", "turn", "session_id", "input", "output", "reasoning", "cache_write", "cache_read", "total", "cost", "status", "error_message"
    ])
    writer.writeheader()
    writer.writerows(rows)
