"""Audit raw responses, immutable inputs, replica alignment and baseline replay."""
import argparse
import hashlib
import json
import math
import statistics
from collections import Counter
from pathlib import Path


def read(p):return json.loads(Path(p).read_text())


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--root',type=Path,required=True)
    ap.add_argument('--pilot',type=int);a=ap.parse_args();r=a.root
    units={u['id']:u for u in read(r/'units.json')};jobs=read(r/'jobs.json')
    if a.pilot is not None:jobs=[j for j in jobs if units[j['unit']]['ordinal']<a.pilot]
    failures=[];pending=[];durations={'native':[],'answer':[]};drift=[];lengths=[];counts=Counter()
    checked_blobs=set()
    for j in jobs:
        blob=Path(j['request'])
        if blob not in checked_blobs:
            doc=read(blob);digest=hashlib.sha256(json.dumps(doc,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
            if digest!=blob.stem:failures.append({'job':j['id'],'error':'input hash mismatch'})
            checked_blobs.add(blob)
        path=r/'results'/j['id']/'result.json'
        if not path.exists():pending.append(j['id']);continue
        result=read(path);o=result['output'];u=units[j['unit']]
        if result['job']!=j:failures.append({'job':j['id'],'error':'job identity mismatch'})
        counts[j['kind']]+=1;durations[j['kind']].append(result['elapsed_seconds'])
        if j['kind']=='native':
            raw=read(path.parent/'completion.response.json')['body']
            if 'expected_prefix' in j and read(path.parent/'completion.request.json')['prompt']!=read(j['expected_prefix'])['prompt']:
                failures.append({'job':j['id'],'error':'baseline full token prefix mismatch'})
            lp=o['logprobs'];margin=lp['sufficient']-lp['insufficient']
            if not math.isclose(o['likelihood'],1/(1+math.exp(-margin)),abs_tol=1e-10):
                failures.append({'job':j['id'],'error':'likelihood arithmetic'})
            if len(raw['choices'])!=1 or len(raw['choices'][0]['token_ids'])!=1:
                failures.append({'job':j['id'],'error':'wrong native response cardinality'})
            if u['experiment']=='preview' and u['condition']=='original':
                old=units[u['parent_state']]['native_original'][j['replica']]
                old_margin=old['logprobs']['sufficient']-old['logprobs']['insufficient']
                drift.append(o['margin']-old_margin)
                if o['input_tokens']!=old['branch_position'] or o['branch_token_ids']!=old['branch_token_ids']:
                    failures.append({'job':j['id'],'error':'baseline native token prefix length/branch mismatch'})
            lengths.append(o['input_tokens'])
        else:
            if not o['prediction'].strip() or o['finish_reason']=='length':
                failures.append({'job':j['id'],'error':'empty/truncated answer'})
            counts['fallback']+=int(o['fallback'])
    report={'expected':len(jobs),'completed':sum(counts[k] for k in ['native','answer']),
        'missing':len(pending),'counts':dict(counts),'failures':failures,
        'checked_input_blobs':len(checked_blobs),
        'elapsed_seconds_median':{k:statistics.median(v) if v else None for k,v in durations.items()},
        'native_context_tokens_max':max(lengths) if lengths else None,
        'baseline_replays':len(drift),'baseline_margin_abs_difference_mean':statistics.mean(map(abs,drift)) if drift else None,
        'baseline_margin_abs_difference_max':max(map(abs,drift)) if drift else None}
    name='pilot-output-audit.json' if a.pilot is not None else 'output-audit.json'
    (r/name).write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
    if failures or pending:raise SystemExit(1)


if __name__=='__main__':main()
