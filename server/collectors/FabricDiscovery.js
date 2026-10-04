import fs from "node:fs";
import { isIPv4 } from "node:net";
import { sshExec } from "./ssh.js";

const script = fs.readFileSync(new URL("./fabric_probe.py", import.meta.url), "utf8");
const encoded = Buffer.from(script).toString("base64");
// Every variable argument is base64 JSON; remote output never becomes shell code.
export const FABRIC_INVENTORY_COMMAND = `python3 -c 'import base64; exec(base64.b64decode("${encoded}"))'`;
export function fabricProbeCommand(targets) {
  return `${FABRIC_INVENTORY_COMMAND} '${Buffer.from(JSON.stringify(targets)).toString("base64")}'`;
}

const ipNumber = (ip) => ip.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
function sameSubnet(a, b) {
  const contains = (x, y) => {
    const mask = x.prefix === 0 ? 0 : (0xffffffff << (32 - x.prefix)) >>> 0;
    return (ipNumber(x.address) & mask) === (ipNumber(y.address) & mask);
  };
  return a.address !== b.address && contains(a, b) && contains(b, a);
}

export function parseFabricInventory(raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data.interfaces)) throw new Error("Invalid network inventory");
  return data.interfaces.slice(0, 8).map((nic) => {
    if (typeof nic.name !== "string" || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(nic.name)) {
      throw new Error("Invalid network interface");
    }
    return {
      name: nic.name, state: String(nic.state || "unknown"), carrier: nic.carrier === true,
      speedMbps: Number.isFinite(nic.speedMbps) && nic.speedMbps > 0 ? nic.speedMbps : null,
      addresses: (Array.isArray(nic.addresses) ? nic.addresses : []).filter((a) =>
        typeof a.address === "string" && isIPv4(a.address) && Number.isInteger(a.prefix) && a.prefix >= 0 && a.prefix <= 32
      ).slice(0, 4),
      rdmaDevices: (Array.isArray(nic.rdmaDevices) ? nic.rdmaDevices : []).filter((s) => typeof s === "string").slice(0, 8),
    };
  });
}

/** Only tests saved nodes, via their existing SSH credentials. Never changes network configuration. */
export async function discoverFabric(sparks, { exec = sshExec, now = Date.now } = {}) {
  if (sparks.length > 12) throw new Error("Select at most 12 devices for a network check");
  const nodes = await Promise.all(sparks.map(async (spark) => {
    try {
      if (spark.isLocal) throw new Error("Fabric discovery requires a saved SSH device");
      return { id: spark.id, name: spark.name, interfaces: parseFabricInventory(await exec(spark, FABRIC_INVENTORY_COMMAND, { timeoutMs: 12000 })), error: null };
    } catch (error) {
      return { id: spark.id, name: spark.name, interfaces: [], error: error.message };
    }
  }));
  const probes = new Map(nodes.map((n) => [n.id, []]));
  const links = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const paths = [];
    for (const an of a.interfaces.filter((n) => n.carrier)) for (const bn of b.interfaces.filter((n) => n.carrier)) {
      // One address pair per interface pair is enough to establish IP reachability.
      const pair = an.addresses.flatMap((aa) => bn.addresses.map((ba) => [aa, ba])).find(([aa, ba]) => sameSubnet(aa, ba));
      if (!pair || paths.length >= 16) continue;
      const key = `${i}:${j}:${paths.length}`;
      const [aa, ba] = pair;
      paths.push({ key, aInterface: an.name, aIp: aa.address, bInterface: bn.name, bIp: ba.address,
        speedMbps: an.speedMbps && bn.speedMbps ? Math.min(an.speedMbps, bn.speedMbps) : null });
      probes.get(a.id).push({ key, sourceInterface: an.name, sourceIp: aa.address, targetIp: ba.address });
      probes.get(b.id).push({ key, sourceInterface: bn.name, sourceIp: ba.address, targetIp: aa.address });
    }
    links.push({ a: a.id, b: b.id, paths });
  }
  const results = new Map();
  await Promise.all(sparks.map(async (spark) => {
    const targets = probes.get(spark.id);
    if (!targets.length) return;
    try {
      const raw = JSON.parse(await exec(spark, fabricProbeCommand(targets), { timeoutMs: 90000 }));
      if (!Array.isArray(raw)) throw new Error("Invalid probe output");
      results.set(spark.id, new Map(raw.map((r) => [r.key, r])));
    } catch (error) {
      nodes.find((n) => n.id === spark.id).error = error.message;
    }
  }));
  return { checkedAt: now(), nodes, links: links.map((link) => {
    const paths = link.paths.map((p) => {
      const a = results.get(link.a)?.get(p.key), b = results.get(link.b)?.get(p.key);
      return { ...p, forward: a?.ok === true ? true : a?.ok === false ? false : null,
        reverse: b?.ok === true ? true : b?.ok === false ? false : null,
        forwardReason: a?.reason || "not-tested", reverseReason: b?.reason || "not-tested" };
    });
    const connected = paths.some((p) => p.forward === true && p.reverse === true);
    const verified200G = paths.some((p) => p.forward === true && p.reverse === true && p.speedMbps >= 200000);
    const partial = paths.some((p) => p.forward === true || p.reverse === true);
    return { ...link, paths, verified200G,
      status: connected ? "connected" : partial ? "partial" : paths.length && paths.every((p) => p.forward === false && p.reverse === false) ? "unreachable" : "unknown" };
  }) };
}
