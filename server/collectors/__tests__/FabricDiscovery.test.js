import test from "node:test";
import assert from "node:assert/strict";
import { discoverFabric, FABRIC_INVENTORY_COMMAND, parseFabricInventory } from "../FabricDiscovery.js";

const sparks = ["a", "b", "c"].map((id) => ({ id, name: id, ssh: { host: id } }));
function nic(ip, extra = {}) {
  return { name: "enp1s0f0np0", carrier: true, state: "up", speedMbps: 200000,
    addresses: [{ address: ip, prefix: 24 }], rdmaDevices: ["rocep1s0f0"], ...extra };
}
const targets = (cmd) => JSON.parse(Buffer.from(cmd.match(/ '([A-Za-z0-9+/=]+)'$/)[1], "base64").toString());

test("only binds to discovered fabric interfaces; both directions and speed must verify 200G", async () => {
  const calls = [];
  const result = await discoverFabric(sparks, { now: () => 42, exec: async (spark, cmd) => {
    if (cmd === FABRIC_INVENTORY_COMMAND) return JSON.stringify({ interfaces: [nic(`192.168.200.${spark.id.charCodeAt(0)}`, spark.id === "c" ? { speedMbps: 100000 } : {})] });
    const jobs = targets(cmd); calls.push({ id: spark.id, jobs });
    return JSON.stringify(jobs.map((job) => ({ key: job.key, ok: true, reason: "reachable" })));
  } });
  assert.equal(result.checkedAt, 42);
  assert.deepEqual(result.links.map((l) => l.verified200G), [true, false, false]);
  assert.ok(result.links.every((l) => l.status === "connected"));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.jobs.every((j) => j.sourceInterface === "enp1s0f0np0" && j.targetIp.startsWith("192.168.200."))));
});

test("link-up alone, mismatched subnets, and unavailable SSH do not establish connectivity", async () => {
  let probes = 0;
  const result = await discoverFabric(sparks, { exec: async (spark, cmd) => {
    if (spark.id === "c") throw new Error("SSH unavailable");
    if (cmd !== FABRIC_INVENTORY_COMMAND) probes++;
    return JSON.stringify({ interfaces: [nic(spark.id === "a" ? "10.1.1.1" : "10.2.2.2")] });
  } });
  assert.equal(probes, 0);
  assert.ok(result.links.every((l) => l.status === "unknown" && !l.verified200G));
  assert.equal(result.nodes[2].error, "SSH unavailable");
});

test("one-way or opposite paths never count as bidirectional; failures stay unknown", async () => {
  const result = await discoverFabric(sparks.slice(0, 2), { exec: async (spark, cmd) => {
    if (cmd === FABRIC_INVENTORY_COMMAND) return JSON.stringify({ interfaces: [
      nic(spark.id === "a" ? "10.1.0.1" : "10.1.0.2"),
      nic(spark.id === "a" ? "10.2.0.1" : "10.2.0.2", { name: "enP2p1s0f0np0" }),
    ] });
    return JSON.stringify(targets(cmd).map((j, index) => ({ key: j.key, ok: spark.id === "a" ? index === 0 : index === 1 })));
  } });
  assert.equal(result.links[0].status, "partial");
  assert.equal(result.links[0].verified200G, false);
});

test("invalid inventory and probe failures cannot be reported as connected", async () => {
  assert.throws(() => parseFabricInventory(JSON.stringify({ interfaces: [nic("10.1.0.1", { name: "$(touch bad)" })] })), /Invalid network interface/);
  const result = await discoverFabric(sparks.slice(0, 2), { exec: async (spark, cmd) => {
    if (cmd === FABRIC_INVENTORY_COMMAND) return JSON.stringify({ interfaces: [nic(spark.id === "a" ? "10.1.0.1" : "10.1.0.2")] });
    throw new Error("probe timeout");
  } });
  assert.equal(result.links[0].status, "unknown");
  assert.equal(result.links[0].paths[0].forward, null);
  assert.ok(result.nodes.every((n) => n.error === "probe timeout"));
});
