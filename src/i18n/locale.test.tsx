import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "../testing/render";
import { LANGUAGE_KEY, setLocale, translate, useLocale } from "./index";
import { AddSparkDialog } from "../components/AddSparkDialog";
import { CpuPanel } from "../components/SparkPage/CpuPanel";
import { FleetAlertStrip } from "../components/OverviewPage/FleetAlertStrip";
import type { SparkSnapshot } from "../api/types";

vi.mock("../hooks/metricsStore", () => ({ useMetricsHistoryTail: () => [] }));
vi.mock("../api/client", () => ({ addSpark: vi.fn(), testSparkConfig: vi.fn() }));

afterEach(() => { act(() => setLocale("en")); vi.restoreAllMocks(); });

it("switches a mounted portal and accessible labels in both directions without replacing inputs", () => {
  render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  input.focus();
  act(() => setLocale("zh-CN"));
  expect(document.querySelector('[aria-label="名称"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(document.body.textContent).toContain("添加 Spark / GPU 主机");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe("zh-CN");
  act(() => setLocale("en"));
  expect(document.querySelector('[aria-label="Name"]')).toBe(input);
  expect(document.body.textContent).toContain("Add Spark/GPU Host");
});

it("updates memoized fleet alerts and hardware empty states without waiting for telemetry", () => {
  const sparks = [{ id: "fixture", name: "Offline", online: false, metrics: { gpu: null, storage: [], llm: [] } }] as unknown as SparkSnapshot[];
  const ui = render(<><FleetAlertStrip sparks={sparks} /><CpuPanel cpu={null} sparkId="fixture" temperatureUnit="celsius" /></>);
  act(() => setLocale("zh-CN"));
  expect(ui.container.textContent).toContain("主机无法连接");
  expect(ui.container.textContent).toContain("CPU 指标不可用");
  // A user-chosen device name is never passed through the message catalogue.
  expect(ui.container.querySelector("strong")?.textContent).toBe("Offline");
  act(() => setLocale("en"));
  expect(ui.container.textContent).toContain("Host unreachable");
});

it("honors browser preference changes, including a cleared preference", () => {
  function Language() { return <span>{useLocale()}</span>; }
  const ui = render(<Language />);
  act(() => {
    localStorage.setItem(LANGUAGE_KEY, "zh-CN");
    window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_KEY }));
  });
  expect(ui.container.textContent).toBe("zh-CN");
  act(() => {
    localStorage.removeItem(LANGUAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(ui.container.textContent).toBe("en");
});

it("keeps the selected language if saving fails and treats interpolation values as data", () => {
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Disk full"); });
  expect(() => setLocale("zh-CN")).toThrow("Disk full");
  expect(translate("Settings")).toBe("Settings");
  spy.mockRestore();
  act(() => setLocale("zh-CN"));
  expect(translate("Shut down {0}", ["Offline {1}"])).toBe("关闭 Offline {1}");
  expect(translate("unrecognized diagnostic: <error>")).toBe("unrecognized diagnostic: <error>");
});
