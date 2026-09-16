"""Read-only server extractor. Run over SSH; JSON on stdout, progress on stderr.

Keep raw terminal artifacts and only matching audits; never select by correctness.
State snapshots/rejudges are not counted as independent experimental runs.
"""
import hashlib
import gzip
import io
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

BASE = Path('/data/zhaogangyi/picorer-eval')
RUNS = {
    'rq1_qwen': 'qwen36-v100-question-pipeline-20260911/state-v2.sqlite',
    'rq1_gpt4o': 'v100-api-backbone-matrix-20260912/amb-gpt4omini/state.official-rejudge-20260913.sqlite',
    'rq1_gpt5': 'v100-api-backbone-matrix-20260912/amb-gpt5mini-medium/state.official-rejudge-20260913.sqlite',
    'qwen_repeat1': 'qwen36-v100-sufficiency-dynamics-20260912/state-scoring.sqlite',
    'qwen_repeat2': 'qwen36-v100-sufficiency-dynamics-replicate-2-20260912/state-scoring.sqlite',
    'qwen_repeat3': 'qwen36-v100-sufficiency-dynamics-replicate-3-20260912/state-scoring.sqlite',
}
LOGS = {
    'shared_rq1': 'qwen36-v100-full-queue-20260911/runtime/agentmemorybench/large3/memory-service/wrap-audits.jsonl',
    **{key: str(Path(value).parent/'runtime/memory-service/wrap-audits.jsonl')
       for key, value in RUNS.items() if key.startswith('qwen_repeat')},
}
result = {'runs': {}, 'audits': {}, 'source_logs': {}, 'other_backbone_inventory': {}}
queries = set()
users = set()
for name, rel in RUNS.items():
    conn = sqlite3.connect(f'file:{BASE/rel}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    records = {}
    for row in conn.execute("SELECT q.id,q.ordinal,q.payload,s.stage,s.status,s.artifact_path FROM questions q JOIN question_stages s ON q.id=s.question_id WHERE q.id LIKE 'agentmemorybench:fact-mh-262k:%' ORDER BY q.ordinal,s.stage"):
        q = records.setdefault(row['id'], {'id': row['id'], 'ordinal': row['ordinal'], 'payload': json.loads(row['payload']), 'stages': {}})
        artifact = json.loads(Path(row['artifact_path']).read_text()) if row['artifact_path'] else None
        q['stages'][row['stage']] = {'status': row['status'], 'artifact_path': row['artifact_path'], 'artifact': artifact}
    result['runs'][name] = {'state_path': str(BASE/rel), 'records': list(records.values())}
    for q in records.values():
        users.add(q['payload']['user_id'].encode())
        queries.add(q['stages']['retrieval']['artifact']['output']['formatted_query'])
    print(name, len(records), file=sys.stderr, flush=True)
    conn.close()

for rel in ['v100-api-backbone-matrix-20260912/omni-gpt41mini/state.official-native-prompt-rejudge-20260913.sqlite', 'v100-api-backbone-matrix-20260912/omni-gpt5mini-medium/state.official-native-prompt-rejudge-20260913.sqlite']:
    conn = sqlite3.connect(f'file:{BASE/rel}?mode=ro', uri=True)
    result['other_backbone_inventory'][rel] = conn.execute('SELECT benchmark, count(*) FROM questions GROUP BY benchmark').fetchall()
    conn.close()

for name, rel in LOGS.items():
    path = BASE/rel
    kept = []
    models = Counter()
    offset = 0
    with path.open('rb') as handle:
        for line_number, line in enumerate(handle, 1):
            current_offset = offset
            offset += len(line)
            if not any(user in line[:600] for user in users):
                continue
            obj = json.loads(line)
            if obj.get('question') not in queries:
                continue
            retrieval = obj['retrieval']
            models[retrieval.get('retrievalModel', {}).get('modelId', 'unknown')] += 1
            # Omit large redundant search candidate catalogs and token statistics;
            # preserve ALL trace observations, evidence, prompt, finish details.
            slim = {k: obj.get(k) for k in ['wrap_id', 'created_at', 'userId', 'question', 'prompt', 'selectedMemoryIds', 'operatorExperiment']}
            slim['retrieval'] = {k: retrieval.get(k) for k in ['runId', 'status', 'citations', 'evidence', 'trace', 'retrievalModel', 'operatorExperiment']}
            slim['source_line'] = line_number
            slim['source_byte_offset'] = current_offset
            slim['source_line_sha256'] = hashlib.sha256(line).hexdigest()
            kept.append(slim)
    result['audits'][name] = kept
    result['source_logs'][name] = {'path': str(path), 'size_bytes': path.stat().st_size, 'selected_records': len(kept), 'models': models}
    print(name, len(kept), dict(models), file=sys.stderr, flush=True)
with gzip.GzipFile(fileobj=sys.stdout.buffer, mode='wb', compresslevel=2) as compressed:
    with io.TextIOWrapper(compressed, encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, separators=(',', ':'))
