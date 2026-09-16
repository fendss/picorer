"""Durable pilot-to-full driver. Does not start/stop any model service."""
import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True)
    ap.add_argument('--workers',type=int,default=64)
    ap.add_argument('--detach',action='store_true');a=ap.parse_args();root=a.root
    if a.workers<2 or a.workers>128:ap.error('workers must be between 2 and 128 for two existing replicas')
    if a.detach:
        pidpath=root/'supervisor.pid'
        if pidpath.exists():
            try:os.kill(int(pidpath.read_text()),0)
            except ProcessLookupError:pass
            else:raise RuntimeError('Supervisor is already running')
        with (root/'supervisor.log').open('a') as log:
            p=subprocess.Popen([sys.executable,__file__,'--root',str(root),'--workers',str(a.workers)],stdin=subprocess.DEVNULL,
                stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        pidpath.write_text(str(p.pid));print(json.dumps({'pid':p.pid,'root':str(root)}));return
    def run(script,*extra):
        subprocess.run([sys.executable,str(root/'code'/script),'--root',str(root),*extra],check=True)
    def run_inference(*extra):
        # A replacement supervisor may adopt an already-running runner. Never
        # interrupt its requests or start a competing runner.
        with (root/'runner.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
        for attempt in range(1,4):
            archived=[]
            stamp=str(time.time_ns())
            for err in (root/'errors').glob('*.json'):
                directory=root/'results'/err.stem
                if directory.exists() and not (directory/'result.json').exists():
                    target=root/'retry-history'/stamp/err.stem
                    shutil.copytree(directory,target)
                    shutil.copy2(err,target/'error.json')
                    archived.append(err.stem)
            if archived:
                (root/'retry-history'/stamp/'manifest.json').write_text(json.dumps({
                    'attempt':attempt,'jobs':archived,'parameters_changed':False,
                    'seed_changed':False,'reason':'retry incomplete execution; never retry incorrect answers'}))
            try:
                run('run.py',*extra)
                return
            except subprocess.CalledProcessError as exc:
                if exc.returncode==75:raise SystemExit(75)
                if attempt==3:raise
                print(json.dumps({'event':'retry_incomplete_jobs','attempt':attempt}),flush=True)
    try:
        run_inference('--pilot','10','--workers',str(a.workers))
        pilot=json.loads((root/'pilot-complete.json').read_text())
        if pilot['counts'].get('failed',0):raise RuntimeError('Pilot has failures')
        run('audit_outputs.py','--pilot','10')
        print(json.dumps({'event':'pilot_passed','jobs':pilot['jobs']}),flush=True)
        run_inference('--workers',str(a.workers))
        run('audit_outputs.py')
        run('collect.py')
        env=dict(os.environ,SCIENTIFIC_VISUALIZATION_SKILL=str(root/'vendor/scientific-visualization'),
                 MPLCONFIGDIR=str(root/'matplotlib-cache'),OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
        plot_python=str(root/'.venv-analysis/bin/python')
        subprocess.run([plot_python,str(root/'code/analyze.py'),'--root',str(root)],env=env,check=True)
        subprocess.run([plot_python,str(root/'code/verify_figures.py'),'--root',str(root)],env=env,check=True)
        (root/'suite-complete.json').write_text(json.dumps({'finished_unix':time.time(),'pilot_jobs':pilot['jobs'],
            'inference_complete':True,'figures_generated':True,'manual_visual_review':'pending'}))
    except BaseException as e:
        if isinstance(e,SystemExit) and e.code==75:
            (root/'supervisor-paused.json').write_text(json.dumps({'time':time.time(),'reason':'runner drained on signal'}))
            raise
        (root/'supervisor-failure.json').write_text(json.dumps({'error':str(e),'time':time.time()}))
        raise


if __name__=='__main__':main()
