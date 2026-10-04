import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSshAliases } from '../ssh-config.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sparkdash-config-'));
  await fs.mkdir(path.join(home, '.ssh'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

test('missing SSH config permits manual entry', async (t) => {
  const home = await fixture(t);
  assert.deepEqual(await listSshAliases({ home, systemConfig: null }), { aliases: [], warnings: [] });
});

test('discovers concrete aliases through quoted, globbed and nested Includes without evaluating commands or keys', async (t) => {
  const home = await fixture(t);
  const ssh = path.join(home, '.ssh');
  const sync = path.join(home, 'Application Support', 'Sync');
  await fs.mkdir(sync, { recursive: true });
  await fs.mkdir(path.join(ssh, 'hosts'));
  const canary = path.join(home, 'must-not-exist');
  await fs.writeFile(path.join(ssh, 'private-key'), 'Host must-not-read-private-key\n');
  await fs.writeFile(path.join(ssh, 'config'), [
    `Include "${sync}/ssh_config"`,
    'Include hosts/*.conf',
    'Host manual-host dgx-1 *.example !excluded bad?alias',
    '  IdentityFile ~/.ssh/private-key',
    `Match exec "touch '${canary}'"`,
    '  User fixture',
    '# Host comment-only',
  ].join('\n'));
  await fs.writeFile(path.join(sync, 'ssh_config'), 'Host dgx-1 dgx-2\nInclude hosts/nested.conf\n');
  await fs.writeFile(path.join(ssh, 'hosts/a.conf'), 'hOsT = "dgx-3" dgx-4 # ignored-host\nInclude ~/.ssh/config\n');
  await fs.writeFile(path.join(ssh, 'hosts/nested.conf'), 'Host dgx-10\n');
  const systemConfig = path.join(home, 'system_config');
  await fs.writeFile(systemConfig, 'Host system-host\n');
  const result = await listSshAliases({ home, systemConfig });
  assert.deepEqual(result.aliases, ['dgx-1', 'dgx-2', 'dgx-3', 'dgx-4', 'dgx-10', 'manual-host', 'system-host']);
  assert.deepEqual(result.warnings, []);
  await assert.rejects(fs.access(canary), { code: 'ENOENT' });
});

test('expands environment Includes and reports unreadable import limits while preserving valid aliases', async (t) => {
  const home = await fixture(t);
  await fs.writeFile(path.join(home, '.ssh/config'), 'Host usable-host\nInclude "${SYNC_CONFIG}"\nInclude ~anotheruser/.ssh/config\nInclude huge\n');
  await fs.writeFile(path.join(home, 'sync'), 'Host imported-host\n');
  await fs.writeFile(path.join(home, '.ssh/huge'), '#'.repeat(256_001));
  const result = await listSshAliases({ home, systemConfig: null, env: { SYNC_CONFIG: path.join(home, 'sync') } });
  assert.deepEqual(result.aliases, ['imported-host', 'usable-host']);
  assert.equal(result.warnings.length, 2);
});
