import { translate as tr, useLocale } from "../../i18n";
import { useEffect, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark, resolveSparkRole } from "../../api/sparkRole";
import { shutdownAllSparks, rebootAllSparks, updateAllHermes, wakeAllSparks } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { MetricBar } from "../ui/MetricBar";
import { FleetEnergyCard } from "./FleetEnergyCard";
import { FleetAlertStrip } from "./FleetAlertStrip";
import { FleetTokenTotals } from "./FleetTokenTotals";
import { ActivityIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";
import { formatMb } from "../../shared/formatBytes";
import { ClusterBenchmarkDialog } from "./ClusterBenchmarkDialog";
import { ClusterSetupDialog } from "./ClusterSetupDialog";
import { clusterGroups } from "./clusters";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  hideWorkers?: boolean;
  showFleetEnergy?: boolean;
  showFleetExceptions?: boolean;
  showOverviewSearch?: boolean;
  /** Overview LLM token totals card (cumulative tokens per model). */
  showLlmTokenTotals?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}



/** Format a storage value in MB, stripping trailing ".0" and optionally omitting the unit. */
function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function MiniStat({
  label,
  value,
  tone = "default",
  bold = true,
  title,
  wrap = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  bold?: boolean;
  title?: string;
  /** Allow value to wrap (no ellipsis trim) — used for long model ids. */
  wrap?: boolean;
}) {
  useLocale();
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "accent"
          ? "text-accent"
          : tone === "success"
            ? "text-success"
            : "text-text";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] tracking-wide text-muted">{label}</span>
      <span
        className={`font-tabular text-[13px] ${
          wrap
            ? "whitespace-normal break-words leading-snug [overflow-wrap:anywhere]"
            : "truncate"
        } ${bold ? "font-semibold" : ""} ${toneClass}`}
        title={title}
      >
        {value}
      </span>
    </div>
  );
}

