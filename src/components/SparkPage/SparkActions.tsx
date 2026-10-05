import { translate as tr, useLocale } from "../../i18n";
import { useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { shutdownSpark, rebootSpark, wakeSpark } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { openHermesUpdateDialog } from "../../hooks/useHermesUpdateDialog";
import { EditIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

interface SparkActionsProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
  /** Classes for the button-cluster wrapper (controls responsive visibility). */
  className?: string;
}

/**
 * Update Hermes / Shutdown·Wake / Edit action cluster.
 * Rendered twice: inline in the SparkHeader (desktop) and as a standalone row
 * just above "Resources" on mobile. Owning the shutdown dialog + transient
 * power message here keeps the two placements in sync.
 */
export function SparkActions({ spark, onEdit, className }: SparkActionsProps) {
  useLocale();
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [powerAction, setPowerAction] = useState<"shutdown" | "reboot">("shutdown");
  const [sudoOpen, setSudoOpen] = useState(false);

  const hermes = spark.hermes;
  const hermesRunning = hermes?.status === "running";

  function handleHermesUpdate() {
    openHermesUpdateDialog({
      sparkId: spark.id,
      sparkName: spark.name,
      currentVersion: hermes?.version ?? null,
    });
  }

  async function handleShutdown(sudoPasswords: Record<string, string>, targets: Record<string, string>) {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await (powerAction === "reboot" ? rebootSpark : shutdownSpark)(spark.id, sudoPasswords, targets);
      setPowerMsg({ text: tr(res.message || "Shutdown requested"), tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : tr("Shutdown failed"),
        tone: "err",
      });
      throw err;
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setPowerMsg({ text: res.message || tr("Wake packet sent"), tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : tr("Wake failed"),
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  return (
    <>
      <div className={className}>
        {powerMsg && (
          <span className={`text-[11px] ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text}
          </span>
        )}
        {hermesRunning && (
          <span
            className="flex items-center gap-1.5 text-[11px] text-warning"
            title={tr("Running `hermes update` on this machine via SSH — this can take a few minutes.")}
          >
            <RotateIcon className="h-3 w-3" />{tr("Hermes updating…")}</span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.status === "error" && (
          <span
            className="max-w-[16rem] truncate text-[11px] text-danger"
            title={hermes.error || tr("Hermes update failed")}
          >{tr("Hermes update failed")}</span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.installed !== false && (
          <button
            type="button"
            onClick={() => void handleHermesUpdate()}
            disabled={powerLoading}
            title={
              hermes.updateAvailable === true
                ? tr("Run \"hermes update\" on this machine via SSH{0}", [hermes.behindCommits ? tr(" ({0} commits behind)", [hermes.behindCommits]) : ""])
                : tr("Open Hermes Agent update status and run updates on this machine via SSH")
            }
            className={`flex items-center gap-1.5 rounded-md border bg-surface-elevated px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
              hermes.updateAvailable === true
                ? "border-warning/40 text-warning hover:bg-warning/15"
                : "border-border text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <RotateIcon className="h-3 w-3" />{tr("Update Hermes")}{hermes.updateAvailable === true && (
              <span
                className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white"
                title={
                  hermes.behindCommits != null
                    ? tr("{0} commit{1} behind", [hermes.behindCommits, hermes.behindCommits === 1 ? "" : "s"])
                    : tr("Update available")
                }
              >
                {hermes.behindCommits != null ? hermes.behindCommits : "!"}
              </span>
            )}
          </button>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => { setPowerAction("shutdown"); setShutdownOpen(true); }}
            disabled={powerLoading}
            title={tr("Shut down using the system power command")}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
          >
            <PowerOffIcon className="h-3 w-3" />{tr("Shutdown")}</button>
        ) : (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title={tr("Wake-on-LAN (set MAC address in Edit Spark)")}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
          >
            <PowerOnIcon className="h-3 w-3" />{tr("Wake")}</button>
        )}
        {online && (
          <button
            type="button"
            onClick={() => { setPowerAction("reboot"); setShutdownOpen(true); }}
            disabled={powerLoading}
            title={tr("Reboot using the system power command")}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-warning/20 hover:text-warning disabled:opacity-50"
          >
            <RotateIcon className="h-3 w-3" />{tr("Reboot")}</button>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-text transition-colors"
          >
            <EditIcon className="h-3 w-3" />{tr("Edit")}</button>
        )}
        {/* Local hosts only support passwordless sudo, so there is nothing to save. */}
        {!spark.isLocal && (
          <button
            type="button"
            onClick={() => setSudoOpen(true)}
            className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-text transition-colors"
          >{tr("Sudo authentication")}</button>
        )}
      </div>
      <ConfirmShutdownDialog open={sudoOpen} onClose={() => setSudoOpen(false)} onConfirm={() => {}}
        manageCredentials targets={[{ id: spark.id, name: spark.name }]} title={tr("Sudo authentication")}
        description={tr("Manage sudo credentials for {0}. This does not shut down the device.", [spark.name])} />
      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        targets={[{ id: spark.id, name: spark.name }]}
        action={powerAction}
        title={tr(powerAction === "reboot" ? "Reboot {0}" : "Shut down {0}", [spark.name])}
        description={tr(powerAction === "reboot" ? "Restart {0}? Running work will be interrupted." : "Gracefully shut down {0}? This will stop all containers and power off the node.", [spark.name])}
        confirmLabel={tr(powerAction === "reboot" ? "Reboot" : "Shut down")}
      />
    </>
  );
}
