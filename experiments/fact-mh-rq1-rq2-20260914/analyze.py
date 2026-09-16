"""Terminal-only audit; no intermediate repeated answers or sufficiency scores.

One row = one finalized trajectory (question x saved run). Ambiguous audit
matches remain missing, with all candidates retained in match-audit.json.
"""
import csv
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GOLD_PATH = ROOT.parent/'sufficiency-dynamics-20260912/coverage/gold-spec.json'

def normalize(value):
    return ' '.join(value.casefold().strip().rstrip('.').split())

def coverage(texts, gold):
    sources = [normalize(t) for t in texts]
    return [h['hop_index'] for h in gold['gold_hops'] if any(h['normalized_statement'] in t for t in sources)]

def csv_write(path, rows):
    with path.open('w', newline='') as out:
        writer = csv.DictWriter(out, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v for k, v in row.items()})

def audit_stats(a, gold):
    r = a['retrieval']
    evidence = r.get('evidence') or []
    trace = r.get('trace') or []
    finishes = [(i, t) for i, t in enumerate(trace) if t.get('toolName') == 'finish' and not t.get('isError') and (t.get('details') or {}).get('kind') == 'finish']
    reads = [(i,t) for i,t in enumerate(trace) if t.get('toolName') == 'read' and not t.get('isError') and (t.get('details') or {}).get('kind') == 'read']
    final_hops = coverage([e['content'] for e in evidence], gold)
    # Exclude instructions and the question after </memory_context>.
    prompt = a['prompt']
    assert '</memory_context>' in prompt
    handoff_text = prompt.split('</memory_context>', 1)[0]
    handoff_hops = coverage([handoff_text], gold)
    final_ids = {e['memoryId'] for e in evidence}
    read_ids = {e['memoryId'] for _,t in reads for e in (t.get('details') or {}).get('evidence', [])}
    last_read_ids = {e['memoryId'] for e in reads[-1][1]['details'].get('evidence', [])} if reads else set()
    read_gold = coverage([c.get('text','') for _,t in reads for c in t.get('content',[]) if c.get('type') == 'text'], gold)
    # Tool read output can contain neighboring-source previews; not an exact-read
    # ledger, not a reconstruction of the complete model context.
    trace_gold = coverage([c.get('text','') for t in trace for c in t.get('content',[]) if c.get('type') == 'text'], gold)
    status = finishes[-1][1]['args'].get('status') if finishes else None
    selected_status = (finishes[-1][1].get('details',{}).get('selection') or {}).get('status') if finishes else None
    commit_ids = {e['memoryId'] for e in finishes[-1][1]['details'].get('committedEvidence',[])} if finishes else set()
    hash_ok = all(hashlib.sha256(e['content'].encode()).hexdigest() == e['contentHash'] for e in evidence)
    by_id = {e['memoryId']:e for e in evidence}
    def retained(read):
        for item in read['details'].get('evidence', []):
            final = by_id.get(item['memoryId'])
            if final is None or item['sourceContentHash'] != final['sourceContentHash']:
                return False
            for span in item['excerpts']:
                if not any(e['start'] <= span['start'] and e['end'] >= span['end'] for e in final['excerpts']):
                    return False
        return True
    op = a.get('operatorExperiment') or {}
    return {
        'wrap_id': a['wrap_id'], 'wrap_created_at': a['created_at'],
        'log_line': a['source_line'], 'log_sha256': a['source_line_sha256'],
        'retrieval_status': r['status'], 'finish_status': status,
        'finish_selection_status': selected_status,
        'successful_finish_count': len(finishes),
        'last_event_is_successful_finish': bool(finishes and finishes[-1][0] == len(trace)-1),
        'termination': 'explicit_finish' if finishes and status == r['status'] == selected_status else 'unresolved',
        'search_calls': op.get('searchCalls'), 'max_search_calls': op.get('maxSearchCalls'),
        'at_search_cap': op.get('searchCalls') == op.get('maxSearchCalls'),
        'tool_errors': sum(bool(t.get('isError')) for t in trace),
        'trace_event_count': len(trace), 'read_call_count': len(reads),
        'final_evidence_sources': len(evidence), 'final_evidence_hashes_valid': hash_ok,
        'finish_commit_matches_final_ids': commit_ids == final_ids,
        'all_read_source_ids_retained': read_ids <= final_ids,
        'last_read_source_ids_retained': last_read_ids <= final_ids,
        'all_read_ranges_retained': all(retained(t) for _,t in reads),
        'last_read_ranges_retained': retained(reads[-1][1]) if reads else None,
        'last_read_precedes_finish': bool(reads and finishes and reads[-1][0] < finishes[-1][0]),
        'gold_hops': len(gold['gold_hops']), 'package_hops': final_hops,
        'package_complete': len(final_hops) == len(gold['gold_hops']),
        'handoff_hops': handoff_hops,
        'handoff_complete': len(handoff_hops) == len(gold['gold_hops']),
        'read_tool_output_hops': read_gold, 'all_tool_output_hops': trace_gold,
        'handoff_prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
        'handoff_bytes': len(prompt.encode()),
    }

