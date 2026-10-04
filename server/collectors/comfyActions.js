/**
 * ComfyUI mutation helpers (cancel / interrupt) — server-side only.
 */
import { COMFY_PORT, COMFY_PROBE_TIMEOUT_MS } from "../config.js";
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "./llmHost.js";
import { serviceTargets, serviceBaseUrl } from "./ServiceTargets.js";

/**
 * @param {object} spark
 * @param {number} [port]
 */
function baseUrl(spark, port) {
  const host = llmProbeHost(spark);
  if (!isAllowedTargetHost(host)) {
    throw new Error(`Invalid or disallowed ComfyUI host: ${host}`);
  }
  const p =
    Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : Number(spark?.comfyPort) || COMFY_PORT;
  return `http://${host}:${p}`;
}

/**
 * Cancel a ComfyUI job by prompt id.
 * Prefers /api/jobs/:id/cancel; falls back to interrupt + queue delete.
 *
 * @param {object} spark
 * @param {string} promptId
 * @param {number} [port]
 * @returns {Promise<{ ok: boolean, method: string, message: string }>}
 */
export async function comfyCancelJob(spark, promptId, port) {
  if (!promptId || typeof promptId !== "string") {
    return { ok: false, method: "none", message: "promptId required" };
  }
  const lease = process.env.SPARKDASH_DESKTOP === "1"
    ? await serviceTargets.acquire(spark, port || spark.comfyPort || COMFY_PORT, 'comfy') : null;
  try { return await cancelAtRoot(lease ? serviceBaseUrl(lease) : baseUrl(spark, port), promptId); }
  finally { lease?.close(); }
}

async function cancelAtRoot(root, promptId) {
  const signal = AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS);

  // 1) Modern jobs API
  try {
    const res = await fetch(`${root}/api/jobs/${encodeURIComponent(promptId)}/cancel`, {
      method: "POST",
      signal,
    });
    if (res.ok) {
      return { ok: true, method: "api_jobs_cancel", message: "cancelled" };
    }
    // Only an unsupported endpoint permits a legacy fallback. Authentication,
    // server, or transport errors are not permission to issue another mutation.
    if (res.status !== 404 && res.status !== 405) {
      const text = await res.text().catch(() => "");
      return { ok: false, method: "api_jobs_cancel", message: `HTTP ${res.status} ${text.slice(0, 120)}` };
    }
  } catch (err) {
    return { ok: false, method: "api_jobs_cancel", message: `Cancellation could not be confirmed: ${err.message}` };
  }

  // Legacy interrupt can affect the current running job regardless of its
  // request body. Never call it when deleting a pending or disappeared job.
  try {
    const response = await fetch(`${root}/queue`, { signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, method: "queue_check", message: `HTTP ${response.status}` };
    const queue = await response.json();
    const contains = (entries) => Array.isArray(entries) && entries.some((entry) => Array.isArray(entry) && entry[1] === promptId);
    const pending = contains(queue.queue_pending);
    const running = contains(queue.queue_running);
    if (!pending && !running) return { ok: false, method: "queue_check", message: "Job is no longer in the queue; no cancellation was sent" };
    if (!pending && queue.queue_running.length !== 1) return { ok: false, method: "queue_check", message: "Legacy interrupt cannot safely target one of multiple running jobs" };
    const endpoint = pending ? "queue" : "interrupt";
    const res = await fetch(`${root}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending ? { delete: [promptId] } : { prompt_id: promptId }),
      signal: AbortSignal.timeout(COMFY_PROBE_TIMEOUT_MS),
    });
    return {
      ok: res.ok, method: pending ? "queue_delete" : "interrupt",
      message: res.ok ? (pending ? "queue deletion requested" : "interrupt requested; awaiting queue update") : `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, method: "legacy_cancel", message: `Cancellation could not be confirmed: ${err.message}` };
  }
}
