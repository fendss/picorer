"""Check longest frozen answer inputs without generating answers."""
import json
from pathlib import Path
import requests

r=Path('/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2')
units=json.loads((r/'units.json').read_text())
ranked=sorted([u for u in units if 'answer_request' in u],key=lambda u:Path(u['answer_request']).stat().st_size,reverse=True)
seen=set();rows=[]
for u in ranked[:30]:
    if u['answer_request'] in seen:continue
    seen.add(u['answer_request']);payload=json.loads(Path(u['answer_request']).read_text())
    payload['add_generation_prompt']=True
    resp=requests.post('http://172.16.200.114:18081/v1/chat/completions/render',json=payload,timeout=120)
    if resp.status_code!=200:
        print(json.dumps({'unit':u['id'],'render_error':resp.text[:1500]}),flush=True)
        resp=requests.post('http://172.16.200.114:18081/tokenize',json={
            'model':payload['model'],'messages':payload['messages'],'add_generation_prompt':True},timeout=120)
        resp.raise_for_status();body=resp.json();tokens=body.get('count',len(body.get('tokens',[])))
    else:
        body=resp.json();tokens=len(body['token_ids'])
    rows.append({'unit':u['id'],'input_tokens':tokens,'requested_output_tokens':16384,
                 'fits_131072':tokens+16384<=131072,'request':u['answer_request']})
(r/'long-context-audit.json').write_text(json.dumps(rows,indent=2))
print(json.dumps(rows,indent=2))
