import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { backendEnvironment } from '../runtime-env.mjs';

test('desktop routes run Decode, Prefill, Showcase and Comfy cancellation against local fixtures', { timeout: 30000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkdash-services-'));
  const token = 'c'.repeat(64);
  const calls = [];
  let holdStreams = false;
  let cancelStatus = 200;
  const fixture = http.createServer(async (req, res) => {
    calls.push({ method: req.method, path: req.url });
    const json = (value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url.startsWith('/v1/') && req.headers.authorization !== 'Bearer fixture-api-key') {
      res.statusCode = 401; return json({ error: 'fixture key required' });
    }
    if (req.url === '/v1/models') return json({ data: [{ id: 'fixture-model' }] });
    if (req.url === '/v1/chat/completions') {
      for await (const _chunk of req) { /* consume fixture prompt */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ model: 'fixture-model', choices: [{ delta: { content: 'One ' } }] })}\n\n`);
      if (holdStreams) return;
      await sleep(20);
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ model: 'fixture-model', choices: [{ delta: { content: 'two.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 256, completion_tokens: 2, total_tokens: 258 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (req.url === '/system_stats') return json({ system: { comfyui_version: 'fixture' }, devices: [] });
    if (req.url === '/queue') return json({ queue_running: [], queue_pending: [] });
    if (req.url.startsWith('/api/jobs/') && req.url.endsWith('/cancel')) {
      res.statusCode = cancelStatus;
      return json({ success: cancelStatus === 200 });
    }
    res.statusCode = 404; json({});
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  Object.assign(process.env, backendEnvironment({ dataDir, token, secretsKey: 'd'.repeat(64) }));
  const { createBackend } = await import('../../server/index.js');
  const { ComfyProbe } = await import('../../server/collectors/ComfyProbe.js');
  const backend = createBackend({ monitorFactory: (spark) => ({
    start() {}, stop() {}, updateConfig() {}, snapshot: () => ({ id: spark.id, online: true, metrics: { llm: [] } }),
  }) });
  const { origin } = await backend.start();
  t.after(async () => {
    await backend.stop(); fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(origin + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  const node = { id: 'fixture', name: 'Fixture', lanIp: '127.0.0.1', ssh: { host: 'fixture', user: 'test' }, llmPorts: [port], comfyPort: port, comfyMonitoring: true };
  await request('/api/sparks', 'POST', node);
  await request(`/api/sparks/fixture/llm-ports/${port}/api-key`, 'PUT', { apiKey: 'fixture-api-key' });
  assert.equal(JSON.stringify(await request('/api/sparks')).includes('fixture-api-key'), false);
  const untilFinished = async (url) => {
    for (let i = 0; i < 160; i++) {
      const job = await request(url);
      if (job.status !== 'running') return job;
      await sleep(50);
    }
    throw new Error(`Fixture job did not finish: ${url}`);
  };
  const decode = await request('/api/sparks/fixture/llm/bench', 'POST', { port, modelId: 'fixture-model', concurrencies: [1, 2], maxTokens: 64 });
  const decoded = await untilFinished(`/api/sparks/fixture/llm/bench/${decode.benchId}`);
  assert.equal(decoded.status, 'completed', JSON.stringify(decoded));
  assert.equal(decoded.results.length, 2);
  assert.ok(decoded.results.every((r) => !r.error));
  assert.equal((await request('/api/sparks/fixture/llm/bench')).history.length, 1);
  await sleep(3100); // production anti-double-submit cooldown
  const prefill = await request('/api/sparks/fixture/llm/prefill-bench', 'POST', { port, modelId: 'fixture-model', contextSizes: [256] });
  const prefilled = await untilFinished(`/api/sparks/fixture/llm/prefill-bench/${prefill.benchId}`);
  assert.equal(prefilled.status, 'completed', JSON.stringify(prefilled));
  assert.ok(prefilled.results.every((r) => !r.error && r.promptTokens > 0));
  const show = await request('/api/sparks/fixture/llm/showcase', 'POST', { port, modelId: 'fixture-model', prompts: ['Explain a small local fixture.', 'Give a second concise answer.'], maxTokens: 64, temperature: 0 });
  const shown = await untilFinished(`/api/sparks/fixture/llm/showcase/${show.sessionId}`);
  assert.equal(shown.status, 'completed', JSON.stringify(shown));
  assert.equal(shown.streams.length, 2);
  assert.ok(shown.streams.every((s) => s.tokenCount > 0));
  holdStreams = true;
  const cancelShow = await request('/api/sparks/fixture/llm/showcase', 'POST', { port, modelId: 'fixture-model', prompts: ['A fixture that will be cancelled.'], maxTokens: 64 });
  const cancelled = await request(`/api/sparks/fixture/llm/showcase/${cancelShow.sessionId}`, 'DELETE');
  assert.equal(cancelled.status, 'cancelled');
  const comfy = new ComfyProbe(node, port);
  try { assert.equal((await comfy.probe()).available, true); } finally { comfy.dispose(); }
  await request('/api/sparks/fixture/comfy/cancel', 'POST', { promptId: 'fixture-job', port });
  assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/api/jobs/fixture-job/cancel'));
  assert.equal(calls.some((call) => call.path === '/prompt'), false, 'no Comfy workflow submission');
  cancelStatus = 403;
  const denied = await fetch(`${origin}/api/sparks/fixture/comfy/cancel`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptId: 'denied-fixture-job' }),
  });
  assert.equal(denied.status, 502);
  assert.match((await denied.json()).error, /HTTP 403/);
  assert.equal(calls.some((call) => call.path === '/interrupt'), false);
});
