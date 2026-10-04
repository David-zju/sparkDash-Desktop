import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-cluster-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".key");
const { SparkRegistry } = await import("../SparkRegistry.js");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fresh() {
  fs.writeFileSync(process.env.SPARKS_JSON_PATH, '{"sparks":[]}');
  const registry = new SparkRegistry();
  for (const id of ["a", "b", "c", "d"]) registry.addSpark({ id, ssh: { host: id }, llmPorts: [8000, 8001] });
  return registry;
}

test("cluster creation, change of Head, removal and dissolution persist consistent roles", () => {
  let r = fresh();
  r.configureCluster({ name: "Lab", headId: "a", memberIds: ["a", "b", "c"] });
  r = new SparkRegistry();
  assert.equal(r.getSpark("a").clusterName, "Lab");
  assert.equal(r.getSpark("b").workerHeadId, "a");
  assert.equal(r.getSpark("b").llmMonitoring, false);
  assert.deepEqual(r.getSpark("b").llmPorts, [8000, 8001]);
  r.configureCluster({ name: "Lab 2", headId: "b", memberIds: ["b", "c"], previousHeadId: "a" });
  assert.equal(r.getSpark("a").role, "standalone");
  assert.equal(r.getSpark("a").clusterName, null);
  assert.equal(r.getSpark("c").workerHeadId, "b");
  assert.equal(r.getSpark("b").llmMonitoring, true);
  r.configureCluster({ previousHeadId: "b" }, true);
  r = new SparkRegistry();
  assert.ok(r.sparks.every((s) => s.role === "standalone" && !s.workerHeadId && !s.clusterName));
});

test("invalid members and cross-cluster reassignment are rejected without writes", () => {
  const r = fresh();
  r.configureCluster({ name: "First", headId: "a", memberIds: ["a", "b"] });
  const before = fs.readFileSync(process.env.SPARKS_JSON_PATH, "utf8");
  for (const config of [
    { name: "Other", headId: "c", memberIds: ["b", "c"] },
    { name: "", headId: "c", memberIds: ["c", "d"] },
    { name: "Other", headId: "a", memberIds: ["c", "d"] },
    { name: "Other", headId: "c", memberIds: ["c", "c"] },
    { name: "Other", headId: "c", memberIds: ["c", "missing"] },
  ]) assert.throws(() => r.configureCluster(config));
  assert.equal(fs.readFileSync(process.env.SPARKS_JSON_PATH, "utf8"), before);
});

test("failed atomic persistence leaves every member and listener unchanged", () => {
  const r = fresh();
  const before = r.publicSparks;
  const events = [];
  r.onChange((action) => events.push(action));
  r._save = () => { throw new Error("disk full"); };
  assert.throws(() => r.configureCluster({ name: "Lab", headId: "a", memberIds: ["a", "b", "c"] }), /disk full/);
  assert.deepEqual(r.publicSparks, before);
  assert.deepEqual(events, []);
});
