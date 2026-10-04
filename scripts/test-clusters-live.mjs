import fs from 'node:fs';
import assert from 'node:assert/strict';
process.env.SPARKDASH_DESKTOP = '1';
const { discoverFabric } = await import('../server/collectors/FabricDiscovery.js');
const { closeSshConnections } = await import('../server/collectors/ssh.js');
const sparks = [1, 2, 3, 4].map((n) => ({ id: `dgx-${n}`, name: `DGX ${n}`, ssh: { host: `dgx-${n}`, user: '', auth: 'key' } }));
try {
  const result = await discoverFabric(sparks);
  fs.mkdirSync('.desktop-test', { recursive: true });
  fs.writeFileSync('.desktop-test/cluster-live-report.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ checkedAt: result.checkedAt, nodes: result.nodes.map((n) => ({ id: n.id, error: n.error, interfaces: n.interfaces })), links: result.links.map(({ paths, ...l }) => ({ ...l, testedPaths: paths.length })) }, null, 2));
  assert.ok(result.nodes.every((n) => !n.error), 'Some nodes could not be checked; inspect the report');
} finally { await closeSshConnections(); }
