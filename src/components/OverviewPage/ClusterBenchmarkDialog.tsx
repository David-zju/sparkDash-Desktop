import { useEffect, useRef, useState } from "react";
import { cancelFabricBenchmark, discoverClusterNetwork, fetchFabricBenchmark, startFabricBenchmark } from "../../api/client";
import type { FabricBenchmarkJob, FabricDiscovery, SparkSnapshot } from "../../api/types";
import { translate as tr, useLocale } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";

const button = "rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text hover:bg-surface-hover disabled:opacity-40";
const field = "w-full rounded-lg border border-border bg-surface-elevated p-2 text-sm text-text";
const active = (job: FabricBenchmarkJob | null) => job?.status === "running" || job?.status === "cancelling";

export function ClusterBenchmarkDialog({ headId, members, onClose }: { headId: string; members: SparkSnapshot[]; onClose: () => void }) {
  useLocale();
  const [a, setA] = useState(members[0]?.id || "");
  const [b, setB] = useState(members[1]?.id || "");
  const [network, setNetwork] = useState<FabricDiscovery | null>(null);
  const [pathKey, setPathKey] = useState("");
  const [tcp, setTcp] = useState(true);
  const [rdma, setRdma] = useState(true);
  const [job, setJob] = useState<FabricBenchmarkJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const trap = useFocusTrap(true);
  const paths = network?.links.find((link) => link.a === a && link.b === b)?.paths || [];
  const path = paths.find((p) => p.key === pathKey);
  const running = active(job);
  const locked = busy || loading || running;
  const ownJob = job && members.some((m) => m.id === job.a) && members.some((m) => m.id === job.b);

  useEffect(() => {
    alive.current = true;
    void fetchFabricBenchmark().then(({ job: next }) => { if (alive.current) setJob(next); })
      .catch((err) => { if (alive.current) setError(String(err.message)); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!running) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const next = await fetchFabricBenchmark(); if (!disposed) { setJob(next.job); setError(""); } }
      catch (err) { if (!disposed) setError(err instanceof Error ? err.message : String(err)); }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [running]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); }
    catch (err) { if (alive.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (alive.current) setBusy(false); }
  }
  function changePair(side: "a" | "b", value: string) {
    (side === "a" ? setA : setB)(value); setNetwork(null); setPathKey("");
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
    <div ref={trap} role="dialog" aria-modal="true" aria-labelledby="cluster-benchmark-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl">
      <header className="mb-5 flex items-start justify-between gap-3"><h2 id="cluster-benchmark-title" className="text-lg font-semibold text-text-strong">{tr("Bandwidth / RDMA test")}</h2><button className={button} onClick={onClose}>{tr("Close")}</button></header>
      <p className="mb-4 text-sm text-muted">{tr("Select two devices and one network path. Each test runs for 10 seconds in each direction and uses network bandwidth; run it when the cluster is idle.")}</p>
      <div className="grid gap-3 sm:grid-cols-2">{(["a", "b"] as const).map((side) => <label key={side} className="text-xs text-muted">{tr(side === "a" ? "Device A" : "Device B")}<select className={`${field} mt-1`} value={side === "a" ? a : b} disabled={locked} onChange={(e) => changePair(side, e.target.value)}>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>)}</div>
      <button className={`${button} my-3`} disabled={locked || !a || !b || a === b} onClick={() => void action(async () => {
        setNetwork(null); setPathKey("");
        const result = await discoverClusterNetwork([a, b]);
        if (alive.current) { setNetwork(result); setPathKey(result.links[0]?.paths[0]?.key || ""); }
      })}>{tr(busy && !job ? "Checking network…" : "Find network paths")}</button>
      {network && <div className="mb-4 space-y-2">
        {network.nodes.filter((n) => n.error).map((n) => <p key={n.id} className="break-words text-xs text-warning">{n.name}: {n.error}</p>)}
        {paths.length ? <label className="text-xs text-muted">{tr("Network path")}<select className={`${field} mt-1`} value={pathKey} disabled={locked} onChange={(e) => setPathKey(e.target.value)}>{paths.map((p) => <option key={p.key} value={p.key}>{p.aInterface} ({p.aIp}) ↔ {p.bInterface} ({p.bIp})</option>)}</select></label> : <p className="text-sm text-warning">{tr("No directly connected IPv4 subnet found. Check cable, link state and IP configuration on both devices.")}</p>}
      </div>}
      <div className="my-4 flex flex-wrap gap-5 text-sm text-text">
        <label><input type="checkbox" className="mr-2" checked={tcp} disabled={locked} onChange={(e) => setTcp(e.target.checked)} />{tr("TCP bandwidth (iperf3)")}</label>
        <label><input type="checkbox" className="mr-2" checked={rdma} disabled={locked} onChange={(e) => setRdma(e.target.checked)} />{tr("RDMA Write (ib_write_bw)")}</label>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">{tr("Checks tools on both devices first. Missing tools are reported without installation. RDMA uses host memory; this does not test GPU Direct, NCCL or inference performance.")}</p>
      {error && <p role="alert" className="my-3 break-words text-sm text-danger">{tr(error)}</p>}
      <div className="flex flex-wrap gap-3">
        <button className={button} disabled={locked || !path || a === b || (!tcp && !rdma)} onClick={() => void action(async () => {
          if (!path) return;
          const result = await startFabricBenchmark({ headId, a, b, path, kinds: [...(tcp ? ["tcp" as const] : []), ...(rdma ? ["rdma" as const] : [])] });
          if (alive.current) setJob(result.job);
        })}>{tr("Start network test")}</button>
        {running && job && <button className={button} disabled={busy || job.status === "cancelling"} onClick={() => void action(async () => {
          const result = await cancelFabricBenchmark(job.id); if (alive.current) setJob(result.job);
        })}>{tr("Stop network test")}</button>}
      </div>
      {running && <p role="status" className="mt-4 text-sm text-accent">{tr(job!.phase)}</p>}
      {running && !ownJob && <p className="mt-2 text-xs text-warning">{tr("A network test is running in another cluster.")}</p>}
      {running && <p className="mt-2 text-xs text-muted">{tr("You can close this window and return to the results. If SSH disconnects, remote test processes stop within 40 seconds.")}</p>}
      {job && ownJob && <section className="mt-5 space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-text-strong">{job.names.join(" ↔ ")} · {tr(job.status)}</h3>
        <p className="text-xs text-muted">{new Date(job.startedAt).toLocaleString()} · {tr("Results are kept until the next test or backend restart.")}</p>
        {job.path && <p className="break-words font-mono text-xs text-muted">{job.path.aInterface} ({job.path.aIp}) ↔ {job.path.bInterface} ({job.path.bIp})</p>}
        {job.error && <p className="break-words text-sm text-warning">{tr(job.error)}</p>}
        {job.results.map((r, i) => <div key={i} className="rounded-xl border border-border bg-surface-elevated p-3">
          <div className="flex flex-wrap justify-between gap-2 text-sm text-text"><span>{r.kind === "tcp" ? "TCP" : "RDMA Write"} · {r.direction === "forward" ? `${job.names[0]} → ${job.names[1]}` : r.direction === "reverse" ? `${job.names[1]} → ${job.names[0]}` : tr("Both directions")}</span><strong>{r.gbps !== null ? `${r.gbps.toFixed(2)} Gb/s` : tr(r.status)}</strong></div>
          {r.error && <p className="mt-2 break-words text-xs text-warning">{tr(r.error)}</p>}
          {r.logs.length > 0 && <details className="mt-2 text-xs text-muted"><summary className="cursor-pointer">{tr("Test output")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{r.logs.map((l) => `${l.side}\n${l.stdout}\n${l.stderr}`).join("\n")}</pre></details>}
        </div>)}
        {job.checks.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">{tr("Tools and RDMA devices")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(job.checks, null, 2)}</pre></details>}
        <p className="text-xs text-muted">{tr("TCP: receiver throughput, 4 streams. RDMA: average Write bandwidth, 64 KiB messages. Results measure this path, not the sum of all cluster links.")}</p>
      </section>}
    </div>
  </div>;
}
