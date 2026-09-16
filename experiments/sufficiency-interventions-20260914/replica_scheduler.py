"""Bound execution by replica without changing jobs or their assigned endpoint."""
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED


def completed_jobs(jobs, execute, workers, replicas=2, mode='per-replica',
                   stopping=lambda: False, observe=lambda state: None):
    if mode not in ('shared', 'per-replica'):
        raise ValueError(mode)
    buckets = replicas if mode == 'per-replica' else 1
    if workers < buckets:
        raise ValueError('Need at least one worker per scheduling bucket')
    capacities = [workers // buckets + int(i < workers % buckets) for i in range(buckets)]
    queues = [deque() for _ in capacities]
    for job in jobs:
        replica = job['replica']
        if not 0 <= replica < replicas:
            raise ValueError('Invalid replica assignment')
        queues[replica if mode == 'per-replica' else 0].append(job)
    pending = {}
    active = Counter()
    with ThreadPoolExecutor(max_workers=workers) as executor:
        def fill():
            for bucket, capacity in enumerate(capacities):
                while queues[bucket] and active[bucket] < capacity and not stopping():
                    job = queues[bucket].popleft()
                    pending[executor.submit(execute, job)] = (job, bucket)
                    active[bucket] += 1
            observed = Counter(job['replica'] for job, _ in pending.values())
            observe({'mode': mode, 'capacity_per_bucket': capacities,
                     'inflight_per_replica': dict(observed),
                     'queued_per_bucket': [len(q) for q in queues]})
        fill()
        while pending:
            done, _ = wait(pending, timeout=5, return_when=FIRST_COMPLETED)
            for future in done:
                job, bucket = pending.pop(future)
                active[bucket] -= 1
                yield job, future
            fill()
