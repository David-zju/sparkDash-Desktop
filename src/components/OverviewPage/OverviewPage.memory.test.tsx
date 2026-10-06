import { expect, it, vi } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { render } from "../../testing/render";
import type { SparkSnapshot, GpuMetrics } from "../../api/types";
import { GpuPanel } from "../SparkPage/GpuPanel";

vi.mock("../../hooks/metricsStore", () => ({ useMetricsHistoryTail: () => [], useTimedMetricsHistory: () => [] }));
const gpu: GpuMetrics = {
  usage: 0, temperature: 40, power: { draw: 4, limit: 120 },
  vram: { used: 1024, total: 131072, available: 126976, percentage: 1 },
};
const spark = {
  id: "fixture", name: "Fixture", kind: "spark", online: true, role: "standalone",
  metrics: { gpu, cpu: null, storage: [], network: [], llm: [],
    unifiedMemory: { used: 4096, total: 131072, available: 126976, percentage: 3 } },
} as unknown as SparkSnapshot;

it("uses system-wide shared memory for Spark, and discrete VRAM for GPU hosts", () => {
  const shared = render(<OverviewPage sparks={[spark]} />);
  expect(shared.container.textContent).toContain("Shared memory4 / 128 GB");
  const discrete = render(<OverviewPage sparks={[{ ...spark, kind: "host" }]} />);
  expect(discrete.container.textContent).toContain("VRAM1 / 128 GB");
  const unknown = render(<OverviewPage sparks={[{ ...spark, metrics: { ...spark.metrics, unifiedMemory: null } }]} />);
  expect(unknown.container.textContent).toContain("Shared memory—");
});

it("labels GPU attribution separately from the shared pool capacity", () => {
  const shared = render(<GpuPanel gpu={gpu} sparkId="fixture" sharedMemory temperatureUnit="celsius" />);
  expect(shared.container.textContent).toContain("GPU-attributed memory (estimate)");
  expect(shared.container.textContent).toContain("Shared pool available");
  expect(shared.container.textContent).not.toContain("VRAM");
  const discrete = render(<GpuPanel gpu={gpu} sparkId="fixture" temperatureUnit="celsius" />);
  expect(discrete.container.textContent).toContain("VRAM");
  expect(discrete.container.textContent).not.toContain("LPDDR5X");
});

it("preserves an explicitly reported zero available capacity", () => {
  const ui = render(<OverviewPage sparks={[{ ...spark, metrics: { ...spark.metrics,
    unifiedMemory: { ...spark.metrics.unifiedMemory!, available: 0 },
  } }]} />);
  expect(ui.container.textContent).toContain("Available 0 MB");
});
