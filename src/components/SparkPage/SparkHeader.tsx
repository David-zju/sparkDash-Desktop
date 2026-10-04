import { translate as tr, useLocale } from "../../i18n";
import type { SparkSnapshot } from "../../api/types";
import { resolveSparkRole } from "../../api/sparkRole";
import { SparkActions } from "./SparkActions";

interface SparkHeaderProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return "<1m";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

export function SparkHeader({ spark, onEdit }: SparkHeaderProps) {
  useLocale();
  const { hardware } = spark;
  const online = spark.online;
  const hermes = spark.hermes;

  return (
    <div
      className="spark-header panel flex flex-wrap items-center gap-x-4 gap-y-2"
      style={{ padding: "var(--density-panel-pad)", ...(online ? {} : { opacity: 0.6 }) }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
          title={online ? tr("Online") : tr("Offline")}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-text-strong">{spark.name}</h2>
            {(() => {
              const role = resolveSparkRole(spark);
              const text =
                role === "head" ? tr("Head") : role === "worker" ? tr("Worker") : tr("Standalone");
              const title =
                role === "head"
                  ? tr("Cluster head — local LLM API")
                  : role === "worker"
                    ? tr("Distributed LLM worker — no local model; LLM card is hidden")
                    : spark.llmMonitoring === false
                      ? tr("Standalone — LLM monitoring off")
                      : tr("Standalone — local LLM API");
              // Manual override first, then derived head-model mirror.
              const workerLabel =
                role === "worker"
                  ? spark.workerLabel?.trim() || spark.workerDerivedLabel?.trim() || null
                  : null;
              return (
                <>
                  <span
                    className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                    title={title}
                  >
                    {text}
                  </span>
                  {workerLabel && (
                    <span
                      className="max-w-[14rem] truncate rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                      title={workerLabel}
                    >
                      {workerLabel}
                    </span>
                  )}
                </>
              );
            })()}
            {online && spark.uptime != null && (
              <span
                className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-tabular text-[10px] font-medium text-accent"
                title={tr("Uptime: {0}", [formatUptime(spark.uptime)])}
              >
                {formatUptime(spark.uptime)}
              </span>
            )}
            {hermes?.monitoring && hermes.installed && hermes.version && (
              <span
                className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 font-tabular text-[10px] font-medium text-accent"
                title={tr("Hermes Agent {0} installed on this machine", [hermes.version])}
              >
                Hermes
              </span>
            )}
            {hermes?.monitoring && hermes.installed === false && hermes.checkedAt != null && (
              <span
                className="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                title={tr("The `hermes` binary was not found on this machine (check the install path or Edit Spark).")}
              >{tr("Hermes not found")}</span>
            )}
            {hermes?.monitoring &&
              hermes.error &&
              hermes.status === "idle" && (
                <span
                  className="max-w-[16rem] shrink-0 truncate rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                  title={tr("Update check failed — it will retry automatically: {0}", [hermes.error])}
                >{tr("Update check failed")}</span>
              )}
          </div>
          <p className="truncate text-xs text-muted">
            {hardware.gpuChip
              ? `${hardware.device} · ${hardware.gpuChip}`
              : hardware.device}
          </p>
        </div>
      </div>

      {/* Desktop action cluster (hidden on mobile; mobile renders its own row above Resources) */}
      <SparkActions
        spark={spark}
        onEdit={onEdit}
        className="ml-auto hidden flex-wrap items-center justify-end gap-2 sm:flex"
      />
    </div>
  );
}
