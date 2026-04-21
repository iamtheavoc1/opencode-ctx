#!/usr/bin/env bash
set -u
cd /tmp/octx-bench
rm -f tools-*.jsonl tools-*.err tools-results.csv

MODEL="anthropic/claude-haiku-4-5"
PROMPTS=(
  "Read /tmp/octx-bench/run-matrix.sh and tell me the total line count"
  "Read /tmp/octx-bench/run-multiturn.sh and tell me its line count"
  "Grep for 'jq' in /tmp/octx-bench/run-matrix.sh and count matches"
  "List all files in /tmp/octx-bench ending with .jsonl using ls"
  "In one sentence: what files have we looked at so far?"
)

echo "plugin,turn,input,output,reasoning,cache_write,cache_read,total,cost" > tools-results.csv

run_turn() {
  local plugin="$1" turn="$2" prompt="$3" session="$4"
  local tag="plugin${plugin}-turn${turn}"
  local out="tools-${tag}.jsonl"
  local err="tools-${tag}.err"

  local session_arg=""
  [ -n "$session" ] && session_arg="--session $session"

  OPENCODE_CTX_PLUGIN="$plugin" opencode run $session_arg --dangerously-skip-permissions --format json --model "$MODEL" -- "$prompt" > "$out" 2> "$err"

  local finish_line new_session input output reasoning cw cr total cost
  finish_line=$(grep '"step_finish"' "$out" | tail -1)
  new_session=$(echo "$finish_line" | jq -r '.sessionID // empty')
  input=$(echo "$finish_line" | jq -r '.part.tokens.input // 0')
  output=$(echo "$finish_line" | jq -r '.part.tokens.output // 0')
  reasoning=$(echo "$finish_line" | jq -r '.part.tokens.reasoning // 0')
  cw=$(echo "$finish_line" | jq -r '.part.tokens.cache.write // 0')
  cr=$(echo "$finish_line" | jq -r '.part.tokens.cache.read // 0')
  total=$(echo "$finish_line" | jq -r '.part.tokens.total // 0')
  cost=$(echo "$finish_line" | jq -r '.part.cost // 0')

  echo "${plugin},${turn},${input},${output},${reasoning},${cw},${cr},${total},${cost}" >> tools-results.csv
  local tool_count
  tool_count=$(grep -c '"tool"' "$out" 2>/dev/null || echo 0)
  echo "  [$tag] session=${new_session:0:24} in=$input out=$output cw=$cw cr=$cr total=$total tools=$tool_count"
  echo "$new_session"
}

for plugin in 0 1; do
  echo "=== Plugin=$plugin (tool-heavy) ==="
  session=""
  for i in 0 1 2 3 4; do
    turn=$((i + 1))
    new_sess=$(run_turn "$plugin" "$turn" "${PROMPTS[$i]}" "$session" | tail -1)
    session="$new_sess"
  done
done

echo ""
echo "=== TOOL-HEAVY RESULTS ==="
column -t -s, tools-results.csv
