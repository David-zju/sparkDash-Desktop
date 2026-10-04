import crypto from 'node:crypto';
import { resolveLlmHttpTarget } from './llmTunnel.js';

function targetKey(spark, port, kind) {
  return crypto.createHash('sha256').update(JSON.stringify([
    spark.id, spark.lanIp, spark.isLocal, spark.ssh, spark.llmApiKeys?.[String(port)], port, kind,
  ])).digest('hex');
}

/** Shared direct/SSH targets for monitoring, actions and long-running jobs. */
export class ServiceTargets {
  constructor({ resolve = resolveLlmHttpTarget, idleMs = 15000 } = {}) {
    this.resolve = resolve;
    this.idleMs = idleMs;
    this.entries = new Map();
    this.allEntries = new Set();
    this.stopped = false;
  }
  async acquire(spark, port, kind = 'llm') {
    if (this.stopped) throw new Error('Service connections have stopped');
    const key = targetKey(spark, port, kind);
    let entry = this.entries.get(key);
    if (!entry) {
      const abort = new AbortController();
      entry = { refs: 0, timer: null, target: null, abort };
      this.allEntries.add(entry);
      this.entries.set(key, entry);
      entry.ready = this.resolve(spark, port, {
        apiKey: spark.llmApiKeys?.[String(port)], signal: abort.signal,
        ...(kind === 'comfy' ? { probe: async (host, remotePort) => {
          try {
            const address = host.includes(':') ? `[${host}]` : host;
            const response = await fetch(`http://${address}:${remotePort}/system_stats`, { signal: AbortSignal.timeout(3000) });
            await response.body?.cancel();
            return response.status < 500 && response.status !== 404;
          } catch { return false; }
        } } : {}),
      }).then((target) => {
        entry.target = target;
        if (this.stopped || abort.signal.aborted) { target.close(); throw new Error('Service connection stopped'); }
        return target;
      }).catch((error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    }
    clearTimeout(entry.timer);
    entry.refs++;
    let released = false;
    const release = (invalidate = false) => {
      if (released) return;
      released = true;
      entry.refs--;
      if (invalidate && this.entries.get(key) === entry) this.entries.delete(key);
      if (entry.refs === 0) {
        entry.timer = setTimeout(() => {
          entry.abort.abort(); entry.target?.close();
          this.allEntries.delete(entry);
          if (this.entries.get(key) === entry) this.entries.delete(key);
        }, invalidate ? 0 : this.idleMs);
        entry.timer.unref?.();
      }
    };
    try {
      const target = await entry.ready;
      return { ...target, close: () => release(), invalidate: () => release(true) };
    } catch (error) { release(true); throw error; }
  }
  stop() {
    this.stopped = true;
    for (const entry of this.allEntries) {
      clearTimeout(entry.timer); entry.abort.abort(); entry.target?.close();
    }
    this.entries.clear();
    this.allEntries.clear();
  }
}
export const serviceTargets = new ServiceTargets();

/** A monitor owns a lease until its target changes, fails, or is disposed. */
export class ServiceConnection {
  constructor(pool = serviceTargets) {
    this.pool = pool; this.lease = null; this.key = null;
    this.pending = null; this.generation = 0; this.disposed = false;
  }
  async get(spark, port, kind = 'llm') {
    if (this.disposed) throw new Error('Monitor stopped');
    const key = targetKey(spark, port, kind);
    if (this.key !== key) {
      this.lease?.close(); this.lease = null; this.key = key;
      this.pending = null; this.generation++;
    }
    if (this.lease) return this.lease;
    if (!this.pending) {
      const generation = this.generation;
      const pending = this.pool.acquire(spark, port, kind).then((lease) => {
        if (this.disposed || this.generation !== generation) { lease.close(); throw new Error('Monitor changed'); }
        this.lease = lease;
        return lease;
      }).finally(() => { if (this.pending === pending) this.pending = null; });
      this.pending = pending;
    }
    return this.pending;
  }
  invalidate() {
    this.lease?.invalidate(); this.lease = null;
    this.pending = null; this.generation++;
  }
  dispose() {
    this.disposed = true; this.lease?.close(); this.lease = null;
    this.pending = null; this.generation++;
  }
}

export function serviceBaseUrl(target) {
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  return `${target.tls ? 'https' : 'http'}://${host}:${target.port}`;
}
