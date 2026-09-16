"""Record only public service configuration and GPU bindings after restart."""
import hashlib
import json
from pathlib import Path
import subprocess as sp
import time
import urllib.request

root = Path('/data/zhaogangyi/qwen36-27b-service')
instance = root / 'instances/gpu4-18082'
pids = {4: int((instance / 'server.pid').read_text()),
        7: int(sp.check_output(['systemctl', '--user', 'show', 'qwen36-27b.service', '-p', 'MainPID', '--value']))}
rows = []
for gpu, port in ((4, 18082), (7, 18081)):
    pid = pids[gpu]
    args = [x.decode() for x in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if x]
    env = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    assert f'CUDA_VISIBLE_DEVICES={gpu}'.encode() in env
    assert args[args.index('--port') + 1] == str(port)
    assert args[args.index('--max-model-len') + 1] == '262144'
    with urllib.request.urlopen(f'http://172.16.200.114:{port}/v1/models', timeout=10) as response:
        models = json.load(response)
    assert models['data'][0]['max_model_len'] == 262144
    rows.append({'gpu': gpu, 'port': port, 'pid': pid, 'argv': args, 'models': models})
result = {'verified_unix': time.time(), 'services': rows,
          'model_config_sha256': hashlib.sha256((root / 'models/Qwen3.6-27B/config.json').read_bytes()).hexdigest(),
          'gpus_added': [], 'max_model_len': 262144}
(instance / 'context-deployment-verified.json').write_text(json.dumps(result, indent=2))
(instance / 'deployment.json').write_text(json.dumps({'launcher_pid': pids[4],
    'verified_at': result['verified_unix'], 'gpu': 4, 'port': 18082,
    'model': 'Qwen3.6-27B', 'max_model_len': 262144}, indent=2))
print(json.dumps(result, indent=2))
