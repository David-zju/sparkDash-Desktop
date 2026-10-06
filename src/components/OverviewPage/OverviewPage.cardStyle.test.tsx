import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverviewPage } from "./OverviewPage";
import { _resetStore, getMetricHistorySamples, ingestSnapshots } from "../../hooks/metricsStore";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

const preferenceKey = "sparkdash-overview-card-style";
beforeEach(() => { localStorage.removeItem(preferenceKey); _resetStore(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(preferenceKey); _resetStore(); });

function choose(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('.overview-view-switch button'))
    .find((button) => button.textContent === label)!;
  act(() => button.click());
  expect(button.getAttribute("aria-pressed")).toBe("true");
}

it("switches cluster and standalone cards together, remembers the choice, and keeps history", () => {
  const head = { ...makeSpark("head"), role: "head" as const, clusterName: "Pair" };
  const worker = { ...makeSpark("worker"), role: "worker" as const, workerNode: true, workerHeadId: head.id };
  const sparks = [head, worker, makeSpark("standalone")];
  ingestSnapshots(sparks, 100_000);
  ingestSnapshots(sparks, 102_000);
  const ui = render(<OverviewPage sparks={sparks} now={102_000} />);
  expect(ui.container.querySelectorAll('.overview-trends')).toHaveLength(3);
  choose(ui.container, "Sectioned cards");
  expect(ui.container.querySelectorAll('.overview-sectioned-usage')).toHaveLength(3);
  expect(ui.container.querySelector('.overview-trends')).toBeNull();
  expect(localStorage.getItem(preferenceKey)).toBe("sections");
  choose(ui.container, "Compact rows");
  expect(ui.container.querySelectorAll('.overview-compact-usage')).toHaveLength(3);
  expect(ui.container.querySelectorAll('.overview-compact-temperature')).toHaveLength(6);
  expect(ui.container.querySelector('.overview-readouts')).toBeNull();
  act(() => ingestSnapshots(sparks, 104_000));
  choose(ui.container, "Live trends");
  expect(getMetricHistorySamples(head.id, "gpu.usage")).toHaveLength(3);
  expect(ui.container.querySelectorAll('.overview-trend-line').length).toBeGreaterThan(0);
  choose(ui.container, "Sectioned cards");
  act(() => ui.root.render(null));
  act(() => ui.root.render(<OverviewPage sparks={sparks} now={104_000} />));
  expect(ui.container.querySelectorAll('[data-card-style="sections"]')).toHaveLength(3);
});

it("shows unavailable readings in both bar layouts without turning them into zero", () => {
  const spark = makeSpark();
  spark.metrics.cpu!.usageAvailable = false;
  const ui = render(<OverviewPage sparks={[spark]} />);
  for (const label of ["Sectioned cards", "Compact rows"]) {
    choose(ui.container, label);
    const cpu = ui.container.querySelector('section[aria-label="CPU utilization"]')!;
    expect(cpu.querySelector('.overview-usage-value')?.textContent).toBe("—");
    expect(cpu.querySelector('[role="meter"]')).toBeNull();
  }
});

it("falls back for an invalid preference and keeps switching usable when saving fails", () => {
  localStorage.setItem(preferenceKey, "unknown");
  const ui = render(<OverviewPage sparks={[makeSpark()]} />);
  expect(ui.container.querySelector('[data-card-style="trends"]')).not.toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  choose(ui.container, "Compact rows");
  expect(ui.container.querySelector('[data-card-style="compact"]')).not.toBeNull();
  expect(ui.container.querySelector('[role="status"]')?.textContent).toContain("could not be saved");
});
