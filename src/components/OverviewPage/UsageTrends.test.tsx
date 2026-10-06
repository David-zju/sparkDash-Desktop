import { act } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { _resetStore, ingestSnapshots } from "../../hooks/metricsStore";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";
import { setLocale } from "../../i18n";
import { UsageTrends, usageSegments } from "./UsageTrends";
import { OverviewPage } from "./OverviewPage";

beforeEach(_resetStore);
afterEach(() => { act(() => setLocale("en")); _resetStore(); });

it("uses elapsed time and a fixed percentage scale at every polling cadence", () => {
  for (const interval of [1_000, 2_000, 5_000]) {
    const [points] = usageSegments([{ at: 60_000 - interval, value: 10 }, { at: 60_000, value: 50 }], 60_000, interval);
    expect(points[0].x).toBeCloseTo(300 - interval / 200);
    expect(points[0].y).toBeCloseTo(49.8); // 10% stays near the floor, not at full height.
    expect(points[1]).toEqual({ x: 300, y: 29 });
  }
});

it("leaves disconnect gaps and discards old or invalid readings", () => {
  const segments = usageSegments([
    { at: 1_000, value: 10 }, { at: 62_000, value: 40 }, { at: 64_000, value: 60 },
    { at: 90_000, value: 0 }, { at: 92_000, value: NaN }, { at: 94_000, value: 10 },
  ], 120_000, 2_000);
  expect(segments.map((s) => s.length)).toEqual([2, 1, 1]);
  expect(segments[1][0].y).toBe(55); // Genuine idle is a zero, not a missing sample.
  expect(usageSegments([{ at: 1_000, value: 99 }], 120_000, 2_000)).toEqual([]);
});

it("updates from real history subscriptions, translates labels, and expires stale readings", () => {
  const spark = makeSpark();
  ingestSnapshots([spark], 100_000);
  const ui = render(<UsageTrends sparkId={spark.id} gpuUsage={42} cpuUsage={25} now={100_000} />);
  expect(ui.container.querySelector('[aria-label="GPU utilization"]')?.textContent).toContain("42%");
  act(() => { spark.metrics.gpu!.usage = 90; ingestSnapshots([spark], 102_000); });
  expect(ui.container.querySelector("path.overview-trend-line")).not.toBeNull();
  act(() => ui.root.render(<UsageTrends sparkId={spark.id} gpuUsage={90} cpuUsage={null} now={102_000} />));
  expect(ui.container.querySelector('[aria-label="CPU utilization"]')?.textContent).toContain("—");
  act(() => setLocale("zh-CN"));
  expect(ui.container.textContent).toContain("最近 60 秒");
  act(() => ui.root.render(<UsageTrends sparkId={spark.id} gpuUsage={90} cpuUsage={null} now={170_000} />));
  expect(ui.container.querySelectorAll("path.overview-trend-line")).toHaveLength(0);
  expect(ui.container.querySelector('[aria-label="GPU 利用率"]')?.textContent).toContain("—");
});

it("keeps CPU telemetry visible without a GPU, and does not invent unknown readings", () => {
  const spark = makeSpark();
  spark.metrics.gpu = null;
  ingestSnapshots([spark], 100_000);
  const ui = render(<OverviewPage sparks={[spark]} now={100_000} />);
  expect(ui.container.querySelector('[aria-label="CPU utilization"]')?.textContent).toContain("25%");
  expect(ui.container.querySelector('[aria-label="GPU utilization"]')?.textContent).toContain("—");
  expect(ui.container.textContent).not.toContain("0°C");
  expect(ui.container.querySelector('[role="meter"][aria-label="Shared memory"]')).toBeNull();
});
