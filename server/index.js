import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { SparkRegistry } from "./sparks/SparkRegistry.js";
import { SparkMonitor } from "./sparks/SparkMonitor.js";
import { sshExec, closeSshConnections } from "./collectors/ssh.js";
import { comfyCancelJob } from "./collectors/comfyActions.js";
import {
  validateSparkTarget,
  createRateLimiter,
  assertAllowedTarget,
  validateDecodeBudget,
  validatePrefillBudget,
} from "./validate.js";
import { authorizeUpgrade, configuredToken, createAuthMiddleware, requireRemoteAuth } from "./auth.js";
import { inspectHealth } from "./health.js";
import { getSettings, updateSettings, loadSettings } from "./settings.js";
import { broadcastForLanIp, effectiveMac, normalizeMac, sendWol } from "./wol.js";
import { spawnLocalPower } from "./shutdown.js";
import { checkPowerAuth, authenticatedPowerAction, verifySudoPassword } from "./sudoAuth.js";
import {
  decodeBenchManager,
  DECODE_BENCH_DEFAULTS,
  normalizeConcurrencies,
} from "./collectors/DecodeBench.js";
import {
  prefillBenchManager,
  PREFILL_BENCH_DEFAULTS,
  normalizeContextSizes,
} from "./collectors/PrefillBench.js";
import { showcaseManager } from "./collectors/ShowcaseManager.js";
import { llmProbeHost } from "./collectors/llmHost.js";
import { onceClose, resolveLlmHttpTarget } from "./collectors/llmTunnel.js";
import { formatLlmBaseUrl, parseLlmTargetInput } from "../src/shared/llmTarget.js";
import { llmDaily } from "./collectors/LlmDaily.js";
import {
  createLlmTokenRuntime,
  registerLlmTokenTotalsRoute,
  llmTokenLedger,
} from "./llmtokens/LlmTokenRuntime.js";
import { closeLlmStreamAgent } from "./collectors/LlmStreaming.js";
import { compareSemver, getLatestRelease } from "./collectors/HermesReleases.js";
import { FLEET_ENERGY_JSON_PATH } from "./config.js";
import { FleetEnergyTracker } from "./energy/FleetEnergyTracker.js";
import {
  createFleetEnergyRuntime,
  registerFleetEnergyRoute,
} from "./energy/FleetEnergyRuntime.js";
import { testSparkConnectivity } from "./connectivity.js";
import { discoverFabric } from "./collectors/FabricDiscovery.js";
import { FabricBenchmark } from "./collectors/FabricBenchmark.js";
import { inspectStartupPreflight, logStartupPreflight } from "./startupPreflight.js";
import { authorizeDesktopRequest, desktopMiddleware } from "./desktop-policy.js";
import { serviceTargets, serviceBaseUrl } from "./collectors/ServiceTargets.js";

if (process.env.SPARKDASH_DESKTOP !== "1") dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// Default to loopback. Direct non-loopback binds fail closed because this release
// does not authenticate LAN clients. Use an SSH tunnel, authenticated reverse
// proxy, or Tailscale Serve (docs/REMOTE-ACCESS.md).
export function createBackend({ monitorFactory = (spark, options) => new SparkMonitor(spark, options), prepareCredentials = async () => {}, fabricDiscovery = discoverFabric, fabricBenchmark = new FabricBenchmark(), powerExec = sshExec } = {}) {
const desktop = process.env.SPARKDASH_DESKTOP === "1";
const BIND_HOST = desktop ? "127.0.0.1" : process.env.BIND_HOST || "127.0.0.1";
const PORT = desktop ? 0 : parseInt(process.env.PORT || "5555", 10);
let origin = null;
const credentials = () => ({ token: configuredToken(), origin });
const LLM_PORT = parseInt(process.env.LLM_PORT || "8888", 10);
const COMFY_PORT = parseInt(process.env.COMFY_PORT || "8188", 10);

/** Per-spark LLM HTTP port (1–65535), else env default. */
function resolveLlmPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    // Prefer llmPorts array, fall back to legacy llmPort
    const ports = sparkOrPort.llmPorts;
    if (Array.isArray(ports) && ports.length > 0) {
      const n = ports[0];
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
    const raw = sparkOrPort.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return LLM_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return LLM_PORT;
}

/** Per-spark ComfyUI HTTP port (1–65535), else env default 8188. */
function resolveComfyPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    const raw = sparkOrPort.comfyPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return COMFY_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return COMFY_PORT;
}

/** Optional Bearer token for a Spark LLM port (from encrypted secrets). */
function resolveLlmApiKey(spark, port) {
  const keys = spark?.llmApiKeys;
  if (!keys || typeof keys !== "object") return null;
  const raw = keys[String(port)] ?? keys[port];
  const key = raw != null ? String(raw).trim() : "";
  return key || null;
}

/**
 * Local Spark LLM port, or an on-demand remote host (HTTPS Tailscale, etc.).
 * Custom `host` skips the configured-port allowlist and SSH tunnel.
 *
 * @param {object} spark
 * @param {number[]} configuredPorts
 * @param {object} body
 */
