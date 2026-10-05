import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPowerAuth, authenticatedPowerAction, sudoInvocation, verifySudoPassword } from '../../sudoAuth.js';
const spark = { id: 'fixture', isLocal: false };
test('missing systemctl is separate from authentication and never executes sudo', async () => {
  const calls = [];
  const result = await checkPowerAuth(spark, 'secret', async (...args) => { calls.push(args); return 'missing'; });
  assert.equal(result.status, 'command_missing'); assert.equal(calls.length, 1);
});
test('password goes only to stdin and command/action injection is rejected', () => {
  const password = "a'$(echo secret);$b`id`";
  const invocation = sudoInvocation(password, 'reboot');
  assert.equal(invocation.command, "sudo -S -k -p '' -- systemctl reboot");
  assert.equal(invocation.options.input, password + '\n'); assert.equal(invocation.options.sensitive, true);
  assert.throws(() => sudoInvocation('secret\nextra'));
  assert.throws(() => sudoInvocation('secret', 'reboot; id'), /Unsupported/);
});
test('preflight authenticates without sending any power operation', async () => {
  const calls = [];
  const exec = async (_, cmd) => { calls.push(cmd); if (!cmd.startsWith('sudo')) return 'present'; throw new Error('secret in remote output'); };
  const result = await checkPowerAuth(spark, 'secret', exec);
  assert.equal(result.status, 'password_required'); assert.equal(calls.length, 2);
  assert.equal(calls[1], "sudo -S -k -p '' -v");
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('shutdown and reboot use direct commands, no helper and no automatic retry', async () => {
  const calls = [];
  for (const action of ['shutdown', 'reboot']) {
    const message = await authenticatedPowerAction(spark, action, 'secret', async (_, cmd, opts) => calls.push({ cmd, opts }));
    assert.match(message, /requested/);
  }
  assert.equal(calls.length, 2); assert.ok(calls[0].cmd.endsWith('systemctl poweroff')); assert.ok(calls[1].cmd.endsWith('systemctl reboot'));
  assert.equal(calls[0].opts.input, 'secret\n');
  let attempts = 0;
  await assert.rejects(authenticatedPowerAction(spark, 'shutdown', 'secret', async () => { attempts++; throw new Error('closed'); }), /unconfirmed/);
  assert.equal(attempts, 1);
});
test('credential save checks sudo only', async () => {
  const calls = [];
  await verifySudoPassword(spark, 'secret', async (_, cmd, options) => calls.push({ cmd, options }));
  assert.equal(calls[0].cmd, "sudo -S -k -p '' -v");
});
test('a remote refusal is reported as rejected, transport loss or timeout as unconfirmed', async () => {
  const failWith = fields => async () => { throw Object.assign(new Error('ssh failed'), fields); };
  await assert.rejects(authenticatedPowerAction(spark, 'shutdown', 'secret', failWith({ exitCode: 1, timedOut: false })), /rejected/);
  await assert.rejects(authenticatedPowerAction(spark, 'shutdown', 'secret', failWith({ exitCode: 255, timedOut: false })), /unconfirmed/);
  await assert.rejects(authenticatedPowerAction(spark, 'reboot', 'secret', failWith({ exitCode: null, timedOut: true })), /unconfirmed/);
});
