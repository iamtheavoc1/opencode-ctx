import csv
import json
import os
import subprocess
from pathlib import Path

bench = Path('/tmp/octx-bench')
bench.mkdir(parents=True, exist_ok=True)
model = 'openai/gpt-5.4-mini'

single_prompt = 'Reply with exactly: OK'
tool_prompts = [
    'Read /Users/goncalo/.local/share/opencode-context-plugin/README.md and reply with exactly the first heading line.',
    'Read /Users/goncalo/.local/share/opencode-context-plugin/src/messages-trim.ts and reply with exactly the total line count as a number.',
    'Grep for "tool" in /Users/goncalo/.local/share/opencode-context-plugin/src/messages-trim.ts and reply with exactly the match count as a number.',
    'List all files in /Users/goncalo/.local/share/opencode-context-plugin/src using ls and reply with exactly the number of entries.',
    'In one word reply exactly: DONE',
]

def parse_finish(text):
    step = None
    for line in text.splitlines():
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if data.get('type') == 'step_finish':
            step = data
    return step

def run_once(plugin, prompt, session='', allow_tools=False, tag='run'):
    cmd = ['opencode', 'run']
    if session:
        cmd += ['--session', session]
    if allow_tools:
        cmd.append('--dangerously-skip-permissions')
    cmd += ['--format', 'json', '--model', model, '--', prompt]
    env = dict(os.environ)
    env['OPENCODE_CTX_PLUGIN'] = str(plugin)
    env['OPENCODE_CTX_DEBUG'] = '1'
    proc = subprocess.run(cmd, cwd=str(bench), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out = bench / f'{tag}.jsonl'
    err = bench / f'{tag}.err'
    out.write_text(proc.stdout)
    err.write_text(proc.stderr)
    step = parse_finish(proc.stdout)
    if not step:
        return {'status': 'missing', 'session': session, 'tokens': {}, 'cost': '', 'answer': '', 'stderr': proc.stderr}
    part = step.get('part', {})
    tokens = part.get('tokens', {})
    session_id = step.get('sessionID', session)
    answer = ''
    for line in proc.stdout.splitlines():
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if data.get('type') == 'text':
            answer = data.get('part', {}).get('text', answer)
    return {
        'status': 'ok',
        'session': session_id,
        'tokens': {
            'total': tokens.get('total', 0),
            'input': tokens.get('input', 0),
            'output': tokens.get('output', 0),
            'reasoning': tokens.get('reasoning', 0),
            'cache_write': tokens.get('cache', {}).get('write', 0),
            'cache_read': tokens.get('cache', {}).get('read', 0),
        },
        'cost': part.get('cost', 0),
        'answer': answer.strip(),
        'stderr': proc.stderr,
    }

single_rows = []
for plugin in [0, 1]:
    for iteration in range(1, 4):
        res = run_once(plugin, single_prompt, allow_tools=False, tag=f'openai-single-p{plugin}-i{iteration}')
        row = {
            'plugin': plugin,
            'iteration': iteration,
            'total': res['tokens'].get('total', ''),
            'input': res['tokens'].get('input', ''),
            'output': res['tokens'].get('output', ''),
            'reasoning': res['tokens'].get('reasoning', ''),
            'cache_write': res['tokens'].get('cache_write', ''),
            'cache_read': res['tokens'].get('cache_read', ''),
            'cost': res['cost'],
            'answer': res['answer'],
            'status': res['status'],
        }
        single_rows.append(row)

with (bench / 'openai-single-results.csv').open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=['plugin', 'iteration', 'total', 'input', 'output', 'reasoning', 'cache_write', 'cache_read', 'cost', 'answer', 'status'])
    writer.writeheader()
    writer.writerows(single_rows)

tool_rows = []
for plugin in [0, 1]:
    session = ''
    for turn, prompt in enumerate(tool_prompts, start=1):
        res = run_once(plugin, prompt, session=session, allow_tools=True, tag=f'openai-tools-p{plugin}-t{turn}')
        session = res['session']
        row = {
            'plugin': plugin,
            'turn': turn,
            'total': res['tokens'].get('total', ''),
            'input': res['tokens'].get('input', ''),
            'output': res['tokens'].get('output', ''),
            'reasoning': res['tokens'].get('reasoning', ''),
            'cache_write': res['tokens'].get('cache_write', ''),
            'cache_read': res['tokens'].get('cache_read', ''),
            'cost': res['cost'],
            'answer': res['answer'],
            'status': res['status'],
        }
        tool_rows.append(row)

with (bench / 'openai-tools-results.csv').open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=['plugin', 'turn', 'total', 'input', 'output', 'reasoning', 'cache_write', 'cache_read', 'cost', 'answer', 'status'])
    writer.writeheader()
    writer.writerows(tool_rows)

print('wrote', bench / 'openai-single-results.csv')
print('wrote', bench / 'openai-tools-results.csv')
