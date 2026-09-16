"""Freeze audited exact-package states and two controlled interventions.

No inference or mutation of the original experiments. Run on the data server.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from collections import Counter
from pathlib import Path

BASE = Path('/data/zhaogangyi/picorer-eval')
ROOTS = [BASE / ('qwen36-v100-sufficiency-dynamics' + suffix + '-20260912')
         for suffix in ['', '-replicate-2', '-replicate-3']]
sys.path.insert(0, str(ROOTS[0]/'bin'))
from compute_state_coverage import map_audits, normalize_text, expected_result_path
from run_measurements_v2 import write_json_atomic as save, recursive_text


def read(p):
    return json.loads(Path(p).read_text())


def lines(p):
    return [json.loads(s) for s in Path(p).read_text().splitlines() if s.strip()]


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def utf16slice(s, start, end):
    return s.encode('utf-16-le')[2*start:2*end].decode('utf-16-le')


def project(full, spans):
    length = len(full.encode('utf-16-le'))//2
    if spans == [[0, length]]:
        return full
    return '\n\n[… source content omitted; read this candidate again if another passage is needed …]\n\n'.join(
        f'[source chars {a}-{b} of {length}]\n{utf16slice(full,a,b)}' for a,b in spans)


def merge(spans):
    merged = []
    for a,b in sorted(spans):
        if merged and a <= merged[-1][1]: merged[-1][1] = max(b, merged[-1][1])
        else: merged.append([a,b])
    return merged


def render_answer(question, evidence):
    memories=[]
    for e in evidence:
        memories.append('\n'.join(['<memory>', f'memory_id: {e["memoryId"]}',
            f'session_id: {e["sessionId"]}', f'turn_index: {e["turnIndex"]}',
            f'role: {e["role"]}', f'timestamp: {e.get("timestamp") or "unknown"}',
            'content:', e['content'], '</memory>']))
    return '\n'.join([f'<retrieval_package selected_sources="{len(evidence)}">',
        '</retrieval_package>', '<memory_context authority="read_exact_sources">',
        *(memories or ['None']), '</memory_context>', f'User: {question}'])


def answer_request(question, evidence):
    return {'model':'qwen3.6-27b','reasoning_effort':'low',
        'max_completion_tokens':16384,'temperature':0.7,'top_p':0.8,
        'messages':[{'role':'system','content':'You are a helpful assistant that can read the context and memorize it for future retrieval.'},
                    {'role':'user','content':render_answer(question,evidence)}]}


def matched(text, gold):
    norm=normalize_text(text)
    return [h['hop_index'] for h in gold['gold_hops'] if h['normalized_statement'] in norm]


def canonical_request(base, evidence):
    req=copy.deepcopy(base)
    req['messages']=req['messages'][:2]
    refs=[f'C{i+1}' for i in range(len(evidence))]
    req['messages'] += [
        {'role':'assistant','content':'','tool_calls':[{'id':'controlled-search','type':'function',
            'function':{'name':'search','arguments':json.dumps({'queries':['source evidence']})}}]},
        {'role':'tool','tool_call_id':'controlled-search','content':'[search payload expired from active context; discovered uninspected candidates remain directly readable in the latest <MEMORY> directory.]'},
        {'role':'assistant','content':'','tool_calls':[{'id':'controlled-read','type':'function',
            'function':{'name':'read','arguments':json.dumps({'candidateRefs':refs})}}]},
        {'role':'tool','tool_call_id':'controlled-read','content':
            '<READ_RESULT>\nInspected exact passages (visible for this reasoning turn). Their immutable parent sources are retained privately for final handoff:\n'+
            '\n\n'.join(f'[evidence:E{i+1}; candidate:C{i+1}; read:true; auto_commit_on_finish:true] other\n{e["content"]}' for i,e in enumerate(evidence))+
            '\n</READ_RESULT>\n<MEMORY>\nModel working state (confirmed facts and unresolved needs)\nNo model-authored working state yet.\n\nSearches remaining: 7\n\nInspected evidence ledger\nExact payloads are retained privately and not repeated in this observation. Every exact source returned by read is committed when finish succeeds.\n'+
            '\n'.join(f'- Other · evidence E{i+1} · inspected from C{i+1}' for i in range(len(evidence)))+
            '\n\nUninspected candidates\n- None.\n</MEMORY>'}]
    return req


def preview_spans(request):
    """Only indented candidate preview bodies inside the active MEMORY block."""
    result=[]
    for mi,m in enumerate(request['messages']):
        if m.get('role')!='tool' or not isinstance(m.get('content'),str):continue
        text=m['content']
        for block in re.finditer(r'<MEMORY>(.*?)</MEMORY>',text,re.S):
            body=block.group(1)
            heading=body.find('Latest uninspected findings')
            if heading<0: continue
            offset=block.start(1)+heading
            for match in re.finditer(r'(?m)^  ([^\n]+)$',text[offset:block.end(1)]):
                result.append((mi,offset+match.start(1),offset+match.end(1)))
    return result


def replace_previews(request, spans, replacements):
    out=copy.deepcopy(request)
    for (mi,a,b),value in reversed(list(zip(spans,replacements))):
        s=out['messages'][mi]['content'];out['messages'][mi]['content']=s[:a]+value+s[b:]
    return out


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,required=True)
    args=ap.parse_args();out=args.output
    if (out/'manifest.json').exists():raise RuntimeError('Refuse to overwrite frozen manifest')
    goldspec=read(ROOTS[2]/'coverage-v1/code/gold-spec.json')
    golds={g['qa_pair_id']:g for g in goldspec['questions']}
    save(out/'gold-spec.json',goldspec)
    # Immutable content-addressed blobs make all job inputs reproducible.
    def blob(value):
        # Chat-template tool serialization makes JSON field order significant.
        s=json.dumps(value,ensure_ascii=False,separators=(',',':'))
        digest=sha(s);p=out/'blobs'/f'{digest}.json'
        if not p.exists():
            p.parent.mkdir(parents=True,exist_ok=True)
            fd,name=tempfile.mkstemp(dir=p.parent,prefix='.input-')
            with os.fdopen(fd,'w') as f:f.write(s+'\n');f.flush();os.fsync(f.fileno())
            os.replace(name,p)
        return str(p)
    units=[];checks=[];bases={};formatted={};pool={};state_units=[]
    for run,root in enumerate(ROOTS,1):
        states=lines(root/'decision-states-v2/index.jsonl')
        byid={q['id']:q for q in read(root/'manifest-full.json')['questions']}
        coverage={(s['question_id'],s['decision_step']):s for s in lines(root/'coverage-v1/states.jsonl')}
        audits=map_audits(root)
        conn=sqlite3.connect(f'file:{root}/runtime/memory-service/memory.sqlite?mode=ro',uri=True)
        contents=dict(conn.execute('SELECT memory_id, content FROM memories'));conn.close()
        if run==1:
            for full in contents.values():
                for m in re.finditer(r'(?<!\d)(\d+)\.\s+([^\n]*?)(?=\s+\d+\.\s|\n|$)',full):
                    fact=m.group(0).strip()
                    if len(fact)>20:pool.setdefault(int(m.group(1)),fact)
        cursors={};ledgers={}
        for st in states:
            qid=st['question_id'];step=st['decision_step'];q=byid[qid];g=golds[q['payload']['qa_pair_id']]
            audit=audits[qid];ledger=ledgers.setdefault(qid,{})
            final_byid={e['memoryId']:e for e in audit['retrieval']['evidence']}
            evidence=list(ledger.values())
            reqpath=Path(st['capture_dir'])/'request.body'
            assert hashlib.sha256(reqpath.read_bytes()).hexdigest()==st['request_sha256']
            req=read(reqpath)
            if run==1 and step==1:bases[qid]=req;formatted[qid]=audit['question']
            hops=matched('\n'.join(e['content'] for e in evidence),g)
            cov=coverage[(qid,step)]
            assert set(hops)==set(cov['covered_hop_indices']),(run,qid,step,hops,cov['covered_hop_indices'])
            native=[read(expected_result_path(root,st,r))['native_s'] for r in ['qwen-r1','qwen-r2']]
            unit={'id':f'state-r{run}-q{q["ordinal"]:03d}-t{step:03d}',
                'experiment':'state_answers','question_id':qid,'ordinal':q['ordinal'],'run':run,'step':step,
                'trajectory_length':st['decision_state_count'],'r':len(hops)/len(g['gold_hops']),
                'gold_hops':len(g['gold_hops']),'conflicted':g['official_gold_lww_conflicted'],
                'answers':g['answers'],'data_dir':q['payload']['data_dir'],
                'native_original':native,'original_request':str(reqpath),'original_request_sha256':st['request_sha256'],
                'native_original_prefixes':[str(expected_result_path(root,st,r).parent/'native-s.request.json') for r in ['qwen-r1','qwen-r2']],
                'evidence':blob(evidence),'answer_request':blob(answer_request(audit['question'],evidence))}
            units.append(unit);state_units.append((unit,req,g))
            # Apply current actions only AFTER freezing the pre-action state.
            trace=audit['retrieval']['trace'];cursor=cursors.get(qid,0)
            for action in st['action_tool_calls']:
                tr=trace[cursor];cursor+=1
                assert tr['toolCallId']==action['tool_call_id'] and tr['toolName']==action['name']
                if tr['toolName']!='read' or tr.get('isError'):continue
                for e in tr['details']['evidence']:
                    mid=e['memoryId'];full=contents[mid]
                    assert sha(full)==e['sourceContentHash']
                    spans=[[x['start'],x['end']] for x in e['excerpts']]
                    incoming=project(full,spans)
                    assert sha(incoming)==e['contentHash'],('projection hash',mid)
                    old=ledger.get(mid)
                    if old:spans=merge(spans+[[x['start'],x['end']] for x in old['excerpts']])
                    rebuilt=copy.deepcopy(final_byid[mid]);rebuilt['content']=project(full,spans)
                    rebuilt['contentHash']=sha(rebuilt['content'])
                    rebuilt['excerpts']=[{'start':a,'end':b,'content':utf16slice(full,a,b)} for a,b in spans]
                    rebuilt['truncated']=spans!=[[0,len(full.encode('utf-16-le'))//2]]
                    ledger[mid]=rebuilt
            cursors[qid]=cursor
            if step==st['decision_state_count']:
                assert cursor==len(trace)
                assert set(ledger)==set(final_byid)
                assert all(ledger[mid]['contentHash']==final_byid[mid]['contentHash'] for mid in ledger)
                # Reproduce the original final wrapper, including its optional full-parent expansion.
                final_evidence=audit['retrieval']['evidence']
                full_evidence=[dict(e,content=contents[e['memoryId']]) for e in final_evidence]
                full_prompt=render_answer(audit['question'],full_evidence)
                prompt=full_prompt if len(full_prompt.encode())<=128*1024 else render_answer(audit['question'],final_evidence)
                assert prompt==audit['prompt'],('final wrapper mismatch',run,qid)
                checks.append({'run':run,'question_id':qid,'terminal_ledger_hash_match':True,
                    'original_handoff_reproduced':True,'original_handoff_expanded':prompt!=render_answer(audit['question'],final_evidence)})
        print(json.dumps({'prepared_run':run,'states':len(states),'terminal_audits':len(checks)}),flush=True)
    pool_values=[v for _,v in sorted(pool.items())]
    # Deterministic real, unrelated source facts matched approximately on word count.
    def distractor(g,target,salt=0):
        terms=[h['cloze'].strip().lower() for h in g['gold_hops']]+[str(h['answer']).lower() for h in g['gold_hops']]
        # Reject facts mentioning gold subjects or intermediate/final answer strings.
        entities=[re.sub(r'^(the |a |an )','',h['cloze'].lower()).split(' is ')[0].split(' was ')[0] for h in g['gold_hops']]
        banned=[s for s in terms+entities if len(s)>=3]
        eligible=[s for s in pool_values if not any(t in s.lower() for t in banned)]
        target_words=len(target.split())
        ranked=sorted(eligible,key=lambda s:(abs(len(s.split())-target_words),sha(str(salt)+s)))
        assert ranked
        return ranked[0]
    # All gold subsets, with forward/reverse evidence order. No hidden gold labels in prompts.
    distractors={}
    for qid,base in sorted(bases.items()):
        g=golds[qid.split('/')[-1]];hops=g['gold_hops'];h=len(hops);ordinal=g['ordinal']
        controls=[distractor(g,x['raw_fact'],ordinal*10+i) for i,x in enumerate(hops)]
        distractors[qid]=controls
        for order in [0,1]:
            positions=list(range(h)) if order==0 else list(reversed(range(h)))
            for mask in range(2**h):
                evidence=[]
                for pos,i in enumerate(positions):
                    content=hops[i]['raw_fact'] if mask&(1<<i) else controls[i]
                    evidence.append({'memoryId':f'controlled-source-{pos+1}','sessionId':f'controlled-session-{pos+1}',
                        'turnIndex':0,'role':'other','content':content})
                expected=[i+1 for i in range(h) if mask&(1<<i)]
                request=canonical_request(base,evidence)
                assert matched('\n'.join(e['content'] for e in evidence),g)==expected
                assert matched(recursive_text(request['messages']),g)==expected,(qid,mask,expected,matched(recursive_text(request['messages']),g))
                units.append({'id':f'coverage-q{ordinal:03d}-o{order}-m{mask:02d}',
                    'experiment':'coverage','question_id':qid,'ordinal':ordinal,'order':order,'mask':mask,
                    'r':len(expected)/h,'gold_hops':h,'conflicted':g['official_gold_lww_conflicted'],
                    'answers':g['answers'],'native_request':blob(request),'evidence':blob(evidence),
                    'answer_request':blob(answer_request(formatted[qid],evidence))})
    excluded=[]
    for unit,req,g in state_units:
        spans=preview_spans(req)
        if not spans:
            excluded.append({'state':unit['id'],'reason':'no_active_preview_body'});continue
        original=[req['messages'][mi]['content'][a:b] for mi,a,b in spans]
        none_req=replace_previews(req,spans,['']*len(spans))
        covered=matched('\n'.join(e['content'] for e in read(unit['evidence'])),g)
        elsewhere=matched(recursive_text(none_req['messages']),g)
        outside=normalize_text(recursive_text(none_req['messages'])+'\n'+
                               '\n'.join(e['content'] for e in read(unit['evidence'])))
        eligible=[h for h in g['gold_hops'] if h['hop_index'] not in set(covered+elsewhere)
                  and normalize_text(h['answer']) not in outside]
        replacements=[distractors[unit['question_id']][i%len(distractors[unit['question_id']])] for i in range(len(spans))]
        # Keep approximately the original preview lengths by repeating unrelated facts.
        replacements=[' '.join([s]*max(1,round(len(o.split())/len(s.split())))) for s,o in zip(replacements,original)]
        versions={'original':req,'removed':none_req,'irrelevant':replace_previews(req,spans,replacements)}
        # A single intervention introduces ALL eligible missing hops, spread across slots.
        if eligible:
            rel=list(replacements)
            for i,h in enumerate(eligible):
                slot=i%len(rel);words=rel[slot].split();k=len(h['raw_fact'].split())
                rel[slot]=h['raw_fact']+' '+' '.join(words[k:])
            versions['relevant']=replace_previews(req,spans,rel)
        else:excluded.append({'state':unit['id'],'reason':'no_missing_gold_absent_elsewhere','excluded_condition':'relevant'})
        for condition,request in versions.items():
            u={k:v for k,v in unit.items() if k not in ['answer_request','native_original']}
            u.update(id=unit['id']+'-preview-'+condition,experiment='preview',parent_state=unit['id'],
                condition=condition,native_request=blob(request),preview_slots=len(spans),
                introduced_hops=[h['hop_index'] for h in eligible] if condition=='relevant' else [])
            # Verify every byte outside the registered preview bodies is unchanged.
            assert replace_previews(request,preview_spans(request),['']*len(preview_spans(request)))==none_req if condition!='removed' else request==none_req
            units.append(u)
    jobs=[]
    for u in units:
        if 'native_request' in u:
            for replica in [0,1]:
                job={'id':u['id']+f'-s{replica}','unit':u['id'],'kind':'native','replica':replica,'request':u['native_request']}
                if u['experiment']=='preview' and u['condition']=='original':job['expected_prefix']=u['native_original_prefixes'][replica]
                jobs.append(job)
        if 'answer_request' in u:
            for sample in range(5):
                jobs.append({'id':u['id']+f'-a{sample}','unit':u['id'],'kind':'answer','sample':sample,
                    'replica':(u['ordinal']+sample)%2,'seed':int(sha(u['id']+f':{sample}')[:8],16)%(2**31),
                    'request':u['answer_request'],'answers':u['answers']})
    save(out/'units.json',units);save(out/'jobs.json',jobs)
    save(out/'input-audit.json',{'terminal_checks':checks,'preview_exclusions':excluded,
        'all_state_coverage_reproduced':True,'all_source_and_projection_hashes_verified':True,
        'answer_handoff':'exact_package_no_parent_expansion','source_roots':list(map(str,ROOTS))})
    manifest={'schema_version':1,'questions':len(golds),'units':dict(Counter(u['experiment'] for u in units)),
        'jobs':dict(Counter(j['kind'] for j in jobs)),'total_jobs':len(jobs),'answers_per_condition':5,
        'replicas':['http://172.16.200.114:18081','http://172.16.200.114:18082'],
        'gpu_indices':[7,4],'no_J':True,'pilot_ordinals':list(range(10)),
        'coverage_orders':['forward','reverse'],'length_control':'approximate_word_matched; actual token counts retained',
        'input_order_preserved':True,'code_sha256':sha(Path(__file__).read_text())}
    save(out/'manifest.json',manifest);print(json.dumps(manifest,indent=2),flush=True)


if __name__=='__main__':main()
