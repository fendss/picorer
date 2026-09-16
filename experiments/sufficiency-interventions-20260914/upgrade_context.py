"""One-time, approved restart of the existing GPU 4/7 replicas after draining."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess as sp
import time
import urllib.request

ROOT = Path('/data/zhaogangyi/qwen36-27b-service')
INSTANCE = ROOT / 'instances/gpu4-18082'
STAMP = time.strftime('%Y%m%d-%H%M%S', time.gmtime())


def call(*args):
    return sp.check_output(args, text=True).strip()


def get(port, route):
    with urllib.request.urlopen(f'http://172.16.200.114:{port}{route}', timeout=10) as r:
        return r.read().decode()


def validate(pid, port, gpu):
    argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    assert b'vllm' in b' '.join(argv) and str(port).encode() in argv, (pid, port)
    env = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    assert f'CUDA_VISIBLE_DEVICES={gpu}'.encode() in env, (pid, gpu)


pid7 = int(call('systemctl', '--user', 'show', 'qwen36-27b.service', '-p', 'MainPID', '--value'))
pid4 = int((INSTANCE / 'server.pid').read_text())
validate(pid7, 18081, 7)
validate(pid4, 18082, 4)
old = shlex.split((INSTANCE / 'start.sh').read_text())
new = shlex.split((INSTANCE / 'gpu4-start-262k.sh').read_text().replace('\\\n', ' '))
assert old.count('131072') == 1
assert ['262144' if x == '131072' else x for x in old] == new, 'Unexpected GPU 4 launcher changes'
deadline = time.time() + 1200
while True:
    counts = {}
    for port in (18081, 18082):
        metrics = get(port, '/metrics')
        values = re.findall(r'^vllm:num_requests_(?:running|waiting)\{[^\n]*\}\s+([\d.]+)$', metrics, re.M)
        assert len(values) == 2, 'Unknown metrics schema'
        counts[port] = sum(map(float, values))
    print(json.dumps({'event': 'draining', 'requests': counts}), flush=True)
    if not any(counts.values()):
        break
    if time.time() > deadline:
        raise RuntimeError('Drain timeout; services left unchanged')
    time.sleep(10)

validate(pid7, 18081, 7)
validate(pid4, 18082, 4)
dropdir = Path('/home/zhaogangyi/.config/systemd/user/qwen36-27b.service.d')
dropdir.mkdir(exist_ok=True)
drop = dropdir / 'context-262k.conf'
assert not drop.exists(), 'Refusing to overwrite an existing drop-in'
shutil.copy2(INSTANCE / 'context-262k.conf', drop)
shutil.copy2(INSTANCE / 'start.sh', INSTANCE / f'start.sh.before-262k-{STAMP}')
shutil.copy2(INSTANCE / 'deployment.json', INSTANCE / f'deployment.before-262k-{STAMP}.json')
shutil.copyfile(INSTANCE / 'gpu4-start-262k.sh', INSTANCE / 'start.sh')
stop7 = sp.Popen(['systemctl', '--user', 'stop', 'qwen36-27b.service'])
os.kill(pid4, signal.SIGTERM)
stop7.wait(timeout=150)
deadline = time.time() + 180
while True:
    free = [int(x) for x in call('nvidia-smi', '-i', '4,7', '--query-gpu=memory.free', '--format=csv,noheader,nounits').splitlines()]
    if min(free) >= 140000:
        break
    if time.time() > deadline:
        raise RuntimeError(f'Old services did not release GPU memory: {free}')
    time.sleep(5)
call('systemctl', '--user', 'daemon-reload')
call('systemctl', '--user', 'start', '--no-block', 'qwen36-27b.service')
with (INSTANCE / 'server.log').open('a') as log:
    p4 = sp.Popen(['bash', str(INSTANCE / 'start.sh')], cwd=ROOT, stdin=sp.DEVNULL,
                  stdout=log, stderr=sp.STDOUT, start_new_session=True)
(INSTANCE / 'server.pid').write_text(str(p4.pid))
audit = {'approved': True, 'timestamp': STAMP, 'old_pids': [pid4, pid7], 'gpu4_pid': p4.pid,
         'gpus': [4, 7], 'max_model_len_before': 131072, 'max_model_len_after': 262144,
         'other_generation_flags_changed': False, 'evidence_truncated': False}
(INSTANCE / f'context-upgrade-{STAMP}.json').write_text(json.dumps(audit, indent=2))
print(json.dumps({'event': 'services_starting', **audit}), flush=True)
