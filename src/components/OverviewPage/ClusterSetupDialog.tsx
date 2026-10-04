import { useEffect, useRef, useState } from "react";
import { discoverClusterNetwork, dissolveCluster, saveCluster } from "../../api/client";
import type { FabricDiscovery, FabricLink, SparkSnapshot } from "../../api/types";
import { translate as tr, useLocale } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { clusterGroups, fabricCandidates, hasVerifiedFabric } from "./clusters";

const button = "rounded-lg border border-border bg-surface-elevated px-4 py-2 text-sm text-text transition hover:bg-surface-hover disabled:opacity-40";
const primary = "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40";
const field = "w-full rounded-lg border border-border bg-surface-elevated px-3 py-2.5 text-sm text-text outline-none focus:border-accent";

export function fabricLinkLabel(link: FabricLink) {
  if (link.verified200G) return tr("200G · bidirectional IP verified");
  if (link.status === "connected") return tr("IP reachable · 200G unverified");
  if (link.status === "partial") return tr("One-way reachability only");
  if (link.status === "unreachable") return tr("IP probe failed");
  return tr("Not verified");
}

function NetworkResults({ result, ids }: { result: FabricDiscovery; ids: string[] }) {
  const name = (id: string) => result.nodes.find((n) => n.id === id)?.name || id;
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {result.nodes.filter((n) => ids.includes(n.id)).map((node) => (
          <div key={node.id} className="rounded-xl border border-border bg-surface-elevated p-3">
            <p className="mb-2 text-sm font-semibold text-text-strong">{node.name}</p>
            {node.error ? <p className="break-words text-xs text-warning">{node.error}</p> : node.interfaces.length === 0 ? (
              <p className="text-xs text-muted">{tr("No ConnectX interface detected. Check the cable and NIC visibility.")}</p>
            ) : node.interfaces.map((nic) => (
              <div key={nic.name} className="mt-2 text-xs">
                <div className="flex flex-wrap justify-between gap-1">
                  <span className="font-mono text-text">{nic.name}</span>
                  <span className={nic.carrier ? "text-success" : "text-warning"}>
                    {nic.carrier ? tr("Link up") : tr("Link down")} · {nic.speedMbps ? `${nic.speedMbps / 1000} Gb/s` : tr("Speed unknown")}
                  </span>
                </div>
                <p className="mt-1 break-words font-mono text-muted">{nic.addresses.map((a) => `${a.address}/${a.prefix}`).join(", ") || tr("No IPv4 address")}</p>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="divide-y divide-border rounded-xl border border-border">
        {result.links.filter((l) => ids.includes(l.a) && ids.includes(l.b)).map((link) => (
          <details key={`${link.a}:${link.b}`} className="p-3">
            <summary className="cursor-pointer text-xs text-text">
              <span className="font-medium">{name(link.a)} ↔ {name(link.b)}</span>
              <span className={`ml-3 inline-block ${link.verified200G ? "text-success" : "text-warning"}`}>{fabricLinkLabel(link)}</span>
            </summary>
            <div className="mt-3 space-y-2 text-xs text-muted">
              {link.paths.length === 0 && <p>{tr("No directly connected IPv4 subnet found. Check cable, link state and IP configuration on both devices.")}</p>}
              {link.paths.map((path) => <div key={path.key} className="break-words rounded bg-surface-elevated p-2 font-mono">
                <p>{path.aInterface} ({path.aIp}) ↔ {path.bInterface} ({path.bIp})</p>
                <p className="mt-1">→ {tr(path.forwardReason)} · ← {tr(path.reverseReason)} · {path.speedMbps ? `${path.speedMbps / 1000} Gb/s` : tr("Speed unknown")}</p>
              </div>)}
              <p>{tr("Failed ping may also mean ICMP is blocked. RDMA and throughput are not tested.")}</p>
            </div>
          </details>
        ))}
      </div>
      <p className="text-xs text-muted">{tr("Checked at {0}. Link speed is negotiated speed, not measured throughput.", [new Date(result.checkedAt).toLocaleTimeString()])}</p>
    </div>
  );
}

/** Mounted once per setup session so drafts and late results cannot leak across opens. */
export function ClusterSetupDialog({ sparks, existingHeadId, onClose }: {
  sparks: SparkSnapshot[]; existingHeadId?: string; onClose: () => void;
}) {
  useLocale();
  const groups = clusterGroups(sparks);
  const existing = groups.find((g) => g.head.id === existingHeadId);
  const elsewhere = new Set(groups.filter((g) => g.head.id !== existingHeadId).flatMap((g) => g.members.map((m) => m.id)));
  const devices = sparks.filter((s) => s.kind !== "host");
  const [ids, setIds] = useState(() => existing?.members.map((m) => m.id) || devices.filter((s) => !elsewhere.has(s.id)).slice(0, 12).map((s) => s.id));
  const [headId, setHeadId] = useState(existing?.head.id || "");
  const [name, setName] = useState(existing?.name || "");
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<FabricDiscovery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [acceptUnverified, setAcceptUnverified] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const alive = useRef(true);
  const started = useRef(false);
  const trap = useFocusTrap(true);
  const verified = hasVerifiedFabric(result, ids);
  const members = devices.filter((s) => ids.includes(s.id));
  const head = members.find((s) => s.id === headId);
  const validMembers = members.length >= 2 && members.length <= 12 && members.length === ids.length;

  async function scan() {
    setScanning(true); setError(""); setResult(null); setAcceptUnverified(false);
    try {
      const next = await discoverClusterNetwork(ids);
      if (alive.current) setResult(next);
    } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (alive.current) setScanning(false); }
  }
  useEffect(() => {
    alive.current = true;
    if (!started.current) { started.current = true; if (ids.length >= 2) void scan(); }
    return () => { alive.current = false; };
    // The initial scan belongs to this dialog session, not live metric updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose, saving]);

  function selectMembers(next: string[]) {
    setIds(next); setAcceptUnverified(false);
    if (!next.includes(headId)) setHeadId("");
    if (result && next.some((id) => !result.nodes.some((n) => n.id === id))) setResult(null);
  }
  async function submit() {
    setSaving(true); setError("");
    try {
      if (dissolving && existingHeadId) await dissolveCluster(existingHeadId);
      else await saveCluster({ name: name.trim(), headId, memberIds: ids, previousHeadId: existingHeadId || null });
      if (alive.current) onClose();
    } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (alive.current) setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div ref={trap} role="dialog" aria-modal="true" aria-labelledby="cluster-setup-title" className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">DGX CLUSTER</p>
            <h2 id="cluster-setup-title" className="text-xl font-semibold text-text-strong">{tr(existing ? "Manage cluster" : "Create a cluster")}</h2>
            <p className="mt-1 text-xs text-muted">{tr("Discover the fabric, choose the roles, keep your devices together.")}</p>
          </div>
          <button className={button} onClick={onClose} disabled={saving} aria-label={tr("Close cluster setup")}>✕</button>
        </header>
        <ol className="grid grid-cols-3 gap-2 border-b border-border px-6 py-4">
          {["Check network", "Assign roles", "Review cluster"].map((label, i) => <li key={label} aria-current={step === i ? "step" : undefined} className={`flex items-center gap-2 text-xs ${step === i ? "font-semibold text-accent" : "text-muted"}`}>
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${step === i ? "bg-accent/15" : "bg-surface-elevated"}`}>{i + 1}</span>{tr(label)}
          </li>)}
        </ol>
        <div className="space-y-5 overflow-y-auto px-6 py-5" aria-busy={scanning || saving}>
          {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{tr(error)}</p>}
          {dissolving ? <div className="space-y-3 text-sm text-text">
            <h3 className="text-lg font-semibold">{tr("Dissolve {0}?", [existing?.name])}</h3>
            <p>{tr("Members will return to Standalone monitoring. Running services and network settings stay as they are.")}</p>
          </div> : step === 0 ? <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="text-sm font-semibold text-text-strong">{tr("Select DGX devices")}</h3><p className="mt-1 text-xs text-muted">{tr("Select 2–12 devices. Existing clusters can be edited from their card.")}</p></div>
              <button className={primary} onClick={() => void scan()} disabled={scanning || !validMembers}>{tr(scanning ? "Checking network…" : "Detect 200G network")}</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {devices.map((s) => <label key={s.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${ids.includes(s.id) ? "border-accent/50 bg-accent/10 text-text" : "border-border text-muted"}`}>
                <input type="checkbox" checked={ids.includes(s.id)} disabled={scanning || elsewhere.has(s.id) || (!ids.includes(s.id) && ids.length >= 12)} onChange={() => selectMembers(ids.includes(s.id) ? ids.filter((id) => id !== s.id) : [...ids, s.id])} />
                {s.name}{elsewhere.has(s.id) ? ` · ${tr("Already grouped")}` : ""}
              </label>)}
            </div>
            <p className="text-xs leading-relaxed text-muted">{tr("Reads ConnectX link state and negotiated speed, then tests both directions over directly connected IPv4 fabric interfaces. Uses saved SSH access; no network settings are changed.")}</p>
            {scanning && <div role="status" className="rounded-xl border border-accent/20 bg-accent/5 p-6 text-center text-sm text-accent"><span className="mr-2 inline-block h-3 w-3 animate-pulse rounded-full bg-accent" />{tr("Reading interfaces and checking device pairs. This may take up to two minutes.")}</div>}
            {result && <>
              {fabricCandidates(result).length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent/10 p-3">
                <span className="text-xs font-medium text-accent">{tr("Detected groups")}</span>
                {fabricCandidates(result).map((candidate) => <button key={candidate.join(":")} className={button} onClick={() => selectMembers(candidate)}>{candidate.map((id) => devices.find((s) => s.id === id)?.name || id).join(" + ")}</button>)}
              </div>}
              <NetworkResults result={result} ids={ids} />
            </>}
            <a className="inline-block text-xs text-accent hover:underline" href="https://docs.nvidia.com/dgx/dgx-spark/spark-clustering.html" target="_blank" rel="noreferrer">{tr("NVIDIA network setup guide")} ↗</a>
          </> : step === 1 ? <>
            <label className="block space-y-2 text-xs font-medium text-text">{tr("Cluster name")}<input aria-label={tr("Cluster name")} className={field} value={name} maxLength={80} placeholder={tr("e.g. Qwen lab cluster")} onChange={(e) => setName(e.target.value)} /></label>
            <div><h3 className="mb-2 text-sm font-semibold text-text-strong">{tr("Choose the Head")}</h3><p className="mb-3 text-xs leading-relaxed text-muted">{tr("Choose the device hosting the model API. It can also participate in inference. The remaining members become Workers and keep hardware monitoring.")}</p>
              <div className="grid gap-3 sm:grid-cols-2">{members.map((s) => <label key={s.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 ${headId === s.id ? "border-accent bg-accent/10" : "border-border bg-surface-elevated"}`}>
                <input type="radio" name="cluster-head" value={s.id} checked={headId === s.id} onChange={() => setHeadId(s.id)} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-text-strong">{s.name}</span><span className="text-xs text-muted">{s.lanIp || s.id}</span></span>
                <span className="text-xs font-medium text-accent">{headId === s.id ? "Head" : headId ? "Worker" : tr("Select")}</span>
              </label>)}</div>
            </div>
            <div className="rounded-xl border border-border bg-surface-elevated p-4 text-xs leading-relaxed text-muted">{tr("For TP2 across two single-GPU Sparks: choose one Head and one Worker. For TP3 across three: one Head and two Workers. Configure TP in your inference engine; this wizard saves monitoring roles only.")}</div>
          </> : <>
            <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
              <p className="text-xs uppercase tracking-widest text-accent">CLUSTER · {tr("{0} devices", [members.length])}</p>
              <h3 className="mt-2 text-xl font-semibold text-text-strong">{name}</h3>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">{[head, ...members.filter((s) => s.id !== headId)].filter((s): s is SparkSnapshot => !!s).map((s) => <div key={s.id} className="flex justify-between rounded-lg border border-border bg-surface-elevated px-3 py-3 text-sm text-text"><span>{s.name}</span><span className="text-accent">{s.id === headId ? "Head" : "Worker"}</span></div>)}</div>
              <p className={`mt-4 text-xs ${verified ? "text-success" : "text-warning"}`}>{tr(verified ? "All selected pairs have bidirectional IP connectivity on 200G links." : "Some selected pairs do not have verified 200G connectivity.")}</p>
            </div>
            {existing && existing.members.some((s) => !ids.includes(s.id)) && <p className="text-xs text-warning">{tr("Removed members return to Standalone: {0}", [existing.members.filter((s) => !ids.includes(s.id)).map((s) => s.name).join(", ")])}</p>}
            <p className="text-xs leading-relaxed text-muted">{tr("The Head monitors its configured LLM API ports. Workers stop probing their local LLM APIs. Deploy the model and configure TP separately in your inference engine.")}</p>
            {!verified && <label className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning"><input type="checkbox" checked={acceptUnverified} onChange={(e) => setAcceptUnverified(e.target.checked)} />{tr("Save this monitoring group with unverified network links. I can check the network again later.")}</label>}
          </>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
          <div>{existing && !dissolving && <button className="text-xs text-muted hover:text-danger disabled:opacity-40" disabled={scanning || saving} onClick={() => { setDissolving(true); setError(""); }}>{tr("Dissolve cluster")}</button>}</div>
          <div className="flex gap-2">
            {dissolving ? <><button className={button} disabled={saving} onClick={() => setDissolving(false)}>{tr("Back")}</button><button className={primary} disabled={saving} onClick={() => void submit()}>{tr(saving ? "Saving…" : "Dissolve cluster")}</button></> : <>
              {step > 0 && <button className={button} disabled={saving} onClick={() => { setStep(step - 1); setError(""); }}>{tr("Back")}</button>}
              {step < 2 ? <button className={primary} disabled={scanning || !validMembers || (step === 1 && (!head || !name.trim()))} onClick={() => { setStep(step + 1); setError(""); }}>{tr(step === 0 ? "Assign roles" : "Review cluster")}</button> : <button className={primary} disabled={saving || !validMembers || !head || !name.trim() || (!verified && !acceptUnverified)} onClick={() => void submit()}>{tr(saving ? "Saving…" : "Save cluster")}</button>}
            </>}
          </div>
        </footer>
      </div>
    </div>
  );
}
