import { useTimedMetricsHistory, type MetricSample } from "../../hooks/metricsStore";
import { translate as tr, useLocale } from "../../i18n";

const WINDOW_MS = 60_000;
const WIDTH = 300;
const HEIGHT = 58;
const TOP = 3;
const BASE = HEIGHT - TOP;

/** Fixed time and percentage scales. Missing samples leave gaps, never fake zeros. */
export function usageSegments(samples: readonly MetricSample[], endAt: number, pollIntervalMs: number) {
  const startAt = endAt - WINDOW_MS;
  let first = samples.length;
  while (first > 0 && samples[first - 1].at >= startAt) first--;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  let previousAt: number | undefined;
  for (let i = first; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.at > endAt) break;
    if (!Number.isFinite(sample.value)) {
      segment = [];
      previousAt = undefined;
      continue;
    }
    if (previousAt == null || sample.at - previousAt > Math.max(5_000, pollIntervalMs * 2.5)) {
      segment = [];
    }
    if (!segment.length) segments.push(segment);
    segment.push({
      x: ((sample.at - startAt) / WINDOW_MS) * WIDTH,
      y: BASE - Math.max(0, Math.min(100, sample.value)) / 100 * (BASE - TOP),
    });
    previousAt = sample.at;
  }
  return segments;
}

function TrendRow({ label, samples, value, endAt, pollIntervalMs }: {
  label: string;
  samples: readonly MetricSample[];
  value: number | null;
  endAt: number;
  pollIntervalMs: number;
}) {
  const segments = usageSegments(samples, endAt, pollIntervalMs);
  const latest = samples.at(-1);
  const fresh = latest && endAt - latest.at <= Math.max(10_000, pollIntervalMs * 3);
  const shown = value != null && Number.isFinite(value) && fresh ? Math.round(Math.max(0, Math.min(100, value))) : null;
  const reading = shown == null ? "—" : `${shown}%`;
  return <section className="overview-trend-row" aria-label={label}>
    <div className="overview-trend-heading">
      <span>{label}</span>
      <span className="overview-trend-value font-tabular">{shown ?? "—"}{shown != null && <small>%</small>}</span>
    </div>
    <div className="overview-trend-plot">
      <div className="overview-trend-scale font-tabular" aria-hidden="true"><span>100</span><span>0</span></div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img"
        aria-label={tr("{0} over the last 60 seconds; current {1}", [label, reading])}>
        <title>{tr("{0} over the last 60 seconds; current {1}", [label, reading])}</title>
        {[TOP, HEIGHT / 2, BASE].map((y) => <line key={y} x1="0" y1={y} x2={WIDTH} y2={y} className="overview-trend-grid" vectorEffect="non-scaling-stroke" />)}
        {segments.map((points, index) => {
          const line = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
          return <g key={index}>
            {points.length > 1 && <>
              <path d={`${line} L${points.at(-1)!.x},${BASE} L${points[0].x},${BASE} Z`} className="overview-trend-area" />
              <path d={line} className="overview-trend-line" vectorEffect="non-scaling-stroke" />
            </>}
            {points.length === 1 && <line x1={points[0].x} x2={points[0].x} y1={points[0].y} y2={points[0].y} className="overview-trend-line" vectorEffect="non-scaling-stroke" />}
          </g>;
        })}
      </svg>
      {!segments.length && <span className="overview-trend-empty">{tr(value == null ? "Metrics unavailable" : "Collecting history…")}</span>}
    </div>
  </section>;
}

export function UsageTrends({ sparkId, gpuUsage, cpuUsage, now, pollIntervalMs = 2_000 }: {
  sparkId: string;
  gpuUsage: number | null;
  cpuUsage: number | null;
  now: number;
  pollIntervalMs?: number;
}) {
  useLocale();
  const gpu = useTimedMetricsHistory(sparkId, "gpu.usage");
  const cpu = useTimedMetricsHistory(sparkId, "cpu.usage");
  const endAt = Math.max(now, gpu.at(-1)?.at ?? 0, cpu.at(-1)?.at ?? 0);
  return <div className="overview-trends">
    <div className="overview-trend-caption"><span>{tr("Last 60 seconds · utilization")}</span><span>0–100%</span></div>
    <TrendRow label={tr("GPU utilization")} samples={gpu} value={gpuUsage} endAt={endAt} pollIntervalMs={pollIntervalMs} />
    <TrendRow label={tr("CPU utilization")} samples={cpu} value={cpuUsage} endAt={endAt} pollIntervalMs={pollIntervalMs} />
    <div className="overview-trend-axis"><span>{tr("60s ago")}</span><span>{tr("30s ago")}</span><span>{tr("Now")}</span></div>
  </div>;
}
