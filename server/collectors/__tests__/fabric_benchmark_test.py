"""Local fixtures only: no remote hosts, RDMA devices or real network load."""
import base64
import json
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('benchmark', Path(__file__).parents[1] / 'fabric_benchmark.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class BenchmarkTest(unittest.TestCase):
    def test_gid_must_match_ip_interface_roce_type_and_active_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            port = root / 'roce0/ports/1'
            for name, value in {'link_layer': 'Ethernet', 'state': '4: ACTIVE', 'gids/3': '::ffff:10.1.1.1',
                                'gid_attrs/ndevs/3': 'cx0', 'gid_attrs/types/3': 'RoCE v2'}.items():
                p = port / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(value)
            self.assertEqual(b.rdma_endpoint('cx0', '10.1.1.1', root), {'device': 'roce0', 'port': 1, 'gid': 3})
            self.assertIsNone(b.rdma_endpoint('cx1', '10.1.1.1', root))
            self.assertIsNone(b.rdma_endpoint('cx0', '10.1.1.2', root))
            (port / 'gid_attrs/types/3').write_text('IB/RoCE v1')
            self.assertIsNone(b.rdma_endpoint('cx0', '10.1.1.1', root))

    def test_commands_bind_each_endpoint_without_shell_or_gpu_options(self):
        with patch.object(b, 'endpoint', return_value=('cx0', '10.1.1.1', '10.1.1.2')), patch.object(b, 'rdma_endpoint', return_value={'device': 'roce0', 'port': 1, 'gid': 3}):
            base = {'kind': 'tcp', 'port': 25000, 'server': False}
            args = b.command(base)
            self.assertEqual(args[args.index('-B')+1], '10.1.1.1')
            self.assertEqual(args[args.index('-c')+1], '10.1.1.2')
            self.assertIn('-1', b.command({**base, 'server': True}))
            args = b.command({**base, 'kind': 'rdma'})
            self.assertEqual(args[args.index('-x')+1], '3')
            self.assertEqual(args[args.index('--bind_source_ip')+1], '10.1.1.1')
            self.assertNotIn('--use_cuda', args)
            with self.assertRaises(ValueError): b.command({**base, 'port': '25000; echo bad'})

    def test_cancel_only_signals_matching_run_wrappers(self):
        marker = 'sparkdash-fabric-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for pid, tag, action in [(910001, marker, 'run'), (910002, marker, 'cancel'),
                                     (910003, marker, 'inspect'), (910004, 'different-run', 'run')]:
                folder = root / str(pid); folder.mkdir()
                payload = base64.b64encode(json.dumps({'action': action}).encode())
                (folder / 'cmdline').write_bytes(b'\0'.join([b'python3', b'-c', b'wrapper', tag.encode(), payload, b'']))
            with patch.object(b, 'Path', return_value=root), patch.object(b.os, 'kill') as kill:
                self.assertEqual(b.cancel(marker), {'stopped': 1})
                kill.assert_called_once_with(910001, signal.SIGTERM)

    def test_interrupt_reaps_only_its_child_process_group(self):
        # Run wrapper in a separate interpreter: signal handlers must not affect unittest.
        script = f'''
import importlib.util, signal, sys
s=importlib.util.spec_from_file_location('b', {str(Path(b.__file__))!r})
b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
b.command=lambda c: [sys.executable, '-c', 'import time; time.sleep(30)']
original=b.subprocess.Popen
def spawn(*a, **kw):
 p=original(*a, **kw); print(p.pid, flush=True); return p
b.subprocess.Popen=spawn
signal.signal(signal.SIGTERM,b.interrupt)
try: b.run({{'server':False}})
except RuntimeError: pass
'''
        process = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.PIPE, text=True)
        try:
            pid = int(process.stdout.readline())
            process.terminate()
            process.wait(timeout=5)
            with self.assertRaises(ProcessLookupError): os.kill(pid, 0)
        finally:
            if process.poll() is None: process.kill(); process.wait()
            process.stdout.close()


if __name__ == '__main__':
    unittest.main()
