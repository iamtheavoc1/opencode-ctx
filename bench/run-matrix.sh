#!/usr/bin/env bash
set -u
cd /tmp/octx-bench
rm -f matrix-*.jsonl matrix-*.err results.csv

PROMPT="Reply with exactly: OK"
ITERS=3

echo "provider,model,plugin,iter,input,output,reasoning,cache_write,cache_read,total,cost" > results.csv

run_one() {
  local provider="$1" model="$2" plugin="$3" iter="$4"
  local tag="${provider}-${plugin}-${iter}"
  local out="matrix-${tag}.jsonl"
  local err="matrix-${tag}.err"

  OPENCODE_CTX_PLUGIN="$plugin" opencode run --format json --model "${provider}/${model}" -- "$PROMPT" > "$out" 2> "$err"

  local line
  line=$(grep '"step_finish"' "$out" | tail -1)
  if [ -z "$line" ]; then
    echo "${provider},${model},${plugin},${iter},ERROR,ERROR,ERROR,ERROR,ERROR,ERROR,ERROR" >> results.csv
    echo "  [$tag] NO step_finish"
    return
  fi
  local input output reasoning cw cr total cost
  input=$(echo "$line" | jq -r '.part.tokens.input // 0')
  output=$(echo "$line" | jq -r '.part.tokens.output // 0')
  reasoning=$(echo "$line" | jq -r '.part.tokens.reasoning // 0')
  cw=$(echo "$line" | jq -r '.part.tokens.cache.write // 0')
  cr=$(echo "$line" | jq -r '.part.tokens.cache.read // 0')
  total=$((input + output + reasoning + cw + cr))
  cost=$(echo "$line" | jq -r '.part.cost // 0')

  echo "${provider},${model},${plugin},${iter},${input},${output},${reasoning},${cw},${cr},${total},${cost}" >> results.csv
  echo "  [$tag] in=$input out=$output reason=$reasoning cw=$cw cr=$cr cost=$cost"
}

echo "=== Anthropic (claude-haiku-4-5) ==="
for plugin in 0 1; do
  for i in $(seq 1 $ITERS); do
    run_one anthropic claude-haiku-4-5 "$plugin" "$i"
  done
done

echo "=== OpenAI (gpt-5.4-mini) ==="
for plugin in 0 1; do
  for i in $(seq 1 $ITERS); do
    run_one openai gpt-5.4-mini "$plugin" "$i"
  done
done

echo ""
echo "=== RESULTS ==="
column -t -s, results.csv
