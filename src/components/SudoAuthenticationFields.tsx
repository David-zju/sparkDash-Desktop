import { useEffect, useRef, useState } from "react";
import { checkPowerAuth, getSudoPasswordStatus, saveSudoPassword, forgetSudoPassword, type PowerAuthStatus } from "../api/client";
import { translate as tr } from "../i18n";

export interface SudoTarget { id: string; name: string }
interface Entry { password: string; status?: PowerAuthStatus; busy: boolean; error?: string }
export function SudoAuthenticationFields({ targets, disabled, onChange, onReady, onTargetsChange }: {
  targets: SudoTarget[]; disabled: boolean;
  onChange: (passwords: Record<string, string>) => void; onReady: (ready: boolean) => void;
  onTargetsChange?: (targets: Record<string, string>) => void;
}) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const generation = useRef(0);
  const key = JSON.stringify(targets.map(t => t.id));
  useEffect(() => {
    generation.current++;
    let active = true;
    setEntries({}); onReady(false); onChange({}); onTargetsChange?.({});
    for (const target of targets) {
      void (async () => {
        let hasPassword = false;
        try {
          hasPassword = (await getSudoPasswordStatus(target.id)).hasPassword;
          if (!active) return;
          const status = await checkPowerAuth(target.id);
          if (active) setEntries(prev => ({ ...prev, [target.id]: { password: "", busy: false, status } }));
        } catch {
          if (active) setEntries(prev => ({ ...prev, [target.id]: { password: "", busy: false,
            status: { status: "password_required", hasPassword }, error: tr("Could not check shutdown authentication; verify the SSH connection") } }));
        }
      })();
    }
    return () => { active = false; generation.current++; };
  // IDs determine the remote targets; cosmetic names must not restart authentication.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    onChange(Object.fromEntries(targets.filter(t => entries[t.id]?.password).map(t => [t.id, entries[t.id].password])));
    onTargetsChange?.(Object.fromEntries(targets.filter(t => entries[t.id]?.status?.target).map(t => [t.id, entries[t.id].status!.target!])));
    onReady(targets.length > 0 && targets.every(t => entries[t.id]?.status?.status === "ready" && entries[t.id]?.status?.target && !entries[t.id]?.busy));
  }, [entries, key, onChange, onReady, onTargetsChange]);

  async function act(id: string, action: "check" | "save" | "forget") {
    const version = generation.current;
    const password = entries[id]?.password;
    setEntries(prev => ({ ...prev, [id]: { ...prev[id], busy: true, error: undefined } }));
    try {
      if (action === "save") await saveSudoPassword(id, password);
      if (version !== generation.current) return;
      if (action === "forget") {
        await forgetSudoPassword(id);
        if (version !== generation.current) return;
        setEntries(prev => ({ ...prev, [id]: { password: "", busy: false, status: { status: "password_required", hasPassword: false } } }));
        return;
      }
      const status = await checkPowerAuth(id, action === "check" ? password || undefined : undefined);
      if (version !== generation.current) return;
      setEntries(prev => ({ ...prev, [id]: { ...prev[id], password: action === "check" ? password : "", status, busy: false } }));
    } catch (error) {
      if (version !== generation.current) return;
      setEntries(prev => ({ ...prev, [id]: { ...prev[id], busy: false, status: prev[id]?.status ? { ...prev[id].status!, status: "password_required" } : undefined, error: error instanceof Error ? tr(error.message) : tr("Sudo authentication failed") } }));
    }
  }
  return <div className="space-y-3" aria-label={tr("Sudo authentication")}>
    <p className="text-xs text-muted">{tr("sudo credentials are only used to shut down or reboot this device from sparkDash, and are separate from the SSH login. A saved password is stored encrypted on this computer and can be forgotten at any time.")}</p>
    {targets.map(target => {
      const entry = entries[target.id];
      const busy = disabled || !entry || entry.busy;
      const passwordSupported = entry?.status?.passwordSupported !== false;
      return <div key={target.id} className="rounded border border-border p-3 space-y-2">
        <div className="text-xs font-medium">{target.name}</div>
        <p className="text-xs text-muted" role="status">{!entry ? tr("Checking authentication…") : entry.error || (entry.status?.status === "ready" ? tr("Sudo authentication ready") : tr(entry.status?.error || "Sudo authentication required"))}</p>
        {passwordSupported && entry?.status?.hasPassword && <div className="flex items-center gap-2 text-xs">
          <span>{tr("Sudo password saved")}</span>
          <button type="button" disabled={busy} onClick={() => void act(target.id, "forget")}>{tr("Forget saved sudo password")}</button>
        </div>}
        {passwordSupported && <label className="block text-xs">{tr("Sudo password for {0}", [target.name])}
          <input type="password" autoComplete="off" disabled={busy} value={entry?.password || ""}
            className="mt-1 w-full rounded border border-border bg-surface-elevated px-2 py-1"
            onChange={event => setEntries(prev => ({ ...prev, [target.id]: { ...prev[target.id], password: event.target.value, status: prev[target.id]?.status ? { ...prev[target.id].status!, status: "password_required" } : undefined, error: undefined } }))} />
        </label>}
        <div className="flex gap-3 text-xs">
          <button type="button" disabled={busy} onClick={() => void act(target.id, "check")}>{tr("Verify permissions")}</button>
          {passwordSupported && <button type="button" disabled={busy || !entry?.password} onClick={() => void act(target.id, "save")}>{tr("Verify and save encrypted")}</button>}
        </div>
      </div>;
    })}
  </div>;
}
