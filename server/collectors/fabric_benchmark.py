"""Bounded, unprivileged network tests. No installation or network configuration."""
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return ""


def capture(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=4)


def endpoint(config):
    iface = config["interface"]
    if not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,64}", iface):
        raise ValueError("Invalid network interface")
    local = str(ipaddress.IPv4Address(config["ip"]))
    peer = str(ipaddress.IPv4Address(config["peerIp"]))
    if read(Path('/sys/class/net') / iface / 'device/vendor') != '0x15b3':
        raise ValueError("Selected interface is not a ConnectX interface")
    addresses = capture(['ip', '-j', '-4', 'address', 'show', 'dev', iface])
    if addresses.returncode or not any(a.get('local') == local for n in json.loads(addresses.stdout) for a in n.get('addr_info', [])):
        raise ValueError("Selected IP is no longer assigned to this interface")
    # Do not constrain route lookup: verify the actual source-bound route used by the tools.
    route = capture(['ip', '-j', 'route', 'get', peer, 'from', local])
    routes = json.loads(route.stdout) if route.returncode == 0 else []
    if not routes or routes[0].get('dev') != iface or routes[0].get('gateway'):
        raise ValueError("Selected IP pair no longer has a direct route")
    return iface, local, peer


def rdma_endpoint(iface, local, root=Path('/sys/class/infiniband')):
    for dev in sorted(root.glob('*')):
        for port in sorted((dev / 'ports').glob('*')):
            if read(port / 'link_layer') != 'Ethernet' or not read(port / 'state').startswith('4:'):
                continue
            for gid in sorted((port / 'gids').glob('*')):
                try:
                    matches = ipaddress.IPv6Address(read(gid)).ipv4_mapped == ipaddress.IPv4Address(local)
                except ValueError:
                    continue
                if (matches and read(port / 'gid_attrs/ndevs' / gid.name) == iface
                        and read(port / 'gid_attrs/types' / gid.name) == 'RoCE v2'):
                    return {'device': dev.name, 'port': int(port.name), 'gid': int(gid.name)}
    return None


def inspect(config):
    iface, local, _ = endpoint(config)
    tools = {}
    for name, version_arg in [('iperf3', '--version'), ('ib_write_bw', '--version')]:
        if not shutil.which(name):
            tools[name] = {'available': False, 'version': None, 'reason': 'missing-tool'}
            continue
        version = capture([name, version_arg])
        help_result = capture([name, '--help'])
        help_text = help_result.stdout + help_result.stderr
        supported = name == 'iperf3' or all(flag in help_text for flag in ['--bind_source_ip', '--report_gbits'])
        tools[name] = {'available': supported, 'version': (version.stdout + version.stderr).strip()[:400],
                       'reason': None if supported else 'unsupported-tool-version'}
    return {'tools': tools, 'rdma': rdma_endpoint(iface, local)}


def command(config):
    iface, local, peer = endpoint(config)
    port = config['port']
    if type(port) is not int or not 20000 <= port <= 60000:
        raise ValueError('Invalid benchmark port')
    server = config['server'] is True
    if config['kind'] == 'tcp':
        args = ['iperf3', '-4', '-B', local, '-p', str(port), '-J']
        return args + (['-s', '-1'] if server else ['-c', peer, '-t', '10', '-P', '4', '--connect-timeout', '5000'])
    if config['kind'] != 'rdma':
        raise ValueError('Invalid benchmark kind')
    rdma = rdma_endpoint(iface, local)
    if not rdma:
        raise ValueError('No active RoCE v2 GID matches the selected interface and IP')
    args = ['ib_write_bw', '-d', rdma['device'], '-i', str(rdma['port']), '-x', str(rdma['gid']),
            '--bind_source_ip', local, '-p', str(port), '--report_gbits', '-D', '10', '-s', '65536', '-F']
    return args if server else args + [peer]


def listening(pid, port):
    # Inspect the child socket without connecting: a readiness connection would consume
    # iperf's one-off server / disrupt perftest's control handshake.
    sockets = set()
    for fd in Path(f'/proc/{pid}/fd').glob('*'):
        try:
            link = os.readlink(fd)
            if link.startswith('socket:['):
                sockets.add(link[8:-1])
        except OSError:
            pass
    for table in ('tcp', 'tcp6'):
        for line in read(f'/proc/{pid}/net/{table}').splitlines()[1:]:
            fields = line.split()
            if len(fields) > 9 and fields[3] == '0A' and int(fields[1].split(':')[1], 16) == port and fields[9] in sockets:
                return True
    return False


def interrupt(_signum, _frame):
    raise RuntimeError('Network test stopped or timed out')


def run(config):
    child = None
    launching = False
    interrupted = False

    def stop(signum, frame):
        nonlocal interrupted
        interrupted = True
        # A signal between fork and assigning Popen must not orphan the child.
        if not launching:
            interrupt(signum, frame)

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, stop)
    try:
        signal.alarm(40)  # Remote watchdog survives a lost SSH connection.
        args = command(config)
        launching = True
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                 start_new_session=True, env={**os.environ, 'LC_ALL': 'C'})
        launching = False
        if interrupted:
            raise RuntimeError('Network test stopped or timed out')
        if config['server']:
            deadline = time.monotonic() + 8
            while child.poll() is None and time.monotonic() < deadline:
                if listening(child.pid, config['port']):
                    print(json.dumps({'ready': True}), flush=True)
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Test server did not become ready')
        stdout, stderr = child.communicate(timeout=28)
        return {'code': child.returncode, 'stdout': stdout[-64000:], 'stderr': stderr[-8000:]}
    finally:
        signal.alarm(0)
        # Ignore repeated disconnect/cancel signals during cleanup.
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate()


def cancel(marker):
    count = 0
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if proc.stat().st_uid != os.getuid() or int(proc.name) == os.getpid():
                continue
            argv = (proc / 'cmdline').read_bytes().split(b'\0')
            # Only our Python wrapper, identified by its exact per-run argument.
            if (len(argv) > 4 and argv[1] == b'-c' and argv[3] == marker.encode()
                    and json.loads(base64.b64decode(argv[4])).get('action') == 'run'):
                os.kill(int(proc.name), signal.SIGTERM)
                count += 1
        except (OSError, ValueError):
            pass
    return {'stopped': count}


def main():
    marker = sys.argv[1]
    if not re.fullmatch(r'sparkdash-fabric-[a-f0-9-]{36}', marker):
        raise ValueError('Invalid run marker')
    config = json.loads(base64.b64decode(sys.argv[2]))
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGALRM):
        signal.signal(sig, interrupt)
    if config['action'] == 'cancel':
        result = cancel(marker)
    elif config['action'] == 'inspect':
        signal.alarm(20)
        result = inspect(config)
    elif config['action'] == 'run':
        result = run(config)
    else:
        raise ValueError('Invalid action')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
