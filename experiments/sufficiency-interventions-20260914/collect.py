"""Read-only collection of completed inference; explicitly mark missing jobs."""
import csv
import json
import math
from collections import Counter
from pathlib import Path
import argparse


def read(p):return json.loads(Path(p).read_text())


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True);a=ap.parse_args();r=a.root
    units=read(r/'units.json');jobs=read(r/'jobs.json');rows=[];answer_rows=[];missing=[]
    for u in units:
        row={k:v for k,v in u.items() if k not in ['native_original','answers','data_dir','original_request','evidence','answer_request','native_request']}
        native=[]
        if 'native_original' in u:
            for old in u['native_original']:
                native.append({'margin':old['logprobs']['sufficient']-old['logprobs']['insufficient'],
                    'input_tokens':old['branch_position']})
        else:
            for rep in [0,1]:
                p=r/'results'/f'{u["id"]}-s{rep}'/'result.json'
                if p.exists():native.append(read(p)['output'])
        row['native_n']=len(native)
        if len(native)==2:
            row['margin']=sum(x['margin'] for x in native)/2
            row['likelihood']=1/(1+math.exp(-row['margin']))
            row['replica_margin_difference']=native[1]['margin']-native[0]['margin']
            row['input_tokens']=sum(x['input_tokens'] for x in native)/2
        answers=[]
        if 'answer_request' in u:
            for sample in range(5):
                p=r/'results'/f'{u["id"]}-a{sample}'/'result.json'
                if p.exists():
                    result=read(p);o=result['output'];answers.append(o)
                    answer_rows.append({'unit':u['id'],'experiment':u['experiment'],'question_id':u['question_id'],
                        'sample':sample,'replica':result['job']['replica'],'seed':result['job']['seed'],
                        'prediction':o['prediction'],**o['metrics'],'fallback':o['fallback'],
                        'prompt_tokens':o.get('usage',{}).get('prompt_tokens'),
                        'completion_tokens':o.get('usage',{}).get('completion_tokens')})
        row['answer_n']=len(answers)
        if len(answers)==5:
            for metric in ['official_score','exact_match','f1']:
                row[metric]=sum(x['metrics'][metric] for x in answers)/5
            row['fallback_n']=sum(x['fallback'] for x in answers)
        row['complete']=row['native_n']==2 and ('answer_request' not in u or len(answers)==5)
        rows.append(row)
    for j in jobs:
        if not (r/'results'/j['id']/'result.json').exists():missing.append(j['id'])
    out=r/'summary';out.mkdir(exist_ok=True)
    for name,items in [('units.csv',rows),('answers.csv',answer_rows)]:
        if not items:continue
        keys=list(dict.fromkeys(k for item in items for k in item))
        with (out/name).open('w') as f:
            w=csv.DictWriter(f,fieldnames=keys);w.writeheader();w.writerows(items)
    retry_manifests=[json.loads(p.read_text()) for p in (r/'retry-history').glob('*/manifest.json')]
    retried_jobs={j for m in retry_manifests for j in m['jobs']}
    status={'expected_jobs':len(jobs),'completed_jobs':len(jobs)-len(missing),'missing_jobs':len(missing),
        'retried_jobs':len(retried_jobs),'archived_failed_attempts':sum(len(m['jobs']) for m in retry_manifests),
        'units':dict(Counter(u['experiment'] for u in rows)),
        'complete_units':dict(Counter(u['experiment'] for u in rows if u['complete'])),
        'completed_answers':len(answer_rows),'fallback_answers':sum(x['fallback'] for x in answer_rows)}
    (out/'status.json').write_text(json.dumps(status,indent=2))
    (out/'missing-jobs.json').write_text(json.dumps(missing,indent=2))
    print(json.dumps(status,indent=2))


if __name__=='__main__':main()
