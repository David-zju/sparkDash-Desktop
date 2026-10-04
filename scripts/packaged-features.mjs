import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Only called for an isolated, non-live test profile. All inference goes to
// this loopback fixture; SSH is deliberately pointed at a closed local port.
export async function testPackagedFeatures({ page, application, api, check, executablePath, dataDir }) {
  let holdStreams = false;
  let inferenceCalls = 0;
  const sockets = new Set();
  const fixture = http.createServer(async (req, res) => {
    const json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (req.url === '/v1/models') return json({ data: [{ id: 'packaged-fixture-model' }] });
    if (req.url === '/v1/chat/completions') {
      inferenceCalls++;
      for await (const _ of req) { /* consume the actual app request */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ model: 'packaged-fixture-model', choices: [{ delta: { content: 'One ' } }] })}\n\n`);
      if (holdStreams) return;
      await sleep(30);
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'two.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 256, completion_tokens: 2, total_tokens: 258 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 404; json({});
  });
  fixture.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  const request = async (url, method = 'GET', body) => {
    const result = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(result.status >= 200 && result.status < 300, `${url}: ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const nodeId = 'packaged-fixture';
  const base = `/api/sparks/${nodeId}/llm`;
  const waitJob = async (url) => {
    for (let n = 0; n < 200; n++) {
      const job = await request(url);
      if (job.status !== 'running') return job;
      await sleep(100);
    }
    throw new Error(`Job did not finish: ${url}`);
  };
  const selectNode = () => page.getByRole('navigation', { name: 'Sparks' }).getByRole('button', { name: 'Packaged Fixture Edited', exact: true }).click();
  try {
    // Retry-safe cleanup only within this script's dedicated data profile.
    for (const node of (await request('/api/sparks')).sparks) await request(`/api/sparks/${node.id}`, 'DELETE');
    await page.reload();
    await page.getByRole('button', { name: /Add Spark/ }).first().click();
    const add = page.getByRole('dialog', { name: 'Add Spark/GPU Host' });
    await add.getByPlaceholder('My Spark').fill('Packaged Fixture');
    await add.getByPlaceholder('192.168.1.100').fill('127.0.0.1');
    await add.getByLabel('SSH Port', { exact: true }).fill('1');
    await add.getByPlaceholder('8888', { exact: true }).fill(String(port));
    await add.getByRole('button', { name: 'Save', exact: true }).click();
    await add.waitFor({ state: 'hidden' });
    assert.equal((await request('/api/sparks')).sparks[0].id, nodeId);
    await page.getByRole('navigation', { name: 'Sparks' }).getByRole('button', { name: 'Packaged Fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Spark' });
    await edit.locator('input[type="text"]').first().fill('Packaged Fixture Edited');
    await edit.locator('select').filter({ has: page.locator('option[value="worker"]') }).selectOption('worker');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    assert.equal((await request('/api/sparks')).sparks[0].role, 'worker');
    assert.equal(await page.getByRole('button', { name: 'Run decode benchmark', exact: true }).count(), 0);
    await request(`/api/sparks/${nodeId}`, 'PATCH', { role: 'standalone', llmMonitoring: true, comfyMonitoring: false });
    await request('/api/sparks', 'POST', { id: 'fixture-second', name: 'Second Fixture', lanIp: '127.0.0.1', ssh: { host: '127.0.0.1', port: 1 }, llmMonitoring: false });
    await request('/api/sparks/order', 'PUT', { order: ['fixture-second', nodeId] });
    await page.reload();
    assert.deepEqual((await request('/api/sparks')).sparks.map((n) => n.id), ['fixture-second', nodeId]);
    await selectNode();
    await page.getByRole('button', { name: 'Run decode benchmark', exact: true }).waitFor();
    check('packaged UI adds and edits an offline SSH node; roles hide LLM controls; order persists');

    await request('/api/settings', 'PUT', { benchShareImage: true });
    const decode = await request(`${base}/bench`, 'POST', { port, modelId: 'packaged-fixture-model', concurrencies: [1, 2], maxTokens: 64 });
    const decoded = await waitJob(`${base}/bench/${decode.benchId}`);
    assert.equal(decoded.status, 'completed');
    assert.equal(decoded.results.length, 2);
    await page.reload();
    await selectNode();
    await page.getByRole('button', { name: 'Run decode benchmark', exact: true }).click();
    const decodeDialog = page.getByRole('dialog', { name: 'Decode benchmark', exact: true });
    await decodeDialog.getByRole('button', { name: 'Copy results', exact: true }).click();
    await decodeDialog.getByRole('button', { name: 'Copied text!', exact: true }).waitFor();
    const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(copied, /packaged-fixture-model/);
    await decodeDialog.getByRole('button', { name: 'Copy format', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy as image', exact: true }).click();
    await decodeDialog.getByRole('button', { name: 'Image copied!', exact: true }).waitFor();
    const card = await application.evaluate(async ({ clipboard, nativeImage }) => {
      const items = await clipboard.read();
      const item = items.find((entry) => entry.types.includes('image/png'));
      if (!item) throw new Error('Copied PNG missing from clipboard');
      const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
      return { size: nativeImage.createFromBuffer(png).getSize(), png: png.toString('base64') };
    });
    assert.ok(card.size.width >= 600 && card.size.height >= 300);
    fs.writeFileSync('.desktop-test/packaged-share-card.png', Buffer.from(card.png, 'base64'));
    await decodeDialog.getByRole('button', { name: 'Done', exact: true }).click();
    check('packaged Decode runs locally, restores history and copies real text/PNG results');

    await sleep(3100);
    const prefill = await request(`${base}/prefill-bench`, 'POST', { port, modelId: 'packaged-fixture-model', contextSizes: [256] });
    assert.equal((await waitJob(`${base}/prefill-bench/${prefill.benchId}`)).status, 'completed');
    await page.getByRole('button', { name: 'Run prefill benchmark', exact: true }).click();
    const prefillDialog = page.getByRole('dialog', { name: /Prefill benchmark/ });
    await prefillDialog.getByRole('button', { name: 'Copy results', exact: true }).waitFor();
    await prefillDialog.getByRole('button', { name: 'Done', exact: true }).click();
    const showcase = await request(`${base}/showcase`, 'POST', { port, modelId: 'packaged-fixture-model', prompts: Array.from({ length: 32 }, (_, i) => `Local fixture ${i + 1}`), maxTokens: 64 });
    const shown = await waitJob(`${base}/showcase/${showcase.sessionId}`);
    assert.equal(shown.status, 'completed');
    assert.equal(shown.streams.length, 32);
    assert.ok(shown.streams.every((stream) => stream.tokenCount > 0));
    check('packaged Prefill completes and Showcase handles all 32 local streams');

    const mainPid = application.process().pid;
    const duplicate = spawn(executablePath, [`--data-dir=${dataDir}`], { env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: 'ignore' });
    const duplicateExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { duplicate.kill(); reject(new Error('Duplicate instance did not exit')); }, 15000);
      duplicate.once('error', (error) => { clearTimeout(timer); reject(error); });
      duplicate.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(duplicateExit, 0);
    assert.equal(application.process().pid, mainPid);
    await request('/api/runtime');
    check('duplicate launch exits and leaves the original app/backend running');

    holdStreams = true;
    await sleep(3100);
    const interrupted = await request(`${base}/bench`, 'POST', { port, modelId: 'packaged-fixture-model', concurrencies: [1], maxTokens: 64 });
    await sleep(300);
    const beforeCrashCalls = inferenceCalls;
    const oldOrigin = new URL(page.url()).origin;
    await application.evaluate(({ app }) => {
      const metrics = app.getAppMetrics();
      const child = metrics.find((metric) => metric.name === 'sparkDash monitoring' || metric.serviceName === 'sparkDash monitoring');
      if (!child) throw new Error(`No monitoring utility process: ${JSON.stringify(metrics.map(({ type, name, serviceName }) => ({ type, name, serviceName })))}`);
      process.kill(child.pid, 'SIGKILL');
    });
    await page.getByText('后台已停止', { exact: true }).waitFor();
    await assert.rejects(fetch(`${oldOrigin}/api/sparks`));
    await application.evaluate(({ Menu }) => {
      Menu.getApplicationMenu().getMenuItemById('monitoring-reconnect').click();
    });
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//);
    const recovered = await request(`${base}/bench/${interrupted.benchId}`);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /Interrupted/);
    await sleep(500);
    assert.equal(inferenceCalls, beforeCrashCalls, 'interrupted inference must not restart automatically');
    assert.deepEqual((await request('/api/sparks')).sparks.map((n) => n.id), ['fixture-second', nodeId]);
    await selectNode();
    await page.getByRole('button', { name: 'Run decode benchmark', exact: true }).click();
    await page.getByText(/Interrupted — server restarted while the benchmark was running/).waitFor();
    await page.screenshot({ path: '.desktop-test/packaged-recovered-task.png', fullPage: true });
    await page.getByRole('dialog', { name: 'Decode benchmark', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
    check('backend crash stops requests; menu recovery preserves configuration and marks interrupted work failed');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('dialog', { name: 'Edit Spark' }).getByRole('button', { name: /Remove|Delete/ }).click();
    await page.getByRole('dialog', { name: 'Edit Spark' }).waitFor({ state: 'hidden' });
    assert.equal((await request('/api/sparks')).sparks.some((n) => n.id === nodeId), false);
    await request('/api/sparks/fixture-second', 'DELETE');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    check('packaged UI deletes the configured node and returns to the overview');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => fixture.close(resolve));
  }
}
