"""Read-only ConnectX inventory and interface-bound IPv4 reachability probes."""
import concurrent.futures
import ipaddress
import json
import pathlib
import subprocess
import sys


def read(path):
    try:
        return pathlib.Path(path).read_text().strip()
    except OSError:
        return ""


def run(argv, timeout=4):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def inventory():
    result = run(["ip", "-j", "-4", "address", "show"])
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Cannot read IP addresses")
    addresses = {item["ifname"]: item for item in json.loads(result.stdout)}
    interfaces = []
    for nic in sorted(pathlib.Path("/sys/class/net").iterdir()):
        # Mellanox / NVIDIA PCI vendor. Do not infer fabric membership from LAN IPs.
        if read(nic / "device/vendor") != "0x15b3":
            continue
        raw_speed = read(nic / "speed")
        speed = int(raw_speed) if raw_speed.isdigit() and int(raw_speed) > 0 else None
        ipv4 = [{"address": a["local"], "prefix": a["prefixlen"]}
                for a in addresses.get(nic.name, {}).get("addr_info", [])
                if a.get("family") == "inet" and a.get("scope") == "global"]
        interfaces.append({"name": nic.name, "state": read(nic / "operstate"),
                           "carrier": read(nic / "carrier") == "1", "speedMbps": speed,
                           "addresses": ipv4[:4],
                           "rdmaDevices": [p.name for p in (nic / "device/infiniband").glob("*")]})
    return {"interfaces": interfaces[:8]}


def probe(target):
    result = {"key": target["key"], "ok": False, "reason": "unreachable"}
    try:
        source = str(ipaddress.IPv4Address(target["sourceIp"]))
        dest = str(ipaddress.IPv4Address(target["targetIp"]))
        iface = target["sourceInterface"]
        # Check the actual output route, then bind ping to the fabric interface.
        route = run(["ip", "-j", "route", "get", dest, "from", source, "oif", iface])
        routes = json.loads(route.stdout) if route.returncode == 0 else []
        if not routes or routes[0].get("dev") != iface or routes[0].get("gateway"):
            return {**result, "reason": "no-direct-route"}
        ping = run(["ping", "-n", "-I", iface, "-c", "1", "-W", "1", dest], timeout=3)
        return {**result, "ok": ping.returncode == 0,
                "reason": "reachable" if ping.returncode == 0 else "ping-failed"}
    except FileNotFoundError:
        return {**result, "ok": None, "reason": "missing-tool"}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return {**result, "ok": None, "reason": "probe-error"}


if __name__ == "__main__":
    if len(sys.argv) == 1:
        print(json.dumps(inventory()))
    else:
        import base64
        targets = json.loads(base64.b64decode(sys.argv[1]))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            print(json.dumps(list(pool.map(probe, targets))))