def main():
    data = json.loads(gzip.decompress((ROOT/'raw-terminal-artifacts.json.gz').read_bytes()))
    provenance = json.loads((ROOT/'provenance.json').read_text())
    native_by_id = {'agentmemorybench:fact-mh-262k:'+r['benchmark_query_id']:r for r in provenance['native_data']}
    gold_doc = json.loads(GOLD_PATH.read_text())
    gold_by_qa = {g['qa_pair_id']:g for g in gold_doc['questions']}
    rows, matches = [], []
    for run, info in data['runs'].items():
        log = 'shared_rq1' if run.startswith('rq1_') else run
        pool = data['audits'][log]
        counts = Counter()
        for q in info['records']:
            gold = gold_by_qa[q['payload']['qa_pair_id']]
            assert normalize(q['payload']['question']) == normalize(gold['question'])
            assert q['payload']['answers'] == gold['answers']
            out = q['stages']['retrieval']['artifact']['output']
            candidates = [a for a in pool if a['userId'] == q['payload']['user_id'] and a['question'] == out['formatted_query'] and a['retrieval']['retrievalModel'] == out['retrieval_model'] and a['operatorExperiment'] == out['operator_experiment']]
            method = 'query_user_model_operator_metadata'
            if 'wrapped_prompt' in out:
                candidates = [a for a in candidates if a['prompt'] == out['wrapped_prompt']]
                method += '_exact_prompt'
            if run == 'rq1_qwen' and q['stages']['retrieval']['artifact'].get('seeded_from_prior_run'):
                native = native_by_id[q['id']]
                assert not native.get('failure')
                assert native['output'] == q['stages']['answer']['artifact']['output']['prediction']
                assert native['operator_experiment'] == out['operator_experiment']
                assert native['metrics'] == q['stages']['evaluation']['artifact']['output']['metrics']
                if len(candidates) > 1:
                    # Explicitly identified separate preflight artifacts are not
                    # the native-run retrieval that was migrated with its answer.
                    canary_hashes = {c['prompt_sha256'] for c in provenance['canaries'] if c['question_id'] == q['id']}
                    candidates = [a for a in candidates if hashlib.sha256(a['prompt'].encode()).hexdigest() not in canary_hashes]
                    method += '_native_answer_verified_exclude_identified_preflight'
            # Never pick first/latest from duplicates, even if scores agree.
            counts[len(candidates)] += 1
            row = {'run':run, 'question_id':q['id'], 'qa_pair_id':q['payload']['qa_pair_id'], 'question':gold['question'], 'backbone':out['retrieval_model']['modelId'], 'thinking_level':out['retrieval_model'].get('thinkingLevel'), 'primary_no_conflict':not gold['official_gold_lww_conflicted'], 'match_count':len(candidates), 'match_method':method, 'all_stages_completed':all(s['status']=='completed' for s in q['stages'].values()), 'final_official_score':q['stages']['evaluation']['artifact']['output']['metrics']['official_score'], 'original_prediction':q['stages']['answer']['artifact']['output']['prediction']}
            stats = [audit_stats(a,gold) for a in candidates]
            matches.append({'run':run,'question_id':q['id'],'candidates':stats})
            if len(stats)==1:
                row.update(stats[0])
            rows.append(row)
        print(run, 'matches', dict(counts), flush=True)
    fields = list(dict.fromkeys(k for row in rows for k in row))
    csv_write(ROOT/'terminal-trajectories.csv',[{k:r.get(k) for k in fields} for r in rows])
    (ROOT/'match-audit.json').write_text(json.dumps(matches, indent=2,ensure_ascii=False)+'\n')
    summaries = []
    cross_tabs = []
    for run in data['runs']:
        for subset in ['primary64','full100']:
            group = [r for r in rows if r['run']==run and (subset=='full100' or r['primary_no_conflict'])]
            matched = [r for r in group if r['match_count']==1]
            summary = {'run':run,'subset':subset,'questions':len({r['question_id'] for r in group}),'trajectories':len(group),'correct':sum(r['final_official_score'] for r in group),'matched_trajectories':len(matched),'sufficient':sum(r['finish_status']=='sufficient' for r in matched),'insufficient':sum(r['finish_status']=='insufficient' for r in matched),'package_incomplete':sum(not r['package_complete'] for r in matched),'handoff_incomplete':sum(not r['handoff_complete'] for r in matched),'sufficient_package_incomplete':sum(r['finish_status']=='sufficient' and not r['package_complete'] for r in matched),'sufficient_handoff_incomplete':sum(r['finish_status']=='sufficient' and not r['handoff_complete'] for r in matched),'sufficient_package_incomplete_correct':sum(r['finish_status']=='sufficient' and not r['package_complete'] and r['final_official_score']==1 for r in matched),'sufficient_handoff_incomplete_correct':sum(r['finish_status']=='sufficient' and not r['handoff_complete'] and r['final_official_score']==1 for r in matched),'at_search_cap':sum(r['at_search_cap'] for r in matched)}
            summaries.append(summary)
            for (status, package, handoff, correct), count in Counter((r['finish_status'],r['package_complete'],r['handoff_complete'],r['final_official_score']) for r in matched).items():
                cross_tabs.append({'run':run,'subset':subset,'finish_status':status,'package_complete':package,'handoff_complete':handoff,'correct':correct,'trajectories':count})
    csv_write(ROOT/'summary.csv',summaries)
    csv_write(ROOT/'cross-tabs.csv',cross_tabs)
    print(json.dumps(summaries,indent=2))
    print('CHECKS', {key:dict(Counter(r.get(key) for r in rows)) for key in ['termination','last_event_is_successful_finish','final_evidence_hashes_valid','finish_commit_matches_final_ids','all_read_source_ids_retained','last_read_source_ids_retained','all_read_ranges_retained','last_read_ranges_retained','last_read_precedes_finish']})
    print('OTHER BACKBONES',data['other_backbone_inventory'])

if __name__ == '__main__':
    main()