function SparkCard({
  spark,
  headSparkName,
  temperatureUnit,
  onSelect,
}: {
  spark: SparkSnapshot;
  headSparkName?: string | null;
  temperatureUnit: "celsius" | "fahrenheit";
  onSelect?: (id: string) => void;
}) {
  useLocale();
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(tempRaw) : tempRaw;
  const tempLabel = temperatureUnit === "fahrenheit" ? `${displayTemp}°F` : `${displayTemp}°C`;
  // Spark totals describe the whole shared pool, not GPU process attribution.
  const memory = spark.kind === "host" ? gpu?.vram : um;
  const vramPct = memory?.percentage ?? 0;
  const vramUsed = memory?.used ?? 0;
  const vramTotal = memory?.total ?? 0;
  const vramAvail = memory?.available ?? 0;

  // Temperature bar: cool → success, warm → warning, hot → danger
  const tempBarColor =
    tempRaw > 85 ? "bg-danger" : tempRaw > 65 ? "bg-warning" : tempRaw > 40 ? "bg-accent" : "bg-success";
  // Usage bar: accent for moderate, warning high, danger critical
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  // VRAM allocation: accent normal → warning/danger as it fills
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  return (
    <div
      className="overview-card flex flex-col"
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(online ? {} : { opacity: 0.6 }),
      }}
    >
      {/* Card header */}
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong">
          {onSelect ? (
            <button
              type="button"
              onClick={() => onSelect(spark.id)}
              className="text-left font-inherit text-inherit hover:underline"
            >
              {spark.name}
            </button>
          ) : (
            spark.name
          )}
        </span>
        {(() => {
          const role = resolveSparkRole(spark);
          const text =
            role === "head" ? tr("Head") : role === "worker" ? tr("Worker") : tr("Standalone");
          const title =
            role === "head"
              ? tr("Cluster head Spark")
              : role === "worker"
                ? spark.workerLabel?.trim()
                  ? tr("{0} · distributed LLM worker", [spark.workerLabel.trim()])
                  : tr("Distributed LLM worker")
                : spark.llmMonitoring === false
                  ? tr("Standalone — LLM monitoring off")
                  : tr("Standalone Spark");
          return (
            <span
              className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
              title={title}
            >
              {text}
            </span>
          );
        })()}
        {spark.comfyMonitoring ? (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              !spark.metrics?.comfy?.available
                ? "bg-border/60 text-muted"
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? "bg-accent/15 text-accent"
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? "bg-warning/15 text-warning"
                    : "bg-border/60 text-muted"
            }`}
            title={
              !spark.metrics?.comfy?.available
                ? tr("ComfyUI monitoring on — not reachable")
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? spark.metrics.comfy.activeJob?.title
                    ? tr("ComfyUI running: {0}", [spark.metrics.comfy.activeJob.title])
                    : tr("ComfyUI job running")
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? tr("ComfyUI queue: {0} pending", [spark.metrics.comfy.queuePending])
                    : tr("ComfyUI idle")
            }
          >
            {!spark.metrics?.comfy?.available
              ? "Comfy"
              : (spark.metrics.comfy.queueRunning ?? 0) > 0
                ? tr("Comfy · run")
                : (spark.metrics.comfy.queuePending ?? 0) > 0
                  ? tr("Comfy · {0}q", [spark.metrics.comfy.queuePending])
                  : tr("Comfy · idle")}
          </span>
        ) : null}
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {online ? tr("online") : tr("offline")}
        </span>
      </div>

      {!online || !gpu ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[13px] text-muted">
            {online ? tr("GPU metrics unavailable") : tr("Host unreachable")}
          </span>
        </div>
      ) : (
        <>
          {/* Three headline bars: GPU alloc, Temp, Usage */}
          <div className="flex flex-col gap-3.5">
            <MetricBar
              label={spark.kind === "host" ? "VRAM" : tr("Shared memory")}
              value={vramUsed}
              max={vramTotal}
              color={vramBarColor}
              caption={vramTotal > 0 ? `${fmtStorage(vramUsed, false)} / ${fmtStorage(vramTotal, true)}` : "—"}
            />
            {spark.kind === "host" && (() => {
              // Non-Spark hosts: system RAM is separate from discrete VRAM.
              const ram = spark.metrics.ram;
              const rUsed = ram?.used ?? 0;
              const rTotal = ram?.total ?? 0;
              const rPct = rTotal > 0 ? Math.round((rUsed / rTotal) * 100) : 0;
              const ramBarColor = rPct > 85 ? "bg-danger" : rPct > 60 ? "bg-warning" : "bg-accent";
              return (
                <MetricBar
                  label="RAM"
                  value={rUsed}
                  max={rTotal}
                  color={ramBarColor}
                  caption={rTotal > 0 ? `${fmtStorage(rUsed, false)} / ${fmtStorage(rTotal, true)}` : "—"}
                />
              );
            })()}
            <MetricBar
              label={
                spark.kind === "host" || (spark.metrics.cpu?.temperature ?? 0) > 0
                  ? "GPU"
                  : tr("Temperature")
              }
              value={displayTemp}
              max={temperatureUnit === "fahrenheit" ? 212 : 100}
              color={tempBarColor}
              caption={tempLabel}
            />
            {(spark.metrics.cpu?.temperature ?? 0) > 0 && (() => {
              const cpuRaw = spark.metrics.cpu?.temperature ?? 0;
              const cpuDisplay =
                temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(cpuRaw) : cpuRaw;
              const cpuLabel =
                temperatureUnit === "fahrenheit" ? `${cpuDisplay}°F` : `${cpuDisplay}°C`;
              const cpuBarColor =
                cpuRaw > 95 ? "bg-danger" : cpuRaw > 85 ? "bg-warning" : cpuRaw > 50 ? "bg-accent" : "bg-success";
              return (
                <MetricBar
                  label="CPU"
                  value={cpuDisplay}
                  max={temperatureUnit === "fahrenheit" ? 212 : 100}
                  color={cpuBarColor}
                  caption={cpuLabel}
                />
              );
            })()}
            {gpu?.throttle?.thermal && (
              <div
                className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger"
                title={gpu.throttle.detail || tr("GPU thermal slowdown engaged")}
              >{tr("Thermal throttle")}</div>
            )}
            <MetricBar
              label={tr("Usage")}
              value={usage}
              max={100}
              color={usageBarColor}
              caption={`${usage}%`}
            />
          </div>

          {/* Secondary stats */}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3.5">
            <MiniStat
              label={tr("GPU Power")}
              value={`${gpu?.power?.draw ?? 0}W / ${gpu?.power?.limit ?? 0}W`}
            />
            {vramAvail > 0 && (
              <MiniStat
                label={tr("Available")}
                value={formatMb(vramAvail)}
                tone={vramAvail < 4096 ? "danger" : vramAvail < 16384 ? "warning" : "accent"}
              />
            )}
            {(() => {
              // Find the root disk by label "/" (the collector maps the host
              // root mount to that label). Fall back to the GB10 partition name
              // so the overview keeps working where labels aren't populated.
              const rootDisk =
                spark.metrics.storage.find((d) => d.label === "/") ??
                spark.metrics.storage.find((d) => d.device === "nvme0n1p2");
              if (rootDisk) {
                return (
                  <MiniStat
                    label={tr("Storage")}
                    value={`${fmtStorage(rootDisk.used, false)} / ${fmtStorage(rootDisk.total, true)}`}
                    tone={rootDisk.percentage > 85 ? "danger" : rootDisk.percentage > 60 ? "warning" : "default"}
                    bold={false}
                  />
                );
              }
              return null;
            })()}
            {(() => {
              const role = resolveSparkRole(spark);

              // Workers have no local LLM API — show cluster/model label instead.
              // Priority: manual workerLabel override > derived head-model
              // mirror > generic fallback. Derived never shows a stale model:
              // the backend nulls it when the head is unresolvable/offline.
              if (role === "worker") {
                const label =
                  spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || "distributed";
                const title = headSparkName
                  ? tr("{0} · worker of {1}", [label, headSparkName])
                  : tr("{0} · distributed LLM worker", [label]);
                return (
                  <MiniStat
                    label={tr("Worker")}
                    value={label}
                    tone="accent"
                    title={title}
                    wrap
                  />
                );
              }

              // Head / Standalone: same as before — live backend + model id.
              const llmArr = spark.metrics.llm;
              const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
              if (!llm) return null;
              return (
                <MiniStat
                  label={
                    llm.backend === "vllm"
                      ? "vLLM"
                      : llm.backend === "ds4"
                        ? "ds4"
                        : llm.backend === "sglang"
                          ? "sgLang"
                          : llm.backend === "exl3"
                            ? "EXL3"
                            : llm.backend === "q27"
                              ? "q27"
                              : llm.backend === "tensorfold"
                                ? "TensorFold"
                                : llm.backend ?? "LLM"
                  }
                  value={llm.modelId ?? tr("unknown")}
                  tone="accent"
                  title={llm.modelId ?? undefined}
                  wrap
                />
              );
            })()}
          </div>

          {(() => {
            const role = resolveSparkRole(spark);
            if (role === "worker") return null;
            const llmArr = spark.metrics.llm;
            const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
            if (!llm) return null;
            return (
              <div className="mt-3.5 grid grid-cols-2 gap-2 border-t border-border pt-3">
                <div className="text-center">
                  <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                    {llm.liveRatesAvailable === false ? "—" : llm.generationTps.toFixed(0)}
                  </span>
                  <span className="text-sm font-normal text-muted"> tok/s</span>
                </div>
                <div className="border-l border-border text-center">
                  <span className="font-tabular text-[28px] font-bold leading-none text-text-strong">
                    {llm.liveRatesAvailable === false ? "—" : llm.prefillTps.toFixed(0)}
                  </span>
                  <span className="text-sm font-normal text-muted">{tr(" prefill")}</span>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

export function OverviewPage({
  sparks,
  hideOffline = false,
  hideWorkers = false,
  showFleetEnergy = false,
  showFleetExceptions = false,
  showOverviewSearch = false,
  showLlmTokenTotals = false,
  temperatureUnit = "celsius",
  onSelectSpark,
}: OverviewPageProps) {
  useLocale();
  const [query, setQuery] = useState("");
  const [clusterSetup, setClusterSetup] = useState<{ headId?: string } | null>(null);
  const [benchmarkHeadId, setBenchmarkHeadId] = useState<string | null>(null);
  const groups = clusterGroups(sparks);
  const benchmarkGroup = groups.find((g) => g.head.id === benchmarkHeadId);
  const groupedIds = new Set(groups.flatMap((g) => g.members.map((s) => s.id)));
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "offline" | "issues">("all");
  const withoutWorkers = hideWorkers ? sparks.filter((s) => !isWorkerSpark(s)) : sparks;
  const visibleSparks = withoutWorkers.filter((spark) => {
    if (hideOffline && !spark.online) return false;
    if (showOverviewSearch && query && !spark.name.toLowerCase().includes(query.toLowerCase())) return false;
    if (showOverviewSearch && statusFilter === "online" && !spark.online) return false;
    if (showOverviewSearch && statusFilter === "offline" && spark.online) return false;
    if (showOverviewSearch && statusFilter === "issues" && spark.online && !spark.metrics.storage.some((disk) => disk.percentage >= 90)) return false;
    return true;
  });
  const hiddenWorkerCount = hideWorkers ? sparks.filter(isWorkerSpark).length : 0;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [powerAction, setPowerAction] = useState<"shutdown" | "reboot">("shutdown");
  const [powerTargets, setPowerTargets] = useState<Array<{ id: string; name: string }>>([]);
  /** Spark ids we started a batch Hermes update on; drives the live progress bar. */
  const [batchRun, setBatchRun] = useState<string[] | null>(null);

  const onlineShutdownCount = sparks.filter((s) => s.online).length;
  const hermesMonitoredCount = sparks.filter((s) => s.hermes?.monitoring).length;
  const hermesPendingUpdateCount = sparks.filter((s) => s.hermes?.updateAvailable === true).length;

  // Live batch progress — counted from WS snapshots, not from the one-shot HTTP response.
  const batchProg = (() => {
    if (!batchRun || batchRun.length === 0) return null;
    let done = 0;
    let failed = 0;
    for (const id of batchRun) {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) continue;
      if (h.status === "error") {
        done += 1;
        failed += 1;
      } else if (h.status === "success" || h.finishedAt != null) {
        done += 1;
      }
    }
    return { total: batchRun.length, done, failed };
  })();

  // Once every started update has settled (success/error), dismiss the progress bar.
  useEffect(() => {
    if (!batchRun || batchRun.length === 0) return;
    const settled = batchRun.reduce((n, id) => {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) return n;
      return n + (h.status === "success" || h.status === "error" || h.finishedAt != null ? 1 : 0);
    }, 0);
    if (settled === batchRun.length) {
      const t = setTimeout(() => setBatchRun(null), 6000);
      return () => clearTimeout(t);
    }
  }, [batchRun, sparks]);

  async function handleUpdateAllHermes() {
    if (hermesMonitoredCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await updateAllHermes();
      const started = res.results.filter((r) => r.started);
      const skipped = res.results.filter((r) => r.skipped).length;
      const failed = res.results.filter((r) => !r.ok && !r.skipped).length;
      const parts = [tr("{0} update{1} started", [started.length, started.length === 1 ? "" : "s"])];
      if (skipped) parts.push(tr("{0} skipped", [skipped]));
      if (failed) parts.push(tr("{0} failed", [failed]));
      setBatchMsg({
        text: parts.join(", "),
        tone: failed === 0 ? "ok" : "err",
      });
      // Merge with any in-flight batch instead of replacing (server may skip
      // already-running jobs, which must not clear a live progress bar).
      setBatchRun((prev) => {
        const ids = started.map((r) => r.id);
        if (ids.length === 0) return prev;
        return [...new Set([...(prev ?? []), ...ids])];
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : tr("Batch hermes update failed"),
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  /** Snapshot the online set when the dialog opens; that list is what gets confirmed and sent. */
  function openPowerDialog(action: "shutdown" | "reboot") {
    setPowerTargets(sparks.filter((s) => s.online).map((s) => ({ id: s.id, name: s.name })));
    setPowerAction(action);
    setShutdownOpen(true);
  }

  async function handleShutdownAll(sudoPasswords: Record<string, string>, targets: Record<string, string>) {
    if (powerTargets.length === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await (powerAction === "reboot" ? rebootAllSparks : shutdownAllSparks)(sudoPasswords, powerTargets.map(s => s.id), targets);
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [tr("{0} power requests accepted", [ok])];
      if (fail) parts.push(...res.results.filter(r => !r.ok && !r.skipped).map(r => `${sparks.find(s => s.id === r.id)?.name || r.id}: ${tr(r.error || "Shutdown failed")}`));
      if (skipped) parts.push(tr("{0} skipped", [skipped]));
      setBatchMsg({
        text: parts.join(", "),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : tr("Batch shutdown failed"),
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? tr("{0} wake packet(s) sent", [ok]) : tr("{0} sent, {1} failed", [ok, fail]),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : tr("Batch wake failed"),
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (sparks.length === 0) {
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <ActivityIcon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-text-strong">{tr("No Sparks registered")}</h2>
        <p className="mt-1 text-xs text-muted">{tr("Click the + tab to add a DGX Spark unit.")}</p>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}>
      {showFleetEnergy ? <FleetEnergyCard nodeCount={sparks.length} /> : null}
      {showFleetExceptions ? <FleetAlertStrip sparks={sparks} onSelect={onSelectSpark} /> : null}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >{tr("Overview")}</h1>
        <div className="flex flex-wrap items-end justify-end gap-3">
          <button type="button" onClick={() => setClusterSetup({})} className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-medium text-accent hover:bg-accent/20">
            <ActivityIcon className="h-4 w-4" />{tr("Detect 200G / Create cluster")}
          </button>
          {batchMsg && (
            <span className={`text-[11px] ${batchMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
              {batchMsg.text}
            </span>
          )}
          {batchProg && (
            <div className="flex flex-col items-end gap-1">
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <RotateIcon className="h-3 w-3" />{tr("Updating Hermes — ")}{batchProg.done}/{batchProg.total}
                {batchProg.failed > 0 && (
                  <span className="text-danger">({batchProg.failed}{tr(" failed)")}</span>
                )}
                <button
                  type="button"
                  onClick={() => setBatchRun(null)}
                  aria-label={tr("Dismiss update progress")}
                  title={tr("Dismiss")}
                  className="rounded p-0.5 text-muted transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <span className="text-xs leading-none">✕</span>
                </button>
              </span>
              <div className="h-1 w-36 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                    batchProg.failed > 0 ? "bg-danger" : "bg-accent"
                  }`}
                  style={{
                    width: `${batchProg.total > 0 ? Math.round((batchProg.done / batchProg.total) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
          {sparks.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {hermesMonitoredCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleUpdateAllHermes()}
                  disabled={batchLoading}
                  title={tr("Run `hermes update` on every Spark with Hermes Agent enabled")}
                  className={`flex items-center gap-1 rounded-md border bg-surface-elevated px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
                    hermesPendingUpdateCount > 0
                      ? "border-warning/40 text-warning hover:bg-warning/15"
                      : "border-border text-muted hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  <RotateIcon className="h-3 w-3" />{tr("Update Hermes")}{hermesPendingUpdateCount > 0 && (
                    <span
                      className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white"
                      title={tr("{0} Spark{1} with a Hermes update available", [hermesPendingUpdateCount, hermesPendingUpdateCount === 1 ? "" : "s"])}
                    >
                      {hermesPendingUpdateCount}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleWakeAll()}
                disabled={batchLoading}
                title={tr("Wake all Sparks that have a MAC configured (WoL)")}
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
              >
                <PowerOnIcon className="h-3 w-3" />{tr("Wake All")}</button>
              <button
                type="button"
                onClick={() => openPowerDialog("shutdown")}
                disabled={batchLoading || onlineShutdownCount === 0}
                title={tr("Shut down all online Sparks")}
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
              >
                <PowerOffIcon className="h-3 w-3" />{tr("Shutdown All")}</button>
              <button
                type="button"
                onClick={() => openPowerDialog("reboot")}
                disabled={batchLoading || onlineShutdownCount === 0}
                title={tr("Reboot all online Sparks")}
                className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-warning/20 hover:text-warning disabled:opacity-50"
              >
                <RotateIcon className="h-3 w-3" />{tr("Reboot All")}</button>
            </div>
          )}
          <span className="online-chip">
            <span className="dot" />
            {onlineCount}/{visibleSparks.length}{tr(" online")}</span>
          {hiddenWorkerCount > 0 && (
            <span className="text-[11px] text-muted">
              {tr(hiddenWorkerCount === 1 ? "{0} worker hidden" : "{0} workers hidden", [hiddenWorkerCount])}</span>
          )}
        </div>
      </div>
      {showOverviewSearch ? (
      <div className="flex flex-wrap gap-2" role="search" aria-label={tr("Filter fleet units")}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr("Search up to 12 units")}
          aria-label={tr("Search units by name")}
          className="min-h-11 min-w-52 flex-1 rounded border border-border bg-surface-elevated px-3 text-sm text-text"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          aria-label={tr("Filter units by status")}
          className="min-h-11 rounded border border-border bg-surface-elevated px-3 text-sm text-text"
        >
          <option value="all">{tr("All status")}</option>
          <option value="online">{tr("Online")}</option>
          <option value="offline">{tr("Offline")}</option>
          <option value="issues">{tr("Issues")}</option>
        </select>
      </div>
      ) : null}
      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdownAll}
        targets={powerTargets}
        action={powerAction}
        title={tr(powerAction === "reboot" ? "Reboot All" : "Shutdown All")}
        description={tr(powerAction === "reboot" ? "Restart all {0} online Spark{1}? Offline nodes will be skipped." : "Gracefully shut down all {0} online Spark{1}? Offline nodes will be skipped.", [powerTargets.length, powerTargets.length === 1 ? "" : "s"])}
        confirmLabel={tr(powerAction === "reboot" ? "Reboot All" : "Shut down all")}
      />
      {showLlmTokenTotals ? <FleetTokenTotals /> : null}
      {benchmarkGroup && <ClusterBenchmarkDialog headId={benchmarkGroup.head.id} members={benchmarkGroup.members} onClose={() => setBenchmarkHeadId(null)} />}
      {clusterSetup && <ClusterSetupDialog sparks={sparks} existingHeadId={clusterSetup.headId} onClose={() => setClusterSetup(null)} />}
      {groups.map((group) => {
        const visibleMembers = group.members.filter((s) => visibleSparks.some((v) => v.id === s.id));
        if (!visibleMembers.length) return null;
        const online = group.members.filter((s) => s.online).length;
        return <section key={group.head.id} aria-label={group.name} className="rounded-2xl border border-accent/30 bg-accent/5 p-4 sm:p-5">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">DGX CLUSTER</p>
              <h2 className="text-lg font-semibold text-text-strong">{group.name}</h2>
              <p className="mt-1 text-xs text-muted">Head · {group.head.name} <span className="mx-2">/</span> {tr("{0} devices", [group.members.length])} · {online}/{group.members.length}{tr(" online")}{visibleMembers.length < group.members.length ? ` · ${tr("{0} hidden by filters", [group.members.length - visibleMembers.length])}` : ""}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs text-text hover:bg-surface-hover" onClick={() => setBenchmarkHeadId(group.head.id)}>{tr("Bandwidth / RDMA test")}</button>
            <button className="rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs text-text hover:bg-surface-hover" onClick={() => setClusterSetup({ headId: group.head.id })}>{tr("Network / Edit cluster")}</button>
            </div>
          </header>
          <div className="overview-page grid sm:grid-cols-2 xl:grid-cols-3" style={{ gap: "var(--density-page-gap)" }}>
            {visibleMembers.map((spark) => <SparkCard key={spark.id} spark={spark} headSparkName={group.head.name} temperatureUnit={temperatureUnit} onSelect={onSelectSpark} />)}
          </div>
        </section>;
      })}
      <div className="overview-page grid sm:grid-cols-2 lg:grid-cols-3" style={{ gap: "var(--density-page-gap)" }}>
        {visibleSparks.length === 0 && (
          <p className="panel p-6 text-sm text-muted sm:col-span-2 lg:col-span-3">{tr("No units match the current search and status filters.")}</p>
        )}
        {visibleSparks.filter((spark) => !groupedIds.has(spark.id)).map((spark) => (
          <SparkCard
            key={spark.id}
            spark={spark}
            headSparkName={
              spark.workerHeadId
                ? sparks.find((s) => s.id === spark.workerHeadId)?.name ?? null
                : null
            }
            temperatureUnit={temperatureUnit}
            onSelect={onSelectSpark}
          />
        ))}
      </div>
    </div>
  );
}
