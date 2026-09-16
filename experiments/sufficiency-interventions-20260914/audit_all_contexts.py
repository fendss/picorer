"""Tokenize every distinct answer input without GPU generation."""
import concurrent.futures as cf
import json
from pathlib import Path
import requests

r=Path('/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2')
units=json.loads((r/'units.json').read_text())
paths=sorted({u['answer_request'] for u in units if 'answer_request' in u})
def one(path):
    p=json.loads(Path(path).read_text())
    response=requests.post('http://172.16.200.114:18081/tokenize',json={
        'model':p['model'],'messages':p['messages'],'add_generation_prompt':True},timeout=180)
    response.raise_for_status();b=response.json();n=b['count'];assert n>0
    return path,n
with cf.ThreadPoolExecutor(max_workers=4) as ex:counts=dict(ex.map(one,paths))
rows=[{'unit':u['id'],'experiment':u['experiment'],'input_tokens':counts[u['answer_request']],
    'total_budget_tokens':counts[u['answer_request']]+16384,'request':u['answer_request']}
    for u in units if 'answer_request' in u]
result={'distinct_inputs':len(counts),'max_input_tokens':max(counts.values()),
    'over_131072':[x for x in rows if x['total_budget_tokens']>131072],
    'over_262144':[x for x in rows if x['total_budget_tokens']>262144],'rows':rows}
(r/'all-context-lengths.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='rows'},indent=2))
