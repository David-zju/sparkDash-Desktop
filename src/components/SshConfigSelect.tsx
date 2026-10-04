import { translate as tr, useLocale } from "../i18n";
import { useEffect, useState } from "react";
import { fetchSparks } from "../api/client";

export function SshConfigSelect({ value, disabled, open, onSelect }: {
  value: string;
  disabled: boolean;
  open: boolean;
  onSelect: (alias: string) => void;
}) {
  useLocale();
  const [aliases, setAliases] = useState<string[]>([]);
  const [addedHosts, setAddedHosts] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMessage("");
    Promise.all([
      Promise.resolve().then(() => window.sparkDesktop!.listSshAliases()),
      fetchSparks(),
    ]).then(([result, { sparks }]) => {
      if (cancelled) return;
      setAliases(result.aliases);
      setAddedHosts(new Set(sparks.filter((spark) => !spark.isLocal)
        .map((spark) => (spark.ssh?.host || spark.lanIp).trim().toLowerCase())));
      setMessage(result.warnings.join(" ") || (result.aliases.length ? "" : tr("No named hosts found. Add a Host entry to ~/.ssh/config, or enter the address manually.")));
    }).catch(() => {
      if (!cancelled) { setAliases([]); setAddedHosts(new Set()); setMessage(tr("Could not load SSH aliases or existing devices. You can still enter the connection manually.")); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision, open]);

  const isAdded = (alias: string) => addedHosts.has(alias.trim().toLowerCase());
  const options = value && !aliases.includes(value) ? [value, ...aliases] : aliases;

  return <div className="rounded border border-border bg-surface-elevated p-3 space-y-2">
    <div className="flex items-center justify-between gap-2">
      <label htmlFor="ssh-config-alias" className="text-xs font-medium text-text">{tr("Import from local SSH config")}</label>
      <button type="button" disabled={disabled || loading} onClick={() => setRevision((n) => n + 1)}
        className="text-xs text-accent disabled:opacity-50">{tr("Refresh aliases")}</button>
    </div>
    <select id="ssh-config-alias" value={value} disabled={disabled || loading}
      onChange={(event) => { if (!isAdded(event.target.value)) onSelect(event.target.value); }}
      className="w-full rounded border border-border bg-surface px-3 py-1.5 text-xs text-text">
      <option value="">{loading ? tr("Reading SSH config…") : tr("Enter connection manually")}</option>
      {options.map((alias) => <option key={alias} value={alias} disabled={isAdded(alias)}>
        {isAdded(alias) ? tr("{0} (Already added)", [alias]) : alias}
      </option>)}
    </select>
    <p className="text-[10px] text-muted">{tr("Choose a saved SSH alias. Username, port, keys and jump hosts follow your Mac’s SSH config unless overridden below.")}</p>
    {message && <p role="status" className="text-[10px] text-warning">{message}</p>}
  </div>;
}
