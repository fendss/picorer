"""Small deterministic tests; synthetic fixtures are NEVER experimental data."""
import importlib.util
import json
import sys
from pathlib import Path

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'sufficiency-dynamics-20260912'))
spec=importlib.util.spec_from_file_location('prepare_interventions',HERE/'prepare.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

assert m.utf16slice('A😀B',1,3)=='😀'
assert m.merge([[2,4],[0,2],[7,8],[3,6]])==[[0,6],[7,8]]
assert m.project('A😀B',[[0,4]])=='A😀B'
assert m.project('abcdef',[[0,2],[4,6]])=='[source chars 0-2 of 6]\nab\n\n[… source content omitted; read this candidate again if another passage is needed …]\n\n[source chars 4-6 of 6]\nef'
request={'messages':[{'role':'tool','content':'<READ_RESULT>\n  retained read\n</READ_RESULT>\n<MEMORY>\nModel working state\n  retained note\nLatest uninspected findings\n- Other · read C1\n  first preview\n- Other · read C2\n  second preview\n</MEMORY>'}]}
spans=m.preview_spans(request)
assert len(spans)==2
modified=m.replace_previews(request,spans,['replacement one','replacement two'])
assert '  retained note' in modified['messages'][0]['content']
assert '  retained read' in modified['messages'][0]['content']
assert 'first preview' in request['messages'][0]['content']
assert m.replace_previews(modified,m.preview_spans(modified),['',''])==m.replace_previews(request,spans,['',''])
ordered={'tools':[{'parameters':{'properties':{'z':{},'a':{}}}}]}
restored=json.loads(json.dumps(ordered,separators=(',',':')))
assert list(restored['tools'][0]['parameters']['properties'])==['z','a']
assert json.dumps(ordered)!=json.dumps(ordered,sort_keys=True)
print('8 integrity assertions passed; no experimental outcomes used')
