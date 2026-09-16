"""Approved one-time switch of experiment processes, never model services."""
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess as sp
import time
import urllib.request

ROOT=Path('/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2')
STAGE=ROOT/'scheduler-staging'
PYTHON='/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2/.venv/bin/python'
OLD_SUPERVISOR=1556727
OLD_RUNNER=504982


def validate(pid,script):
    args=[x.decode() for x in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if x]
    assert str(ROOT/'code'/script) in args and str(ROOT) in args,(pid,args)


def process_alive(pid):
    path=Path(f'/proc/{pid}/stat')
    return path.exists() and path.read_text().split(') ',1)[1].split()[0]!='Z'


validate(OLD_SUPERVISOR,'supervise.py');validate(OLD_RUNNER,'run.py')
def function(path,name):
    return ast.dump(next(n for n in ast.parse(path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name==name))
assert function(ROOT/'code/run.py','run_job')==function(STAGE/'run.py','run_job'),'Measurement code must not change'
sp.run([PYTHON,str(STAGE/'test_replica_scheduler.py')],check=True)
stamp=str(time.time_ns());backup=ROOT/'scheduler-switches'/stamp;backup.mkdir(parents=True)
for name in ['run.py','supervise.py']:
    shutil.copy2(ROOT/'code'/name,backup/name)
for name in ['full-environment.json','full-progress.json','pilot-environment.json','pilot-progress.json']:
    if (ROOT/name).exists():shutil.copy2(ROOT/name,backup/name)
frozen={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['jobs.json','units.json','manifest.json']}
os.kill(OLD_SUPERVISOR,signal.SIGTERM)
os.kill(OLD_RUNNER,signal.SIGTERM)
deadline=time.time()+60
while any(process_alive(p) for p in [OLD_SUPERVISOR,OLD_RUNNER]):
    if time.time()>deadline:raise RuntimeError('Old experiment process still alive; no second runner started')
    time.sleep(1)
successful={};incomplete=[]
for directory in (ROOT/'results').iterdir():
    if not directory.is_dir():continue
    result=directory/'result.json'
    if result.exists():successful[directory.name]=hashlib.sha256(result.read_bytes()).hexdigest()
    else:
        shutil.copytree(directory,backup/'incomplete'/directory.name)
        incomplete.append(directory.name)
(backup/'successful-result-sha256.json').write_text(json.dumps(successful,indent=2))
(backup/'switch.json').write_text(json.dumps({'started_unix':time.time(),'old_pids':[OLD_SUPERVISOR,OLD_RUNNER],
    'preserved_successful_results':len(successful),'incomplete_archived':incomplete,'frozen_sha256':frozen,
    'new_scheduler':'per-replica','capacity_per_replica':32,'model_services_restarted':False,
    'measurement_function_unchanged':True},indent=2))
print(json.dumps({'event':'old_runner_stopped','preserved':len(successful),'incomplete_archived':len(incomplete),'backup':str(backup)}),flush=True)
deadline=time.time()+1200
while True:
    active={}
    for port in [18081,18082]:
        with urllib.request.urlopen(f'http://172.16.200.114:{port}/metrics',timeout=10) as response:
            body=response.read().decode()
        values=re.findall(r'^vllm:num_requests_(?:running|waiting)\{[^\n]*\}\s+([\d.]+)$',body,re.M)
        assert len(values)==2
        active[port]=sum(map(float,values))
    print(json.dumps({'event':'old_requests_draining','active':active}),flush=True)
    if not any(active.values()):break
    if time.time()>deadline:raise RuntimeError('Requests did not drain; model services left untouched')
    time.sleep(10)
for name,digest in frozen.items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest
for name in ['run.py','supervise.py','replica_scheduler.py','test_replica_scheduler.py']:
    shutil.copy2(STAGE/name,ROOT/'code'/name)
sp.run([PYTHON,str(ROOT/'code/test_replica_scheduler.py')],check=True)
sp.run([PYTHON,str(ROOT/'code/supervise.py'),'--root',str(ROOT),'--detach'],check=True)
(backup/'resumed.json').write_text(json.dumps({'resumed_unix':time.time(),'supervisor_pid':int((ROOT/'supervisor.pid').read_text())}))
print(json.dumps({'event':'resumed','backup':str(backup)}),flush=True)
