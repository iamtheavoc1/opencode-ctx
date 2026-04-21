import csv
import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path

root = Path('/Users/goncalo/.local/share/opencode-context-plugin/bench')
work = Path('/tmp/octx-bench')
work.mkdir(parents=True, exist_ok=True)
quality_file = root / 'quality-note.txt'
db_path = Path('/Users/goncalo/.local/share/opencode/opencode.db')
results = []

suites = [
    {
        'name': 'memory-chat',
        'model': 'anthropic/claude-haiku-4-5',
        'thinking': False,
        'variant': None,
        'turns': [
            {'prompt': 'Reply with exactly: ALPHA', 'check': {'type': 'exact', 'value': 'ALPHA'}},
            {'prompt': 'What did you just say? Reply with exactly: ALPHA', 'check': {'type': 'exact', 'value': 'ALPHA'}},
            {'prompt': 'Ignore previous code words and reply with exactly: BETA', 'check': {'type': 'exact', 'value': 'BETA'}},
            {'prompt': 'What were the two code words? Reply with exactly: ALPHA BETA', 'check': {'type': 'exact', 'value': 'ALPHA BETA'}},
            {'prompt': 'What was the first code word? Reply with exactly: ALPHA', 'check': {'type': 'exact', 'value': 'ALPHA'}},
        ],
    },
    {
        'name': 'tool-memory',
        'model': 'anthropic/claude-haiku-4-5',
        'thinking': False,
        'variant': None,
        'turns': [
            {'prompt': f'Read {quality_file} and reply with exactly: BANANA', 'check': {'type': 'exact', 'value': 'BANANA'}},
            {'prompt': 'Reply with exactly: OK1', 'check': {'type': 'exact', 'value': 'OK1'}},
            {'prompt': 'What fruit was in the file? Reply with exactly: BANANA', 'check': {'type': 'exact', 'value': 'BANANA'}},
            {'prompt': 'Reply with exactly: OK2', 'check': {'type': 'exact', 'value': 'OK2'}},
            {'prompt': 'What fruit was in the file? Reply with exactly: BANANA', 'check': {'type': 'exact', 'value': 'BANANA'}},
        ],
    },
    {
        'name': 'reasoning-retention',
        'model': 'anthropic/claude-opus-4-7',
        'thinking': True,
        'variant': 'high',
        'turns': [
            {'prompt': 'Think privately to choose a random uppercase 4-letter code and remember it. Reply with exactly: READY', 'check': {'type': 'exact', 'value': 'READY'}},
            {'prompt': 'Do not reveal the code yet. Reply with exactly: HOLD', 'check': {'type': 'exact', 'value': 'HOLD'}},
            {'prompt': 'Reveal the exact 4-letter code you chose earlier. Reply with only the code.', 'check': {'type': 'regex', 'value': r'^[A-Z]{4}$'}, 'store_as': 'secret_code'},
            {'prompt': 'Repeat the exact same 4-letter code again. Reply with only the code.', 'check': {'type': 'stored', 'value': 'secret_code'}},
        ],
    },
]

configs = [
    ('baseline', {'OPENCODE_CTX_REASONING': '0', 'OPENCODE_CTX_FILES': '0'}),
    ('candidate', {'OPENCODE_CTX_REASONING': '1', 'OPENCODE_CTX_REASONING_KEEP': '1', 'OPENCODE_CTX_FILES': '0'}),
]
iterations = 3

def parse_run(path: Path):
    text = path.read_text()
    answer = ''
    tokens = {'total': '', 'input': '', 'output': '', 'reasoning': '', 'cache_write': '', 'cache_read': ''}
    error = ''
    session_id = ''
    for line in text.splitlines():
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if data.get('type') == 'text':
            answer = data.get('part', {}).get('text', answer)
        if data.get('type') == 'step_finish':
            session_id = data.get('sessionID', session_id)
            part = data.get('part', {})
            token_data = part.get('tokens', {})
            cache = token_data.get('cache', {})
            tokens = {
                'total': token_data.get('total', ''),
                'input': token_data.get('input', ''),
                'output': token_data.get('output', ''),
                'reasoning': token_data.get('reasoning', ''),
                'cache_write': cache.get('write', ''),
                'cache_read': cache.get('read', ''),
            }
        if data.get('type') == 'error':
            error = data.get('error', {}).get('data', {}).get('message', 'unknown error')
    return answer.strip(), tokens, error, session_id

