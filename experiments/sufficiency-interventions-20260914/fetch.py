"""One-shot collection from the frozen v2 run; no recurring monitor."""
import subprocess
from pathlib import Path

ROOT='/data/zhaogangyi/picorer-eval/sufficiency-interventions-20260914-v2'
HERE=Path(__file__).resolve().parent
subprocess.run(['ssh','-o','BatchMode=yes','zgy-direct',
    f'/data/zhaogangyi/picorer-eval/queue-infra/question-pipeline-v2/.venv/bin/python {ROOT}/code/collect.py --root {ROOT}'],check=True)
for folder in ['summary','analysis','pilot-analysis']:
    exists=subprocess.run(['ssh','-o','BatchMode=yes','zgy-direct',f'test -d {ROOT}/{folder}']).returncode==0
    if exists:subprocess.run(['scp','-r',f'zgy-direct:{ROOT}/{folder}',str(HERE)+'/'],check=True)
for filename in ['manifest.json','pilot-progress.json','full-progress.json','pilot-output-audit.json',
                 'output-audit.json','suite-complete.json','supervisor-failure.json']:
    exists=subprocess.run(['ssh','-o','BatchMode=yes','zgy-direct',f'test -f {ROOT}/{filename}']).returncode==0
    if exists:subprocess.run(['scp',f'zgy-direct:{ROOT}/{filename}',str(HERE/filename)],check=True)
print('Downloaded available results; summary/status.json distinguishes complete from pending jobs.')
