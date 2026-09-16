"""Check deployed limits and the longest unmodified request on both replicas."""
import concurrent.futures as cf
import json
from pathlib import Path
import time
import requests

ROOT = Path('/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2')
audit = json.loads((ROOT / 'all-context-lengths.json').read_text())
longest = max(audit['rows'], key=lambda r: r['input_tokens'])
payload = json.loads(Path(longest['request']).read_text())


def check(port):
    endpoint = f'http://172.16.200.114:{port}'
    response = requests.get(endpoint + '/v1/models', timeout=10)
    response.raise_for_status()
    models = response.json()
    assert models['data'][0]['max_model_len'] == 262144, models
    response = requests.post(endpoint + '/v1/chat/completions/render', json=payload, timeout=180)
    response.raise_for_status()
    tokens = response.json()['token_ids']
    assert len(tokens) == longest['input_tokens'], (len(tokens), longest)
    # This diagnostic generates one token only; it is not an experimental answer.
    probe = dict(payload)
    probe.pop('max_tokens', None)
    probe['max_completion_tokens'] = 1
    response = requests.post(endpoint + '/v1/chat/completions', json=probe, timeout=300)
    response.raise_for_status()
    body = response.json()
    assert body['usage']['prompt_tokens'] == len(tokens), body.get('usage')
    return {'endpoint': endpoint, 'models': models, 'longest_unit': longest['unit'],
            'input_tokens': len(tokens), 'formal_output_budget': 16384,
            'render_with_formal_budget_passed': True, 'diagnostic_usage': body['usage']}


with cf.ThreadPoolExecutor(max_workers=2) as pool:
    checks = list(pool.map(check, (18081, 18082)))
result = {'verified_unix': time.time(), 'checks': checks, 'gpus': [4, 7],
          'evidence_truncated': False, 'diagnostic_is_experimental_answer': False}
(ROOT / 'context-upgrade-verification.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
