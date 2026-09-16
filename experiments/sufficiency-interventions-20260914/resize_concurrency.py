"""Finish an approved graceful drain and resume with a new client worker limit."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess as sp
import time

ROOT=Path('/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2')
PYTHON='/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2/.venv/bin/python'


def alive(pid):
    p=Path(f'/proc/{pid}/stat')
    return p.exists() and p.read_text().split(') ',1)[1].split()[0]!='Z'


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--workers',type=int,required=True)
    parser.add_argument('--runner',type=int,required=True)
    parser.add_argument('--supervisor',type=int,required=True)
    a=parser.parse_args()
    assert a.workers in (64,68,80)
    started=time.time();backup=ROOT/'concurrency-changes'/str(time.time_ns());backup.mkdir(parents=True)
    for name in ['full-environment.json','full-progress.json']:
        if (ROOT/name).exists():shutil.copy2(ROOT/name,backup/name)
    shutil.copy2(ROOT/'code/supervise.py',backup/'supervise.py')
    frozen={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['jobs.json','units.json','manifest.json','code/run.py','code/replica_scheduler.py']}
    for pid,script in [(a.runner,'run.py'),(a.supervisor,'supervise.py')]:
        if alive(pid):
            args=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            assert str(ROOT/'code'/script).encode() in args and str(ROOT).encode() in args
    while alive(a.runner) or alive(a.supervisor):
        if time.time()-started>1800:raise RuntimeError('Drain not complete; existing processes left untouched')
        p=json.loads((ROOT/'full-progress.json').read_text())
        print(json.dumps({'event':'draining','counts':p['counts'],
              'inflight':p.get('scheduling',{}).get('inflight_per_replica'),
              'draining':p.get('draining')}),flush=True)
        time.sleep(10)
    assert (ROOT/'full-drained.json').exists() and (ROOT/'supervisor-paused.json').exists()
    assert json.loads((ROOT/'supervisor-paused.json').read_text())['time']>started-120
    for name,digest in frozen.items():assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest
    for name in ['full-drained.json','supervisor-paused.json','full-progress.json']:
        shutil.copy2(ROOT/name,backup/name)
    hashes={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'results').glob('*/result.json')}
    (backup/'successful-result-sha256.json').write_text(json.dumps(hashes))
    shutil.copy2(ROOT/'concurrency-staging/supervise.py',ROOT/'code/supervise.py')
    report={'workers':a.workers,'workers_per_replica':a.workers//2,'old_runner':a.runner,
        'old_supervisor':a.supervisor,'preserved_results':len(hashes),'frozen_sha256':frozen,
        'model_services_changed':False,'gracefully_drained':True,'updated_unix':time.time()}
    (backup/'change.json').write_text(json.dumps(report,indent=2))
    sp.run([PYTHON,str(ROOT/'code/supervise.py'),'--root',str(ROOT),'--workers',str(a.workers),'--detach'],check=True)
    report['new_supervisor']=int((ROOT/'supervisor.pid').read_text())
    (backup/'resumed.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'event':'resumed','backup':str(backup),**report}),flush=True)


if __name__=='__main__':main()
