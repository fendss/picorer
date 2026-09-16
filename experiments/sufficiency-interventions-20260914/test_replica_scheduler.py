import threading
import time
import unittest
from collections import Counter
from replica_scheduler import completed_jobs


class SchedulingTest(unittest.TestCase):
    def test_capacity_assignment_order_and_no_starvation(self):
        jobs = [{'id': i, 'replica': 0 if i < 40 else 1} for i in range(80)]
        active = Counter(); peaks = Counter(); started = []; lock = threading.Lock()
        def execute(job):
            rep = job['replica']
            with lock:
                active[rep] += 1; peaks[rep] = max(peaks[rep], active[rep]); started.append(job['id'])
            time.sleep(.012 if rep == 0 else .002)
            with lock: active[rep] -= 1
            return job
        seen = []
        for job, future in completed_jobs(jobs, execute, 8):
            self.assertEqual(future.result(), job); seen.append(job['id'])
        self.assertEqual(sorted(seen), list(range(80)))
        self.assertTrue(all(v <= 4 for v in peaks.values()))
        self.assertTrue(any(i >= 40 for i in started[:8]))
        for rep in (0, 1):
            self.assertEqual([i for i in started if jobs[i]['replica'] == rep],
                             [j['id'] for j in jobs if j['replica'] == rep])

    def test_drain_finishes_only_inflight_and_error_does_not_stall(self):
        jobs = [{'id': i, 'replica': i % 2} for i in range(30)]
        stop = threading.Event()
        def execute(job):
            time.sleep(.01)
            if job['id'] == 0: raise RuntimeError('expected failure')
            return job
        seen = []
        for job, future in completed_jobs(jobs, execute, 4, stopping=stop.is_set):
            stop.set(); seen.append(job['id'])
            if job['id'] == 0:
                with self.assertRaises(RuntimeError): future.result()
            else: self.assertEqual(future.result(), job)
        self.assertEqual(sorted(seen), [0, 1, 2, 3])

    def test_shared_mode_and_empty(self):
        jobs = [{'id': i, 'replica': i % 2} for i in range(10)]
        self.assertEqual(sorted(j['id'] for j, f in completed_jobs(jobs, lambda j: j, 3, mode='shared')), list(range(10)))
        self.assertEqual(list(completed_jobs([], lambda j: j, 4)), [])


if __name__ == '__main__': unittest.main()
