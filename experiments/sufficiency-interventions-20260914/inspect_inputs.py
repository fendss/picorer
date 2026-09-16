import json
from pathlib import Path

BASE = Path('/data/zhaogangyi/picorer-eval')
root = BASE / 'qwen36-v100-sufficiency-dynamics-replicate-3-20260912'
states = [json.loads(s) for s in (root/'decision-states-v2/index.jsonl').read_text().splitlines()]
for state in states[:3]:
    print('STATE', json.dumps(state))
    req = json.loads((Path(state['capture_dir'])/'request.body').read_text())
    print('REQUEST SETTINGS', json.dumps({k:v for k,v in req.items() if k not in ['messages','tools']}))
    for m in req['messages']:
        print('MESSAGE', json.dumps(m)[:200])
    print('TOOLS', json.dumps(req.get('tools'))[:2000])
    break
for state in states:
    if state['question_id']==states[0]['question_id'] and state['decision_step'] in [2,3,4]:
        req = json.loads((Path(state['capture_dir'])/'request.body').read_text())
        print('LATER STATE',state['decision_step'])
        for m in req['messages']:
            if m['role']=='tool': print('TOOL MESSAGE',json.dumps(m)[:450])
audit = json.loads((root/'runtime/memory-service/wrap-audits.jsonl').read_text().splitlines()[0])
print('AUDIT KEYS',list(audit), 'RETRIEVAL KEYS', list(audit['retrieval']))
for trace in audit['retrieval']['trace']:
    if trace['toolName']=='read':
        print('READ DETAILS',json.dumps(trace.get('details'))[:4500]);break
print('FINAL EVIDENCE',json.dumps(audit['retrieval'].get('evidence',[]))[:1500])
print('MANIFEST',json.dumps(json.loads((root/'manifest-full.json').read_text())['questions'][0])[:4000])
for path in (root/'answer-captures').glob('*/request.body'):
    if not path.read_text().strip().startswith('{'): continue
    req=json.loads(path.read_text()); print('ANSWER SETTINGS', {k:v for k,v in req.items() if k!='messages'})
    for m in req['messages']: print('ANSWER MESSAGE', str(m)[:1400], 'TAIL', str(m)[-1400:])
    break
for path in (root/'artifacts-scoring').glob('*/evaluation.json'):
    print('EVALUATION',path.read_text()[:4000]); break
