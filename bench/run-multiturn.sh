#!/usr/bin/env bash
set -u
cd /tmp/octx-bench
rm -f multi-*.jsonl multi-*.err multi-results.csv

MODEL="anthropic/claude-haiku-4-5"
PROMPTS=(
  "Count to 3"
  "Now count to 5"
  "What number did you start with?"
  "List odd numbers 1-10"
  "Summarize this conversation in one sentence"
)

echo "plugin,turn,session_id,input,output,reasoning,cache_write,cache_read,total,cost" > multi-results.csv

run_turn() {
  local plugin="$1" turn="$2" prompt="$3" session="$4"
  local tag="plugin${plugin}-turn${turn}"
  local out="multi-${tag}.jsonl"
  local err="multi-${tag}.err"

  local session_arg=""
  [ -n "$session" ] && session_arg="--session $session"

  OPENCODE_CTX_PLUGIN="$plugin" opencode run $session_arg --format json --model "$MODEL" -- "$prompt" > "$out" 2> "$err"

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

  echo "${plugin},${turn},${new_session},${input},${output},${reasoning},${cw},${cr},${total},${cost}" >> multi-results.csv
  echo "  [$tag] session=${new_session:0:20} in=$input out=$output cw=$cw cr=$cr total=$total"
  echo "$new_session"
}

for plugin in 0 1; do
  echo "=== Plugin=$plugin ==="
  session=""
  for i in 0 1 2 3 4; do
    turn=$((i + 1))
    new_sess=$(run_turn "$plugin" "$turn" "${PROMPTS[$i]}" "$session" | tail -1)
    session="$new_sess"
  done
done

echo ""
echo "=== MULTI-TURN RESULTS ==="
column -t -s, multi-results.csv