async function benchHttpTarget(spark, configuredPorts, body) {
  const hostRaw = body?.host != null ? String(body.host).trim() : "";
  if (hostRaw) {
    const parsed = parseLlmTargetInput(hostRaw, body?.port, body?.tls);
    const extra = extraBenchmarkHosts();
    // The authenticated desktop window explicitly supplies this temporary target.
    // Preserve address validation without requiring an invisible environment knob.
    if (desktop) extra.add(parsed.host);
    if (!extra.has(parsed.host)) {
      const err = new Error(
        `Remote benchmark host ${parsed.host} is not allowlisted. Add it to SPARKDASH_BENCH_HOSTS or use a saved Spark LLM target.`
      );
      err.status = 403;
      throw err;
    }
    await assertAllowedTarget(parsed.host, extra);
    return {
      port: parsed.port,
      host: parsed.host,
      tls: parsed.tls,
      custom: true,
      apiKey: null,
      resolveTarget: async ({ onStatus }) => {
        onStatus?.(`Reaching ${formatLlmBaseUrl(parsed)}…`);
        return {
          host: parsed.host,
          port: parsed.port,
          tls: parsed.tls,
          via: "direct",
          close: onceClose(() => {}),
        };
      },
    };
  }

  let port = body?.port != null ? Number(body.port) : configuredPorts[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error("Invalid port");
    err.status = 400;
    throw err;
  }
  if (!configuredPorts.includes(port)) {
    const err = new Error("port is not configured for this Spark");
    err.status = 400;
    throw err;
  }
  return {
    port,
    host: null,
    tls: false,
    custom: false,
    apiKey: resolveLlmApiKey(spark, port),
    resolveTarget: async ({ onStatus, signal }) => {
      if (desktop) {
        const lease = await serviceTargets.acquire(spark, port);
        if (signal?.aborted) { lease.close(); throw new DOMException('Aborted', 'AbortError'); }
        return lease;
      }
      return resolveLlmHttpTarget(spark, port, {
        apiKey: resolveLlmApiKey(spark, port),
        onStatus,
        signal,
      });
    },
  };
}

