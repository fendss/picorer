"""Fetch terminal artifacts with a read-only remote program, caching locally."""
import json
import gzip
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
destination = ROOT/'raw-terminal-artifacts.json.gz'
if destination.exists():
    raise SystemExit('Cache exists; inspect or use it rather than silently overwriting.')
result = subprocess.run(
    ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'zgy-direct', 'python3 -'],
    input=(ROOT/'extract_remote.py').read_bytes(), stdout=subprocess.PIPE, check=True,
)
destination.write_bytes(result.stdout)
data = json.loads(gzip.decompress(result.stdout))
print(destination, len(result.stdout), 'bytes')
print(json.dumps(data['source_logs'], indent=2))
