import fs from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { sshExec } from './ssh.js';
import { discoverFabric } from './FabricDiscovery.js';

const encoded = Buffer.from(fs.readFileSync(new URL('./fabric_benchmark.py', import.meta.url))).toString('base64');
export function benchmarkCommand(marker, config) {
  if (!/^sparkdash-fabric-[a-f0-9-]{36}$/.test(marker)) throw new Error('Invalid run marker');
  return `python3 -c 'import base64; exec(base64.b64decode("${encoded}"))' '${marker}' '${Buffer.from(JSON.stringify(config)).toString('base64')}'`;
}
function response(raw) {
  const value = JSON.parse(raw.trim().split('\n').at(-1));
  if (value.error) throw new Error(value.error);
  return value;
}
export function parseBandwidth(kind, output) {
  if (kind === 'tcp') {
    const parsed = JSON.parse(output);
    if (parsed.error) throw new Error(parsed.error);
    const value = parsed.end?.sum_received?.bits_per_second;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('No valid receiver bandwidth in iperf3 output');
    return value / 1e9;
  }
  // Only accept the fixed-size row under an explicitly Gbit/sec header.
  const lines = output.split('\n');
  const header = lines.findIndex((line) => /BW average\[Gb\/sec\]/.test(line));
  if (header < 0) throw new Error('No Gbit/sec bandwidth header in RDMA output');
  for (const line of lines.slice(header + 1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== '65536' || cols.length < 5) continue;
    const value = Number(cols[3]);
    if (Number(cols[1]) > 0 && Number.isFinite(value) && value > 0) return value;
  }
  throw new Error('No valid average bandwidth in RDMA output');
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** One bounded run at a time. Credentials and remote command payloads stay private. */
export class FabricBenchmark {
  constructor({ exec = sshExec, discover = discoverFabric } = {}) {
    this.exec = exec; this.discover = discover; this.job = null; this.active = null; this.closed = false;
  }
  snapshot() { return this.job ? structuredClone(this.job) : null; }
  start(sparks, request) {
    if (this.closed) throw fail('Network tests are stopping', 503);
    if (this.active) throw fail('A bandwidth test is already running', 409);
    if (!Array.isArray(request.kinds) || !request.kinds.length || request.kinds.length > 2 || new Set(request.kinds).size !== request.kinds.length || request.kinds.some((k) => !['tcp', 'rdma'].includes(k))) throw fail('Select TCP or RDMA');
    if (!request.path || ['aInterface', 'aIp', 'bInterface', 'bIp'].some((key) => typeof request.path[key] !== 'string')) throw fail('Select a detected network path');
    if (sparks.length !== 2 || sparks.some((s) => !s || s.isLocal || s.kind === 'host') || sparks[0].id === sparks[1].id) throw fail('Select two saved DGX Spark devices');
    const state = { sparks: structuredClone(sparks), cancelled: false, marker: null, done: null };
    this.job = { id: randomUUID(), status: 'running', phase: 'Checking selected path', startedAt: Date.now(), finishedAt: null,
      a: sparks[0].id, b: sparks[1].id, names: sparks.map((s) => s.name), path: null, checks: [], results: [], error: null };
    this.active = state;
    state.done = this.run(state, request).finally(() => { if (this.active === state) this.active = null; });
    return this.snapshot();
  }
  async cleanup(state) {
    if (!state.marker) return;
    await Promise.allSettled(state.sparks.map((spark) => this.exec(spark,
      benchmarkCommand(state.marker, { action: 'cancel' }), { timeoutMs: 6000, multiplex: false })));
  }
  async cancel() {
    const state = this.active;
    if (!state) return this.snapshot();
    state.cancelled = true;
    this.job.status = 'cancelling'; this.job.phase = 'Stopping network test';
    await this.cleanup(state);
    return this.snapshot();
  }
  async stop() { this.closed = true; await this.cancel(); }
  async run(state, request) {
    const job = this.job;
    const checkCancelled = () => { if (state.cancelled) throw new Error('Network test cancelled'); };
    try {
      // Re-discover server-side. A browser cannot send arbitrary targets or command arguments.
      const discovery = await this.discover(state.sparks);
      checkCancelled();
      const path = discovery.links.find((l) => l.a === job.a && l.b === job.b)?.paths.find((p) =>
        ['aInterface', 'aIp', 'bInterface', 'bIp'].every((key) => p[key] === request.path[key]));
      if (!path) throw new Error('Selected network path is no longer available');
      job.path = path;
      const endpoints = [
        { interface: path.aInterface, ip: path.aIp, peerIp: path.bIp },
        { interface: path.bInterface, ip: path.bIp, peerIp: path.aIp },
      ];
      job.phase = 'Checking test tools';
      const marker = `sparkdash-fabric-${randomUUID()}`;
      const checks = await Promise.all(state.sparks.map(async (spark, i) => {
        try { return { id: spark.id, ...response(await this.exec(spark, benchmarkCommand(marker, { action: 'inspect', ...endpoints[i] }), { timeoutMs: 25000 })) }; }
        catch (error) { return { id: spark.id, error: error.message, tools: {}, rdma: null }; }
      }));
      job.checks = checks;
      checkCancelled();
      for (const kind of request.kinds) {
        const tool = kind === 'tcp' ? 'iperf3' : 'ib_write_bw';
        const unavailable = checks.find((c) => c.error || !c.tools?.[tool]?.available || (kind === 'rdma' && !c.rdma));
        if (unavailable) {
          job.results.push({ kind, direction: 'both', status: 'unavailable', gbps: null,
            error: `${unavailable.id}: ${tool}: ${unavailable.error || unavailable.tools?.[tool]?.reason || 'No matching active RoCE v2 GID'}`, logs: [] });
          continue;
        }
        // perftest requires compatible versions; do not suppress its own version exchange.
        if (kind === 'rdma' && checks[0].tools[tool].version !== checks[1].tools[tool].version) {
          job.results.push({ kind, direction: 'both', status: 'unavailable', gbps: null, error: 'RDMA tool versions differ between devices', logs: [] });
          continue;
        }
        for (const direction of ['forward', 'reverse']) {
          checkCancelled();
          job.phase = `${kind === 'tcp' ? 'TCP' : 'RDMA'} · ${direction === 'forward' ? 'A → B' : 'B → A'}`;
          const result = { kind, direction, status: 'running', gbps: null, error: null, logs: [] };
          job.results.push(result);
          try { await this.measure(state, endpoints, kind, direction, result); }
          catch (error) { result.status = state.cancelled ? 'cancelled' : 'failed'; result.error = error.message; }
          checkCancelled();
        }
      }
      job.status = 'completed'; job.phase = 'Network tests finished';
    } catch (error) {
      job.status = state.cancelled ? 'cancelled' : 'failed'; job.error = error.message;
      job.phase = state.cancelled ? 'Network test cancelled' : 'Network test failed';
    } finally { job.finishedAt = Date.now(); }
  }
  async measure(state, endpoints, kind, direction, result) {
    const clientIndex = direction === 'forward' ? 0 : 1, serverIndex = 1 - clientIndex;
    const port = randomInt(20000, 60001);
    state.marker = `sparkdash-fabric-${randomUUID()}`;
    let buffer = '', readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const options = { timeoutMs: 45000, multiplex: false };
    const invoke = (index, server, extra = {}) => this.exec(state.sparks[index], benchmarkCommand(state.marker,
      { action: 'run', ...endpoints[index], kind, port, server }), { ...options, ...extra });
    // Convert rejections immediately so a failed listener cannot produce an unhandled rejection.
    const server = invoke(serverIndex, true, { onStdout: (chunk) => {
      buffer += chunk;
      if (buffer.split('\n').some((line) => { try { return JSON.parse(line).ready === true; } catch { return false; } })) readyResolve();
    } }).then((raw) => ({ raw }), (error) => ({ error }));
    let timer;
    try {
      await Promise.race([ready, server.then((value) => { throw value.error || new Error(response(value.raw).stderr || 'Test server exited before becoming ready'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test server readiness timed out')), 15000); })]);
      clearTimeout(timer);
      if (state.cancelled) throw new Error('Network test cancelled');
      const client = response(await invoke(clientIndex, false));
      result.logs.push({ side: 'client', ...client });
      if (client.code !== 0) throw new Error(client.stderr || 'Test client failed');
      const completedServer = await server;
      if (completedServer.error) throw completedServer.error;
      const output = response(completedServer.raw);
      result.logs.push({ side: 'server', ...output });
      if (output.code !== 0) throw new Error(output.stderr || 'Test server failed');
      result.gbps = parseBandwidth(kind, client.stdout);
      result.status = 'passed';
    } finally {
      clearTimeout(timer);
      await this.cleanup(state);
      await server;
      state.marker = null;
    }
  }
}