function extraBenchmarkHosts() {
  return new Set(
    String(process.env.SPARKDASH_BENCH_HOSTS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function fleetTargetHosts() {
  const hosts = new Set();
  for (const spark of registry.sparks) {
    if (spark.lanIp) hosts.add(spark.lanIp);
    if (spark.ssh?.host) hosts.add(spark.ssh.host);
  }
  return hosts;
}

async function assertFleetTarget(body) {
  const validationError = validateSparkTarget(body);
  if (validationError) {
    const err = new Error(validationError);
    err.status = 400;
    throw err;
  }
  const sshHost = body?.ssh?.host || "";
  const lanIp = body?.lanIp || "";
  const target = sshHost || lanIp;
  const allowed = fleetTargetHosts();
  if (target) allowed.add(target);
  if (lanIp) allowed.add(lanIp);
  if (target) await assertAllowedTarget(target, allowed);
  if (lanIp && lanIp !== target) await assertAllowedTarget(lanIp, allowed);
}

function principalKey(req) {
  return req.principal?.id || clientKey(req);
}

function rejectLimited(res, message) {
  return res.status(429).json({ error: message });
}

const allowTest = createRateLimiter(20, 60_000);
const allowDestructive = createRateLimiter(10, 60_000);
/** Decode + prefill starts per principal (retries that 400/409 do not count). */
const allowBench = createRateLimiter(20, 60_000);
const allowGlobalDestructive = createRateLimiter(30, 60_000);
/** Anti double-submit only; per-Spark mutex + MAX_ACTIVE_BENCH_JOBS cap load. */
const benchCooldown = createRateLimiter(1, 3_000);
const MAX_ACTIVE_BENCH_JOBS = 2;

/** Consume bench-start quota only when every limiter would allow it. */
function consumeBenchStartQuota(req, res) {
  const key = principalKey(req);
  const ip = clientKey(req);
  if (!allowBench(key, true)) {
    rejectLimited(res, "Too many benchmark requests; try again shortly");
    return false;
  }
  if (!benchCooldown(key, true)) {
    rejectLimited(res, "Benchmark cooldown is active; wait before starting another job");
    return false;
  }
  if (!allowGlobalDestructive(ip, true)) {
    rejectLimited(res, "Too many requests; try again shortly");
    return false;
  }
  allowBench(key);
  benchCooldown(key);
  allowGlobalDestructive(ip);
  return true;
}

// ─── Spark registry ──────────────────────────────────────
const registry = new SparkRegistry();

const fleetEnergyTracker = new FleetEnergyTracker({
  nodeIds: registry.sparkIds,
  filePath: FLEET_ENERGY_JSON_PATH,
});

// ─── Monitor map ─────────────────────────────────────────
const monitors = new Map();

// ─── Start monitor for a Spark ───────────────────────────
function startMonitor(spark) {
  if (monitors.has(spark.id)) return;
  const monitor = monitorFactory(spark, {
    onWolMac: (id, mac) => {
      const updated = registry.noteDetectedMac(id, mac);
      if (updated) {
        const mon = monitors.get(id);
        if (mon) mon.updateConfig(registry.getSpark(id));
      }
    },
    // Hermes check / update results must not wait for the next broadcast tick.
    onHermesChange: () => forceBroadcast(),
    // Worker derived label: resolve a head id to its live LLM model id.
    // Returns null when the head is unknown/offline/model-less so workers
    // never display a stale model. Display-only; never writes to config.
    resolveHeadModelId: (headId) => monitors.get(headId)?.headLlmModelId() ?? null,
  });
  monitors.set(spark.id, monitor);
  monitor.start();
}

// ─── Stop and remove monitor for a Spark ─────────────────
function stopMonitor(id) {
  const monitor = monitors.get(id);
  if (monitor) {
    monitor.stop();
    monitors.delete(id);
  }
}

// ─── Start all monitors from registry ───────────────────
function startAllMonitors() {
  for (const spark of registry.sparks) {
    startMonitor(spark);
  }
}

/** Snapshots in registry tab order (not Map insertion order). */
function orderedSnapshots() {
  return registry.sparkIds
    .map((id) => monitors.get(id))
    .filter(Boolean)
    .map((m) => m.snapshot());
}

const fleetEnergyRuntime = createFleetEnergyRuntime({
  tracker: fleetEnergyTracker,
  orderedSnapshots,
  monitors,
});

// Cumulative prompt/generated token totals per model (per-UTC-day buckets for range queries).
const llmTokenRuntime = createLlmTokenRuntime({ ledger: llmTokenLedger, orderedSnapshots });

// ─── Express app ─────────────────────────────────────────
const app = express();
const server = createServer(app);

app.use(express.json());
app.use(desktop ? desktopMiddleware(credentials) : createAuthMiddleware());
app.use(async (req, res, next) => {
  if (desktop) {
    const writesPassword = Boolean(req.body?.ssh?.password || req.body?.password) && (
      (req.method === 'POST' && (req.path === '/api/sparks' || /^\/api\/sparks\/[^/]+\/test$/.test(req.path))) ||
      (req.method === 'PATCH' && /^\/api\/sparks\/[^/]+$/.test(req.path)) ||
      (req.method === 'PUT' && /^\/api\/sparks\/[^/]+\/password$/.test(req.path))
    );
    const writesApiKey = req.method === 'PUT' && /^\/api\/sparks\/[^/]+\/llm-ports\/[^/]+\/api-key$/.test(req.path) && Boolean(req.body?.apiKey);
    const writesSudo = req.method === "PUT" && /^\/api\/sparks\/[^/]+\/sudo$/.test(req.path) && Boolean(req.body?.password);
    if (writesPassword || writesApiKey || writesSudo) {
      try { await prepareCredentials(); }
      catch (error) { return res.status(503).json({ error: error.message }); }
    }
  }
  next();
});
app.get("/api/runtime", (_req, res) => res.json({ desktop, version: APP_VERSION, remoteOnly: desktop }));

app.get("/api/health", (_req, res) => {
  res.json(inspectHealth(process.env.BIND_HOST || "127.0.0.1"));
});

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ─── REST API ────────────────────────────────────────────
registerFleetEnergyRoute(app, fleetEnergyTracker);
registerLlmTokenTotalsRoute(app, llmTokenLedger);

// Never return SSH passwords in any response
app.get("/api/sparks", (_req, res) => {
  res.json({ sparks: registry.publicSparks });
});

let fabricCheck = null;
app.post("/api/clusters/discover", async (req, res) => {
  if (!allowTest(principalKey(req))) return rejectLimited(res, "Too many test requests; try again shortly");
  if (fabricCheck) return res.status(409).json({ error: "A network check is already running. Try again shortly." });
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 12 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !registry.getSpark(id) || registry.getSpark(id).kind === "host")) {
    return res.status(400).json({ error: "Select 2–12 saved DGX Spark devices" });
  }
  try {
    fabricCheck = fabricDiscovery(ids.map((id) => registry.getSpark(id)));
    res.json(await fabricCheck);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally { fabricCheck = null; }
});

app.get("/api/clusters/benchmark", (_req, res) => res.json({ job: fabricBenchmark.snapshot() }));
app.post("/api/clusters/benchmark", (req, res) => {
  if (!allowTest(principalKey(req))) return rejectLimited(res, "Too many test requests; try again shortly");
  const { headId, a, b } = req.body || {};
  const head = typeof headId === "string" && registry.getSpark(headId);
  const belongs = (id) => {
    const spark = typeof id === "string" && registry.getSpark(id);
    return spark && (spark.id === headId || (spark.role === "worker" && spark.workerHeadId === headId));
  };
  if (!head || head.role !== "head" || a === b || !belongs(a) || !belongs(b)) {
    return res.status(400).json({ error: "Select two members of the same saved cluster" });
  }
  try { res.status(202).json({ job: fabricBenchmark.start([registry.getSpark(a), registry.getSpark(b)], req.body) }); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.delete("/api/clusters/benchmark/:id", async (req, res) => {
  if (fabricBenchmark.snapshot()?.id !== req.params.id) return res.status(404).json({ error: "Network test not found" });
  res.json({ job: await fabricBenchmark.cancel() });
});

function applyCluster(config, dissolve = false) {
  const result = registry.configureCluster(config, dissolve);
  for (const id of result.changedIds) {
    stopMonitor(id);
    startMonitor(registry.getSpark(id));
  }
  forceBroadcast();
  return result;
}
app.post("/api/clusters", (req, res) => {
  try { res.json({ success: true, ...applyCluster(req.body || {}) }); }
  catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.delete("/api/clusters/:headId", (req, res) => {
  try { res.json({ success: true, ...applyCluster({ previousHeadId: req.params.headId }, true) }); }
  catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

// Ephemeral connectivity test — does not persist or start a monitor
app.post("/api/sparks/test", async (req, res) => {
  try {
    if (!allowTest(principalKey(req)) || !allowGlobalDestructive(clientKey(req))) {
      return rejectLimited(res, "Too many test requests; try again shortly");
    }
    const body = req.body || {};
    const validationError = validateSparkTarget(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = {
      id: body.id || "ephemeral-test",
      name: body.name || "test",
      lanIp: body.lanIp || "",
      cx7Ip: body.cx7Ip || null,
      isLocal: Boolean(body.isLocal),
      role: body.role,
      workerNode: Boolean(body.workerNode),
      llmMonitoring: body.llmMonitoring,
      llmPort: resolveLlmPort(body),
      llmPorts: body.llmPorts,
      comfyPort: resolveComfyPort(body),
      comfyMonitoring: Boolean(body.comfyMonitoring),
      hermesMonitoring: Boolean(body.hermesMonitoring),
      tailscaleMonitoring: Boolean(body.tailscaleMonitoring),
      ssh: {
        host: body.ssh?.host || body.lanIp || "",
        user: body.ssh?.user || (desktop ? "" : "root"),
        auth: body.ssh?.auth === "pass" ? "pass" : "key",
        password: body.ssh?.password,
        port: body.ssh?.port,
        identityFile: body.ssh?.identityFile,
      },
    };
    if (!spark.isLocal && !spark.lanIp && !spark.ssh.host) {
      return res.status(400).json({ error: "lanIp or ssh.host required" });
    }
    const llmPort = resolveLlmPort(spark);
    const comfyPort = resolveComfyPort(spark);
    const result = await testSparkConnectivity(spark, { llmPort, comfyPort });
    const byId = Object.fromEntries(result.capabilities.map((capability) => [capability.id, capability]));
    res.json({
      id: spark.id,
      capabilities: result.capabilities,
      ssh: { ok: byId.host.status === "pass", message: byId.host.message },
      llm: { ok: byId.llm.status !== "fail", message: byId.llm.message, skipped: byId.llm.status === "skipped" },
      comfy: { ok: byId.comfy.status !== "fail", message: byId.comfy.message, skipped: byId.comfy.status === "skipped" },
      ok: result.ok,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks", (req, res) => {
  try {
    const validationError = validateSparkTarget(req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = registry.addSpark(req.body);
    fleetEnergyTracker.invalidateMembership(registry.sparkIds);
    startMonitor(spark);
    res.json({ success: true, spark: registry.toPublic(spark) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.patch("/api/sparks/:id", (req, res) => {
  try {
    const body = req.body || {};
    // Only validate host fields if they are being updated
    if (body.lanIp != null || body.ssh != null || body.isLocal != null) {
      const existing = registry.getSpark(req.params.id);
      if (!existing) return res.status(404).json({ error: "Spark not found" });
      const merged = {
        lanIp: body.lanIp ?? existing.lanIp,
        ssh: { ...existing.ssh, ...(body.ssh || {}) },
      };
      const validationError = validateSparkTarget(merged);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    // Password-only update: hot-apply without full monitor restart
    const keys = Object.keys(body).filter((k) => k !== "ssh");
    const sshKeys = body.ssh ? Object.keys(body.ssh) : [];
    const passwordOnly =
      keys.length === 0 &&
      sshKeys.length > 0 &&
      sshKeys.every((k) => k === "password");

    if (passwordOnly && body.ssh?.password) {
      const spark = registry.setPassword(req.params.id, body.ssh.password);
      const mon = monitors.get(req.params.id);
      if (mon) mon.updateConfig(registry.getSpark(req.params.id));
      return res.json({ success: true, spark, hasPassword: true });
    }

    // LLM API keys: an llmPorts change is the second bypass besides out-of-band
    // sparks.json writes. patchSpark() arms the reconcile on the llmPorts
    // own-property (any shape — [] and the legacy scalar are applied by the
    // normalizer too) and syncs against the post-normalize ports.
    const { spark } = registry.patchSpark(req.params.id, body);
    // Restart monitor so collectors pick up host/auth/isLocal changes
    stopMonitor(req.params.id);
    startMonitor(spark);
    res.json({
      success: true,
      spark: registry.toPublic(spark),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete("/api/sparks/:id", (req, res) => {
  try {
    const removed = registry.removeSpark(req.params.id);
    if (!removed) return res.status(404).json({ error: "Spark not found" });
    fleetEnergyTracker.invalidateMembership(registry.sparkIds);
    stopMonitor(req.params.id);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Reorder Sparks in the tab bar (persisted to sparks.json)
app.put("/api/sparks/order", (req, res) => {
  try {
    const order = req.body?.order;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: "body.order must be an array of spark ids" });
    }
    const sparks = registry.reorderSparks(order);
    res.json({ success: true, sparks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Global settings ──────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    const patch = req.body || {};
    const newSettings = updateSettings(patch);
    // If poll interval changed, restart the broadcast timer
    if (patch.pollIntervalMs != null) {
      restartBroadcast();
    }
    res.json(newSettings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/metrics", (req, res) => {
  const monitor = monitors.get(req.params.id);
  if (!monitor) return res.status(404).json({ error: "Spark not found" });
  res.json(monitor.snapshot());
});

// Test SSH + LLM connectivity for a registered Spark.
// Optional body.ssh.password is ALWAYS saved (even if the host is down).
app.post("/api/sparks/:id/test", async (req, res) => {
  if (!allowTest(principalKey(req)) || !allowGlobalDestructive(clientKey(req))) {
    return rejectLimited(res, "Too many test requests; try again shortly");
  }
  try {
    const body = req.body || {};
    const incomingPassword = body.ssh?.password ?? body.password;
    // Persist password first — does not require host reachability
    if (incomingPassword != null && incomingPassword !== "") {
      registry.setPassword(req.params.id, incomingPassword);
    }

    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const result = await testSparkConnectivity(spark, {
      llmPort: resolveLlmPort(spark),
      comfyPort: resolveComfyPort(spark),
    });
    const byId = Object.fromEntries(result.capabilities.map((capability) => [capability.id, capability]));
    res.json({
      id: req.params.id,
      capabilities: result.capabilities,
      ssh: { ok: byId.host.status === "pass", message: byId.host.message },
      llm: { ok: byId.llm.status !== "fail", message: byId.llm.message, skipped: byId.llm.status === "skipped" },
      comfy: { ok: byId.comfy.status !== "fail", message: byId.comfy.message, skipped: byId.comfy.status === "skipped" },
      ok: result.ok,
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a ComfyUI job (running interrupt and/or pending dequeue).
app.post("/api/sparks/:id/comfy/cancel", async (req, res) => {
  if (!allowDestructive(principalKey(req)) || !allowGlobalDestructive(clientKey(req))) {
    return rejectLimited(res, "Too many cancellation requests; try again shortly");
  }
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.comfyMonitoring) {
      return res.status(400).json({ error: "ComfyUI monitoring is disabled for this Spark" });
    }
    const promptId = req.body?.promptId ?? req.body?.prompt_id;
    if (!promptId || typeof promptId !== "string") {
      return res.status(400).json({ error: "promptId is required" });
    }
    const result = await comfyCancelJob(spark, promptId, resolveComfyPort(spark));
    // Nudge a comfy re-poll so UI updates quickly
    const mon = monitors.get(req.params.id);
    if (mon) void mon._pollDomain?.("comfy");
    if (!result.ok) return res.status(502).json({ success: false, ...result, error: result.message });
    res.json({ success: result.ok, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual metric refresh ──────────────────────────────
app.post("/api/sparks/:id/refresh/:domain", async (req, res) => {
  try {
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const { domain } = req.params;
    if (domain !== "storage") {
      return res.status(400).json({ error: "Only 'storage' domain is supported" });
    }
    await monitor.refreshDomain(domain);
    forceBroadcast();
    res.json({ success: true, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Hermes Agent ───────────────────────────────────
// Batch route first (like shutdown-all/wake-all): a plain Sparks-suffixed
// path (3 segments) that cannot be captured by /api/sparks/:id/hermes/* (4).
/** One-click `hermes update` on every Spark with hermes monitoring enabled. */
app.post("/api/sparks/hermes/update-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const monitor = monitors.get(spark.id);
    const entry = { id: spark.id, name: spark.name, ok: false, started: false, skipped: false };
    if (!spark.hermesMonitoring || !monitor) {
      entry.skipped = true;
      entry.reason = spark.hermesMonitoring
        ? "monitor not running"
        : "Hermes Agent monitoring is disabled (enable it in Edit Spark)";
      results.push(entry);
      continue;
    }
    const result = monitor.runHermesUpdate();
    entry.started = Boolean(result.started);
    entry.ok = Boolean(result.started);
    if (!result.started) {
      entry.skipped = true;
      entry.reason = result.reason || "update already running";
    }
    results.push(entry);
  }
  res.json({ success: true, results });
});

/** Re-check for a hermes update now (bypasses the poll cadence). */
app.post("/api/sparks/:id/hermes/check", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.hermesProbe.check();
    monitor.applyHermesCheck(result);
    res.json({ success: true, hermes: monitor.snapshot().hermes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** One-click `hermes update` via SSH. Returns 202; progress via snapshot. */
app.post("/api/sparks/:id/hermes/update", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.runHermesUpdate();
    res.status(result.started ? 202 : 200).json({
      success: result.started,
      reason: result.reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-Spark Hermes update preview: the latest release (cached globally), the
// installed version, the actual pending commits on this Spark (HEAD..origin/main)
// and a resolved `view` so the dialog shows the commit list for minor /
// no-bump updates and the full release changelog only when a real version bump
// is pending.
app.get("/api/sparks/:id/hermes/updates", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });

    const installedVersion = monitor.snapshot().hermes?.version || null;
    const pending = await monitor.hermesProbe.pendingCommits();

    let release = null;
    let releaseError = null;
    try {
      release = await getLatestRelease();
    } catch (err) {
      releaseError = err instanceof Error ? err.message : String(err);
    }

    // Resolve which content the dialog should lead with. A version bump exists
    // only when the latest tagged release is newer than what is installed;
    // otherwise the pending update is commits on main and those are the honest
    // changelog. Without both versions, fall back to the release when available.
    const hasPending = Boolean(pending && pending.commits && pending.commits.length > 0);
    const releaseNewer =
      release?.semver && installedVersion && compareSemver(release.semver, installedVersion) > 0;
    const view = releaseNewer ? "release" : hasPending ? "commits" : "release";

    res.json({
      success: true,
      view,
      release,
      releaseError,
      installedVersion,
      pending,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / update SSH password only (works while host is offline)
app.put("/api/sparks/:id/password", (req, res) => {
  try {
    const password = req.body?.password ?? req.body?.ssh?.password;
    if (password == null || password === "") {
      return res.status(400).json({ error: "password is required" });
    }
    const spark = registry.setPassword(req.params.id, password);
    // Refresh monitor with password in memory (no need if already running — updateConfig)
    const mon = monitors.get(req.params.id);
    if (mon) mon.updateConfig(registry.getSpark(req.params.id));
    res.json({ success: true, spark, hasPassword: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled storage devices for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-devices", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledDevices } = req.body;
    if (!Array.isArray(disabledDevices)) {
      return res.status(400).json({ error: "disabledDevices must be an array" });
    }

    const updated = registry.updateSpark(req.params.id, { disabledDevices });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledDevices });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled network interfaces for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-interfaces", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledInterfaces } = req.body;
    if (!Array.isArray(disabledInterfaces)) {
      return res.status(400).json({ error: "disabledInterfaces must be an array" });
    }

    const cleaned = disabledInterfaces.filter((n) => typeof n === "string" && n.length > 0);
    const updated = registry.updateSpark(req.params.id, { disabledInterfaces: cleaned });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledInterfaces: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update LLM probe ports for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPorts;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "llmPorts must be an array" });
    }
    const ports = raw
      .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    // Deduplicate
    const unique = [...new Set(ports)];
    if (unique.length === 0) {
      return res.status(400).json({ error: "llmPorts must contain at least one valid port 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    const updated = registry.updateSpark(req.params.id, { llmPorts: unique });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, unique);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backward-compat: update single LLM port (delegates to llm-ports)
app.put("/api/sparks/:id/llm-port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "llmPort must be an integer 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    // Replace the ports list with just this single port
    const updated = registry.updateSpark(req.params.id, { llmPorts: [n] });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, [n]);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPort: n,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Add a single LLM port to a Spark (hot — no monitor restart)
app.post("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.port;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    if (currentPorts.includes(n)) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: [...currentPorts, n] });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, llmPorts: updated.llmPorts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an LLM port from a Spark (hot — no monitor restart)
app.delete("/api/sparks/:id/llm-ports/:port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    // Primary (first) port cannot be removed — only additional ports
    if (currentPorts[0] === port) {
      return res.status(400).json({ error: "Cannot remove the primary LLM port" });
    }
    const newPorts = currentPorts.filter((p) => p !== port);
    if (newPorts.length === 0) {
      return res.status(400).json({ error: "Cannot remove the last LLM port" });
    }
    if (newPorts.length === currentPorts.length) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: newPorts });
    registry.clearLlmApiKey(req.params.id, port);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set / clear optional LLM API key for one port (encrypted secrets store)
app.put("/api/sparks/:id/llm-ports/:port/api-key", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "apiKey")) {
      return res.status(400).json({ error: "apiKey is required (use \"\" to clear)" });
    }

    const apiKey = req.body.apiKey == null ? "" : String(req.body.apiKey);
    const publicSpark = registry.setLlmApiKey(req.params.id, port, apiKey);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      spark: publicSpark,
      hasApiKey: registry.hasLlmApiKey(req.params.id, port),
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Daily decode / prefill tok/s rollups (busy samples, last 14 UTC days by default).
 * Query: port (required for multi-port), days (1–30).
 */
app.get("/api/sparks/:id/llm/daily", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const ports =
    Array.isArray(spark.llmPorts) && spark.llmPorts.length
      ? spark.llmPorts
      : [resolveLlmPort(spark)];
  let port = req.query.port != null ? Number(req.query.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  let days = req.query.days != null ? Number(req.query.days) : 14;
  if (!Number.isFinite(days)) days = 14;
  res.json(llmDaily.getSeries(spark.id, port, { days }));
});

/**
 * Decode throughput benchmark (streaming, post-first-token tok/s).
 *
 * POST body: { port?, concurrencies: number[], maxTokens?, promptType? }
 * promptType is structured | prose | code | json (default structured).
 * Returns immediately with a bench job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/bench", async (req, res) => {
  if (decodeBenchManager.activeCount() + prefillBenchManager.activeCount() >= MAX_ACTIVE_BENCH_JOBS) {
    return res.status(429).json({ error: "Global active benchmark cap reached; wait for a job to finish" });
  }
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prefill benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let target;
  try {
    target = await benchHttpTarget(spark, ports, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const port = target.port;
  try {
    validateDecodeBudget(normalizeConcurrencies(req.body?.concurrencies), req.body?.maxTokens ?? 400);
  } catch (err) {
    return res.status(err.status || 429).json({ error: err.message });
  }

  // Resolve model id for this port from live snapshot when possible
  let modelId = req.body?.modelId || null;
  if (!modelId && !target.custom && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    if (!consumeBenchStartQuota(req, res)) return;
    const benchDebug = Boolean(getSettings().benchDebugTraces);
    const job = decodeBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      concurrencies: req.body?.concurrencies,
      maxTokens: req.body?.maxTokens,
      promptType: req.body?.promptType,
      debug: benchDebug,
      apiKey: target.apiKey,
      host: target.host,
      tls: target.tls,
      resolveTarget: target.resolveTarget,
      sampleHardware:
        benchDebug && monitor && !target.custom
          ? async () => {
              const fromGpu = (gpu, um) =>
                gpu
                  ? {
                      gpuUsage: gpu.usage ?? null,
                      temperature: gpu.temperature ?? null,
                      powerDraw: gpu.power?.draw ?? null,
                      powerLimit: gpu.power?.limit ?? null,
                      vramUsed: gpu.vram?.used ?? null,
                      vramTotal: gpu.vram?.total ?? null,
                      vramAvailable: gpu.vram?.available ?? null,
                      memAvailable: um?.available ?? null,
                    }
                  : null;

              // Local: fresh collect so the timeline isn't stuck on the 2s poll cache.
              // Remote: use snapshot only — SSH collectGpu every 1s is too heavy mid-bench.
              if (spark.isLocal) {
                try {
                  const [gpu, um] = await Promise.all([
                    monitor.collector.collectGpu(),
                    monitor.collector.collectUnifiedMemory(),
                  ]);
                  return fromGpu(gpu, um);
                } catch {
                  /* fall through */
                }
              }
              const snap = monitor.snapshot();
              return fromGpu(snap?.metrics?.gpu, snap?.metrics?.unifiedMemory);
            }
          : null,
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = decodeBenchManager.getActive(spark.id);
  const history = decodeBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = decodeBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: DECODE_BENCH_DEFAULTS,
  });
});

/** Clear finished bench history for a Spark (optional ?port=). Does not cancel a running job. */
app.delete("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  decodeBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job); // already public shape from manager
});

app.delete("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * Prefill throughput + TTFT at selected context sizes (up to 300k).
 *
 * POST body: { port?, contextSizes: number[] }
 * Returns 202 job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/prefill-bench", async (req, res) => {
  if (decodeBenchManager.activeCount() + prefillBenchManager.activeCount() >= MAX_ACTIVE_BENCH_JOBS) {
    return res.status(429).json({ error: "Global active benchmark cap reached; wait for a job to finish" });
  }
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A decode benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let target;
  try {
    target = await benchHttpTarget(spark, ports, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const port = target.port;
  try {
    validatePrefillBudget(normalizeContextSizes(req.body?.contextSizes));
  } catch (err) {
    return res.status(err.status || 429).json({ error: err.message });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && !target.custom && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    if (!consumeBenchStartQuota(req, res)) return;
    const job = prefillBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      contextSizes: req.body?.contextSizes,
      apiKey: target.apiKey,
      host: target.host,
      tls: target.tls,
      resolveTarget: target.resolveTarget,
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = prefillBenchManager.getActive(spark.id);
  const history = prefillBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = prefillBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: PREFILL_BENCH_DEFAULTS,
  });
});

app.delete("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  prefillBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job);
});

app.delete("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * LLM Prompt Showcase — concurrent streaming demos.
 *
 * POST body: { port, modelId?, maxTokens?, temperature?, thinking?, promptType?, prompts: string[] }
 * Returns 202 { sessionId }; poll GET for deltas; DELETE :sessionId to cancel.
 * Finished runs are archived; GET collection lists history; DELETE collection clears it.
 */
app.post("/api/sparks/:id/llm/showcase", async (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  if (req.body?.port == null) {
    return res.status(400).json({ error: "port is required" });
  }
  const port = Number(req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  let showcaseTarget;
  try {
    if (desktop) showcaseTarget = await serviceTargets.acquire(spark, port);
    const result = showcaseManager.start({
      sparkId: spark.id,
      baseUrl: showcaseTarget ? serviceBaseUrl(showcaseTarget) : undefined,
      closeTarget: showcaseTarget?.close,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      maxTokens: req.body?.maxTokens,
      temperature: req.body?.temperature,
      thinking: req.body?.thinking,
      promptType: req.body?.promptType,
      prompts: req.body?.prompts,
      apiKey: resolveLlmApiKey(spark, port),
    });
    res.status(202).json(result);
  } catch (err) {
    showcaseTarget?.close();
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/** Active session + finished history summaries (no stream bodies). */
app.get("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  res.json({
    active: showcaseManager.getActive(spark.id),
    history: showcaseManager.getHistory(spark.id),
  });
});

/** Clear finished showcase history for a Spark. Does not cancel a running session. */
app.delete("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a showcase is running" });
  }
  showcaseManager.clearHistory(spark.id);
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const sinceRaw = req.query.since;
  const since =
    sinceRaw != null && sinceRaw !== ""
      ? parseInt(String(sinceRaw), 10)
      : null;
  const session = showcaseManager.getSession(
    spark.id,
    req.params.sessionId,
    Number.isInteger(since) ? since : null
  );
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

app.delete("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const session = showcaseManager.cancel(spark.id, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

// ─── Power management ────────────────────────────────────
// Power operations use fixed systemctl commands over SSH, with independent sudo credentials.
function initiateSparkPower(spark, action, inputPassword) {
  if (registry.getSudoTarget(spark.id, spark) !== registry.getSudoTarget(spark.id)) {
    throw new Error("SSH target changed; reopen the power dialog and verify again");
  }
  if (spark.isLocal) return spawnLocalPower({ action });
  return authenticatedPowerAction(spark, action, inputPassword ?? registry.getSudoPassword(spark.id), powerExec);
}

/** Batch routes first so they never collide with /:id/* if routing changes. */
app.get("/api/sparks/:id/sudo", (req, res) => {
  if (!registry.getSpark(req.params.id)) return res.status(404).json({ error: "Spark not found" });
  res.json({ hasPassword: Boolean(registry.getSudoPassword(req.params.id)) });
});
app.put("/api/sparks/:id/sudo", async (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  try {
    await verifySudoPassword(spark, req.body?.password, powerExec);
    registry.setSudoPassword(spark.id, req.body.password, spark);
    res.json({ hasPassword: true });
  } catch { res.status(400).json({ error: "Could not verify and save sudo authentication" }); }
});
app.delete("/api/sparks/:id/sudo", (req, res) => {
  if (!registry.getSpark(req.params.id)) return res.status(404).json({ error: "Spark not found" });
  try { registry.setSudoPassword(req.params.id, null); res.json({ hasPassword: false }); }
  catch { res.status(500).json({ error: "Could not clear saved sudo authentication" }); }
});
app.post("/api/sparks/:id/power-check", async (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  try {
    const target = registry.getSudoTarget(spark.id, spark);
    const result = await checkPowerAuth(spark, req.body?.password ?? registry.getSudoPassword(spark.id), powerExec);
    if (target !== registry.getSudoTarget(spark.id)) throw new Error("Target changed");
    res.json({ ...result, target, hasPassword: Boolean(registry.getSudoPassword(spark.id)) });
  } catch { res.status(503).json({ error: "Could not check shutdown authentication; verify the SSH connection" }); }
});

for (const action of ["shutdown", "reboot"]) {
  app.post(`/api/sparks/${action}-all`, async (req, res) => {
    const results = [];
    const requested = req.body?.ids;
    if (requested !== undefined && (!Array.isArray(requested) || !requested.length || requested.some(id => typeof id !== "string" || !registry.getSpark(id)))) {
      return res.status(400).json({ error: "Invalid device selection" });
    }
    const ordered = [...registry.sparks.filter(s => !s.isLocal), ...registry.sparks.filter(s => s.isLocal)];
    for (const spark of ordered) {
      if (requested && !requested.includes(spark.id)) continue;
      if (!monitors.get(spark.id)?.online) {
        results.push({ id: spark.id, ok: false, skipped: true, error: "Offline — skipped" }); continue;
      }
      try {
        if (req.body?.targets && req.body.targets[spark.id] !== registry.getSudoTarget(spark.id, spark)) {
          throw new Error("SSH target changed; reopen the power dialog and verify again");
        }
        const message = await initiateSparkPower(spark, action, req.body?.sudoPasswords?.[spark.id]);
        results.push({ id: spark.id, ok: true, message });
      } catch (error) { results.push({ id: spark.id, ok: false, error: error.message }); }
    }
    res.json({ success: results.every(r => r.ok || r.skipped), results });
  });
}

app.post("/api/sparks/wake-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const cleanMac = effectiveMac(spark);
    if (!cleanMac) {
      results.push({
        id: spark.id,
        ok: false,
        error: "No MAC address (enP7s7 not seen yet; set override in Edit Spark)",
      });
      continue;
    }
    try {
      const broadcast = broadcastForLanIp(spark.lanIp);
      const sent = await sendWol(cleanMac, broadcast);
      results.push({ id: spark.id, ok: true, mac: sent.mac, broadcast: sent.broadcast });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

for (const action of ["shutdown", "reboot"]) {
  app.post(`/api/sparks/:id/${action}`, async (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    try {
      if (req.body?.targets && req.body.targets[spark.id] !== registry.getSudoTarget(spark.id, spark)) {
        throw new Error("SSH target changed; reopen the power dialog and verify again");
      }
      const message = await initiateSparkPower(spark, action, req.body?.sudoPasswords?.[spark.id]);
      res.json({ success: true, message });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
}

app.post("/api/sparks/:id/wake", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Body mac > user override > auto-detected enP7s7
    const cleanMac = normalizeMac(req.body?.mac) || effectiveMac(spark);
    if (!cleanMac) {
      if (req.body?.mac || spark.macAddress) {
        return res.status(400).json({
          error: `Invalid MAC address: ${req.body?.mac || spark.macAddress}`,
        });
      }
      return res.status(400).json({
        error:
          "No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark.",
      });
    }

    const broadcast = broadcastForLanIp(spark.lanIp);
    try {
      const sent = await sendWol(cleanMac, broadcast);
      res.json({
        success: true,
        message: `Magic packet sent to ${sent.mac} via ${sent.broadcast}`,
        mac: sent.mac,
        broadcast: sent.broadcast,
      });
    } catch (err) {
      res.status(500).json({ error: `WoL send failed: ${err.message || String(err)}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files (built frontend) ───────────────────────
const distDir = path.join(ROOT, "dist");
const indexHtml = path.join(distDir, "index.html");
app.use(express.static(distDir));

// ─── SPA fallback (Express v5 wildcard) ───────────────────
app.get("*splat", (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(503)
      .type("text")
      .send("Frontend not built. Run `npm run build` or use `npm run dev`.");
  }
  res.sendFile(indexHtml);
});

// ─── WebSocket ──────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ req }, done) => done(desktop
    ? authorizeDesktopRequest(req, { ...credentials(), websocket: true })
    : authorizeUpgrade(req)),
});
wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  // This snapshot belongs only to the new client. Broadcasting it would add a
  // duplicate history sample to every existing dashboard whenever a tab opens.
  try {
    ws.send(buildSnapshotPayload());
  } catch {
    // The close handler will clean up a client that disappears during connect.
  }
  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

// ─── Broadcast snapshot (dynamic interval) ────────────────
let broadcastTimer = null;
let _lastBroadcastPayload = null;

/** Build the snapshot payload string. Centralized so broadcast + refresh share it. */
function buildSnapshotPayload() {
  return JSON.stringify({
    type: "snapshot",
    generatedAt: Date.now(),
    sparks: orderedSnapshots(),
    refreshInterval: getSettings().pollIntervalMs,
  });
}

/**
 * Send a payload to every open WS client.
 * - Drops clients whose send queue is backlogged (>1 MB) to avoid unbounded
 *   buffering on slow/flaky connections (e.g. phone over spotty WiFi).
 * - Returns the payload so callers can compare against the previous broadcast.
 */
function broadcastPayload(payload) {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return; // OPEN only
    if (client.bufferedAmount > 1_000_000) {
      try {
        client.close(1008, "client too slow");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      client.send(payload);
    } catch {
      /* per-client send failure — ignore, close handler will clean up */
    }
  });
}

/**
 * Force an immediate broadcast, ignoring the diff cache.
 * Used after a user action (manual refresh / hermes check / update) so the
 * UI reflects the result right away instead of on the next poll tick.
 */
function forceBroadcast() {
  const payload = buildSnapshotPayload();
  _lastBroadcastPayload = payload;
  broadcastPayload(payload);
}

function startBroadcast() {
  const interval = getSettings().pollIntervalMs;
  broadcastTimer = setInterval(() => {
    const payload = buildSnapshotPayload();
    // Skip the broadcast entirely when nothing changed since the last tick.
    // A 1s poll that produces identical snapshots becomes free for idle tabs.
    if (_lastBroadcastPayload !== null && payload === _lastBroadcastPayload) return;
    _lastBroadcastPayload = payload;
    broadcastPayload(payload);
  }, interval);
}

function restartBroadcast() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  _lastBroadcastPayload = null; // force a fresh broadcast on the new cadence
  startBroadcast();
}

// The worker owns one backend per process. Importing this module never listens.
let startPromise;
let stopPromise;
function start() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    loadSettings();
    const preflight = inspectStartupPreflight(BIND_HOST);
    logStartupPreflight(preflight, BIND_HOST, PORT);
    if (preflight.fatal) throw new Error(preflight.errors.join("; "));
    if (desktop && !configuredToken()) throw new Error("Desktop authentication is required");
    if (desktop && registry.sparks.some((spark) => spark.isLocal)) {
      throw new Error("Local nodes cannot run in the Mac app. Update the imported configuration to remote SSH targets.");
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(PORT, BIND_HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    origin = `http://${BIND_HOST}:${server.address().port}`;
    console.log(`[sparkDash] server listening on ${origin}`);
    startBroadcast();
    startAllMonitors();
    fleetEnergyRuntime.start();
    llmTokenRuntime.start();
    return { origin };
  })();
  return startPromise;
}

function stop(reason = "App stopped") {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    console.log(`[sparkDash] ${reason}, shutting down…`);
    if (broadcastTimer) clearInterval(broadcastTimer);
    for (const monitor of monitors.values()) monitor.stop();
    monitors.clear();
    decodeBenchManager.interruptAll(`Interrupted — ${reason}`);
    prefillBenchManager.interruptAll(`Interrupted — ${reason}`);
    showcaseManager.stop(reason);
    serviceTargets.stop();
    await fabricBenchmark.stop();
    await closeSshConnections();
    llmDaily.flush();
    llmTokenRuntime.stop();
    const persisted = fleetEnergyRuntime.stop();
    await closeLlmStreamAgent();
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    return { persisted };
  })();
  return stopPromise;
}
return { app, server, wss, start, stop };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const backend = createBackend();
  const shutdown = async (signal) => {
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    try {
      const result = await backend.stop(signal);
      process.exit(result.persisted ? 0 : 1);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  backend.start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
