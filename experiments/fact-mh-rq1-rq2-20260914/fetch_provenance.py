"""Fetch small provenance metadata to disambiguate native vs canary retrievals."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REMOTE = r'''
import hashlib,json,sqlite3,yaml
from pathlib import Path
b=Path('/data/zhaogangyi/picorer-eval')
native=b/'qwen36-v100-full-queue-20260911/results/agentmemorybench/large3/qwen36-v100-large3/fact-mh-262k-static.json'
n=json.loads(native.read_text())
result={'native_path':str(native),'native_sha256':hashlib.sha256(native.read_bytes()).hexdigest(),'native_data':n['data'],'native_failures':n.get('failures'),'native_execution':n.get('execution'),'canaries':[],'configs':{},'read_example':None,'stage_histories':{}}
for p in (b/'qwen36-v100-question-pipeline-20260911/preflight-canary-balanced/artifacts').glob('*/retrieval.json'):
 a=json.loads(p.read_text())
 if ':fact-mh-262k:' in a.get('question_id',''):
  result['canaries'].append({'path':str(p),'question_id':a['question_id'],'operator_experiment':a['output']['operator_experiment'],'prompt_sha256':hashlib.sha256(a['output']['wrapped_prompt'].encode()).hexdigest()})
configs={
 'rq1_qwen':'qwen36-v100-full-queue-20260911/amb/large3/config.yaml',
 'rq1_gpt4o':'v100-api-backbone-matrix-20260912/amb-gpt4omini/amb/large3/config.yaml',
 'rq1_gpt5':'v100-api-backbone-matrix-20260912/amb-gpt5mini-medium/amb/large3/config.yaml',
 'qwen_repeat1':'qwen36-v100-sufficiency-dynamics-20260912/config-scoring.yaml',
 'qwen_repeat2':'qwen36-v100-sufficiency-dynamics-replicate-2-20260912/config-scoring.yaml',
 'qwen_repeat3':'qwen36-v100-sufficiency-dynamics-replicate-3-20260912/config-scoring.yaml'}
for key,rel in configs.items():
 a=yaml.safe_load((b/rel).read_text())
 result['configs'][key]={'path':str(b/rel), 'service':a.get('service'),'run':a.get('run'),'model':a.get('model')}
with (b/'qwen36-v100-sufficiency-dynamics-20260912/runtime/memory-service/wrap-audits.jsonl').open() as f:
 a=json.loads(next(f))
 result['read_example']=[t['details'] for t in a['retrieval']['trace'] if t['toolName']=='read'][-1]
print(json.dumps(result,ensure_ascii=False))
'''
result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','zgy-direct','python3 -'],input=REMOTE.encode(),stdout=subprocess.PIPE,check=True)
data=json.loads(result.stdout)
(ROOT/'provenance.json').write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
print('Canaries:',len(data['canaries']))
print('Native failures (history, not finalized rows):',len(data['native_failures']))
print('READ EXAMPLE',json.dumps(data['read_example'],ensure_ascii=False)[:7000])
print('INTERFACES',{k:v['service']['interface_mode'] for k,v in data['configs'].items()})
