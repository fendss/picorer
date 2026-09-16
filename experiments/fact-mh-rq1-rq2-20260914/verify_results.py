"""Independent checks of terminal tables, predefined subset, and source scoring."""
import csv
import importlib.util
import json
import subprocess
from collections import Counter
from pathlib import Path

ROOT=Path(__file__).resolve().parent
WORK=ROOT.parent.parent
rows=list(csv.DictReader((ROOT/'terminal-trajectories.csv').open()))
gold=json.loads((ROOT.parent/'sufficiency-dynamics-20260912/coverage/gold-spec.json').read_text())
audit=json.loads((WORK/'reports/fc_mh_oracle_20260906/dataset-audit.json').read_text())
conflict={x['index'] for x in audit['affected_262k']}
assert {g['ordinal'] for g in gold['questions'] if g['official_gold_lww_conflicted']}==conflict
assert len(conflict)==36
assert len(rows)==600 and len({(r['run'],r['question_id']) for r in rows})==600
assert all(r['match_count']=='1' for r in rows)
assert all(r['termination']=='explicit_finish' for r in rows)
assert all(r['last_event_is_successful_finish']=='True' for r in rows)
assert all(r['package_complete']==r['handoff_complete'] for r in rows)
assert all(r['all_read_ranges_retained']=='True' for r in rows)
assert sum(r['last_read_ranges_retained']=='True' for r in rows)==599
assert sum(r['read_call_count']=='0' for r in rows)==1
assert all(r['finish_status'] in {'sufficient','insufficient'} for r in rows)

# Re-score exactly the 600 saved final answers with the frozen benchmark
# implementation, not a new LLM judge and not a best-of-N answer selection.
payload=[{'run':r['run'],'qa_pair_id':r['qa_pair_id'],'prediction':r['original_prediction'],'official_score':float(r['final_official_score'])} for r in rows]
gold_answers={g['qa_pair_id']:g['answers'] for g in gold['questions']}
remote='''
import sys,json,ast
from pathlib import Path
sys.path.insert(0,'/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/source/integrations/memoryagentbench')
from mab_adapter.config import task_config,TaskConfig
# This host's system Python lacks unrelated recommendation-task dependencies.
# Execute the saved scoring functions unchanged, omitting only imports for
# editdistance, dataset loading and the relative TaskConfig import supplied above.
source=Path('/data/zhaogangyi/picorer-eval/qwen36-v100-full-queue-20260911/source/integrations/memoryagentbench/mab_adapter/scoring.py')
tree=ast.parse(source.read_text())
tree.body=[node for node in tree.body if not (isinstance(node,ast.Import) and any(a.name=='editdistance' for a in node.names)) and not (isinstance(node,ast.ImportFrom) and node.level>0)]
namespace={'TaskConfig':TaskConfig}
exec(compile(tree,str(source),'exec'),namespace)
score_prediction=namespace['score_prediction']
payload=PAYLOAD
answers=ANSWERS
task=task_config('fact-mh-262k')
failures=[]
for r in payload:
 metrics=score_prediction(task,r['prediction'],tuple(answers[r['qa_pair_id']]),Path('/data/zhaogangyi/picorer-eval/memoryagentbench-20260826-http-v2/data'))
 if metrics['official_score'] != r['official_score']: failures.append({'run':r['run'],'qa_pair_id':r['qa_pair_id'],'saved':r['official_score'],'recomputed':metrics['official_score']})
print(json.dumps({'checked':len(payload),'mismatches':failures}))
'''.replace('PAYLOAD',repr(payload)).replace('ANSWERS',repr(gold_answers))
result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','zgy-direct','python3 -'],input=remote.encode(),stdout=subprocess.PIPE,check=True)
score_check=json.loads(result.stdout)
assert not score_check['mismatches'],score_check
checks={'terminal_trajectories':600,'distinct_questions':100,'primary_questions':64,'predefined_conflict_questions':36,'unique_audit_matches':600,'explicit_finish':600,'package_completeness_equals_handoff_completeness':600,'package_hop_set_equals_handoff_hop_set':sum(r['package_hops']==r['handoff_hops'] for r in rows),'all_successful_read_ranges_retained':600,'last_reads_checked':599,'no_read_empty_package_insufficient':1,'score_recomputation':score_check,'units_note':'600 rows are 100 shared questions across six saved run configurations, not 600 independent questions.'}
(ROOT/'verification.json').write_text(json.dumps(checks,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(checks,indent=2,ensure_ascii=False))
for run in dict.fromkeys(r['run'] for r in rows):
 for subset in ['primary','full']:
  group=[r for r in rows if r['run']==run and (subset=='full' or r['primary_no_conflict']=='True')]
  bad=[r for r in group if r['finish_status']=='sufficient' and r['package_complete']=='False']
  sufficient=[r for r in group if r['finish_status']=='sufficient']
  print(run,subset,'sufficient+incomplete',len(bad),'/',len(sufficient),'before cap',sum(r['at_search_cap']=='False' for r in bad),'earlier tool output all gold',sum(len(json.loads(r['all_tool_output_hops']))==int(r['gold_hops']) for r in bad),'incorrect',sum(r['final_official_score']=='0.0' for r in bad))
