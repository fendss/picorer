"""Resumable, bounded inference on the two existing Qwen replicas only."""
from __future__ import annotations
import argparse
import copy
import fcntl
import hashlib
import json
import math
import os
import signal
import sys
import threading
import time
import traceback
from collections import Counter
from pathlib import Path
from replica_scheduler import completed_jobs

sys.path.insert(0,str(Path(__file__).resolve().parent))
from run_measurements_v2 import ProbeClient, branch_spec, masked_branch_logprobs, write_json_atomic as save
sys.path.insert(0,'/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/adapter-candidate')
from mab_adapter.config import task_config
from mab_adapter.scoring import score_prediction

ENDPOINTS=['http://172.16.200.114:18081','http://172.16.200.114:18082']


def read(p):return json.loads(Path(p).read_text())


def run_job(root,job,clients):
    directory=root/'results'/job['id'];result=directory/'result.json'
    if result.exists():
        old=read(result)
        assert old['job']==job,('resume identity mismatch',job['id'])
        return {'status':'reused','kind':job['kind']}
    client=clients[job['replica']];started=time.time()
    request=read(job['request']);save(directory/'job.json',job)
    if job['kind']=='native':
        spec=branch_spec(client,request,directory,'native')
        if 'expected_prefix' in job and spec['prompt_token_ids']!=read(job['expected_prefix'])['prompt']:
            raise RuntimeError('Baseline replay differs from original token prefix; stop before inference')
        payload={'model':request['model'],'prompt':spec['prompt_token_ids'],
            'max_tokens':1,'temperature':1.0,'top_p':1.0,'seed':20260914,
            'allowed_token_ids':list(spec['branch_token_ids'].values()),'logprobs':2,'return_token_ids':True}
        save(directory/'completion.request.json',payload)
        response=client.post('/v1/completions',payload);body=response.json()
        save(directory/'completion.response.json',{'status':response.status_code,'headers':dict(response.headers),'body':body})
        lp=masked_branch_logprobs(body,spec['branch_token_ids'])
        margin=lp['sufficient']-lp['insufficient'];p=1/(1+math.exp(-margin))
        output={'margin':margin,'likelihood':p,'logprobs':lp,'branch_token_ids':spec['branch_token_ids'],
                'input_tokens':len(spec['prompt_token_ids']),'usage':body.get('usage'),
                'agent_context_intervened':True,'additional_judge_prompt':False}
    else:
        payload=copy.deepcopy(request);payload['seed']=job['seed']
        save(directory/'answer.request.json',payload)
        response=client.post('/v1/chat/completions',payload);body=response.json()
        save(directory/'answer.response.json',{'status':response.status_code,'headers':dict(response.headers),'body':body})
        choice=body['choices'][0];prediction=choice['message'].get('content') or ''
        fallback=False
        if not prediction.strip():
            # Same evidence, explicit recorded established answer-only fallback.
            fallback=True;payload.pop('reasoning_effort',None)
            payload['chat_template_kwargs']={'enable_thinking':False}
            save(directory/'fallback.request.json',payload)
            response=client.post('/v1/chat/completions',payload);body=response.json()
            save(directory/'fallback.response.json',{'status':response.status_code,'headers':dict(response.headers),'body':body})
            choice=body['choices'][0];prediction=choice['message'].get('content') or ''
        if not prediction.strip():raise RuntimeError('Empty answer even after recorded no-thinking fallback')
        if choice.get('finish_reason')=='length':raise RuntimeError('Answer truncated at token limit; retained for explicit recovery')
        metrics=score_prediction(task_config('fact-mh-262k'),prediction,tuple(job['answers']))
        output={'prediction':prediction,'metrics':metrics,'fallback':fallback,
            'finish_reason':choice.get('finish_reason'),'usage':body.get('usage')}
    save(result,{'job':job,'endpoint':client.endpoint,'elapsed_seconds':time.time()-started,
        'finished_unix':time.time(),'output':output})
    return {'status':'completed','kind':job['kind']}


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True)
    ap.add_argument('--workers',type=int,default=32)
    ap.add_argument('--scheduler',choices=['shared','per-replica'],default='per-replica')
    ap.add_argument('--pilot',type=int);ap.add_argument('--limit',type=int)
    ap.add_argument('--baseline-only',action='store_true')
    args=ap.parse_args();root=args.root
    lock=(root/'runner.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    draining=threading.Event()
    for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGUSR1]:
        signal.signal(sig,lambda *_:draining.set())
    units={u['id']:u for u in read(root/'units.json')};jobs=read(root/'jobs.json')
    if args.pilot is not None:jobs=[j for j in jobs if units[j['unit']]['ordinal']<args.pilot]
    if args.baseline_only:jobs=[j for j in jobs if 'expected_prefix' in j]
    # Native and answer jobs interleaved by question; short controlled inputs first.
    jobs.sort(key=lambda j:(units[j['unit']]['ordinal'],
        {'coverage':0,'preview':1,'state_answers':2}[units[j['unit']]['experiment']],j['unit'],j['kind'],j['id']))
    if args.limit:jobs=jobs[:args.limit]
    clients=[ProbeClient(e,1200) for e in ENDPOINTS]
    environment={'started_unix':time.time(),'pid':os.getpid(),'workers':args.workers,
        'scheduler':args.scheduler,'scheduler_sha256':hashlib.sha256(Path(__file__).with_name('replica_scheduler.py').read_bytes()).hexdigest(),
        'pilot':args.pilot,'limit':args.limit,'expected':len(jobs),'endpoints':ENDPOINTS,
        'python':sys.version,'code_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    for i,c in enumerate(clients):
        response=c.session().get(c.endpoint+'/v1/models',timeout=10);response.raise_for_status()
        environment[f'models_{i}']=response.json()
    phase='pilot' if args.pilot is not None else 'full'
    if args.limit:phase='smoke'
    history=root/'run-history'/f'{time.time_ns()}-{os.getpid()}'
    for filename in [f'{phase}-environment.json',f'{phase}-progress.json']:
        if (root/filename).exists():save(history/filename,read(root/filename))
    save(root/f'{phase}-environment.json',environment)
    counts=Counter();errors=[];started=time.time();scheduling={};last_status=0
    def status():
        nonlocal last_status
        info={'phase':phase,'expected':len(jobs),'counts':dict(counts),'errors':errors,
            'elapsed_seconds':time.time()-started,'updated_unix':time.time(),
            'scheduling':scheduling,'draining':draining.is_set()}
        save(root/f'{phase}-progress.json',info);print(json.dumps(info),flush=True)
        last_status=time.monotonic()
    remaining=[]
    for j in jobs:
        if (root/'results'/j['id']/'result.json').exists():
            res=run_job(root,j,clients);counts[res['status']]+=1;counts[res['kind']]+=1
        else:remaining.append(j)
    def observe(value):
        scheduling.clear();scheduling.update(value)
        if time.monotonic()-last_status>=15:status()
    for j,f in completed_jobs(remaining,lambda j:run_job(root,j,clients),args.workers,
                              mode=args.scheduler,stopping=draining.is_set,observe=observe):
        try:
            res=f.result();counts[res['status']]+=1;counts[res['kind']]+=1
        except Exception as e:
            counts['failed']+=1;err={'job':j['id'],'error':str(e)};errors.append(err)
            save(root/'errors'/f'{j["id"]}.json',dict(err,traceback=traceback.format_exc()))
    status()
    if draining.is_set():
        save(root/f'{phase}-drained.json',{'finished_unix':time.time(),'counts':dict(counts)})
        raise SystemExit(75)
    if errors:raise SystemExit(1)
    save(root/f'{phase}-complete.json',{'jobs':len(jobs),'finished_unix':time.time(),'counts':dict(counts)})


if __name__=='__main__':main()