def count_reasoning_parts(session_id: str) -> int:
    if not session_id:
        return 0
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    rows = cur.execute('select data from part where session_id = ?', (session_id,)).fetchall()
    conn.close()
    total = 0
    for (data,) in rows:
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            continue
        if obj.get('type') == 'reasoning':
            total += 1
    return total

def evaluate(check: dict, answer: str, stored: dict[str, str]):
    if check['type'] == 'exact':
        return answer == check['value'], check['value']
    if check['type'] == 'regex':
        return re.match(check['value'], answer) is not None, check['value']
    if check['type'] == 'stored':
        expected = stored.get(check['value'], '')
        return answer == expected and expected != '', expected
    return False, ''

for suite in suites:
    for config_name, config_env in configs:
        for iteration in range(1, iterations + 1):
            session = ''
            stored = {}
            for turn_index, turn in enumerate(suite['turns'], start=1):
                cmd = ['opencode', 'run']
                if suite['thinking']:
                    cmd.append('--thinking')
                if suite['variant']:
                    cmd += ['--variant', suite['variant']]
                if session:
                    cmd += ['--session', session]
                cmd += ['--format', 'json', '--model', suite['model'], '--', turn['prompt']]
                env = dict(os.environ)
                env.update(config_env)
                out_path = work / f"quality-{suite['name']}-{config_name}-i{iteration}-t{turn_index}.jsonl"
                err_path = work / f"quality-{suite['name']}-{config_name}-i{iteration}-t{turn_index}.err"
                proc = subprocess.run(cmd, cwd=str(work), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                out_path.write_text(proc.stdout)
                err_path.write_text(proc.stderr)
                answer, tokens, error, session_id = parse_run(out_path)
                if session_id:
                    session = session_id
                passed, expected = evaluate(turn['check'], answer, stored)
                if 'store_as' in turn and passed:
                    stored[turn['store_as']] = answer
                reasoning_parts = count_reasoning_parts(session)
                results.append({
                    'suite': suite['name'],
                    'config': config_name,
                    'iteration': iteration,
                    'turn': turn_index,
                    'expected': expected,
                    'answer': answer,
                    'match': 'yes' if passed and not error else 'no',
                    'reasoning_tokens': tokens['reasoning'],
                    'total_tokens': tokens['total'],
                    'session_reasoning_parts': reasoning_parts,
                    'reasoning_observed': 'yes' if reasoning_parts > 0 else 'no',
                    'error': error,
                })
                if error:
                    break

with (root / 'quality-live-results.csv').open('w', newline='') as handle:
    writer = csv.DictWriter(handle, fieldnames=['suite', 'config', 'iteration', 'turn', 'expected', 'answer', 'match', 'reasoning_tokens', 'total_tokens', 'session_reasoning_parts', 'reasoning_observed', 'error'])
    writer.writeheader()
    writer.writerows(results)

reasoning_rows = sum(1 for row in results if str(row['reasoning_tokens']).strip() not in ('', '0'))
observed_rows = sum(1 for row in results if row['reasoning_observed'] == 'yes')
reasoning_supported = observed_rows > 0 or reasoning_rows > 0
summary = {
    'total_rows': len(results),
    'matches': sum(1 for row in results if row['match'] == 'yes'),
    'mismatches': sum(1 for row in results if row['match'] == 'no'),
    'reasoning_token_rows': reasoning_rows,
    'reasoning_observed_rows': observed_rows,
    'reasoning_supported': reasoning_supported,
}
print(json.dumps(summary))
