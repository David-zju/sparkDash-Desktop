import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { ClusterSetupDialog } from "./ClusterSetupDialog";
import { OverviewPage } from "./OverviewPage";
import { discoverClusterNetwork, saveCluster } from "../../api/client";
import { fabricCandidates, hasVerifiedFabric } from "./clusters";
import type { FabricDiscovery, SparkSnapshot } from "../../api/types";

vi.mock("../../api/client", () => ({ discoverClusterNetwork: vi.fn(), saveCluster: vi.fn(), dissolveCluster: vi.fn() }));
const nodes = ["a", "b", "c"].map((id) => ({ id, name: `DGX ${id}`, kind: "spark", online: true, role: "standalone",
  metrics: { gpu: null, storage: [], llm: [] } }) as unknown as SparkSnapshot);
const discovery: FabricDiscovery = { checkedAt: Date.now(), nodes: nodes.map((s) => ({ id: s.id, name: s.name, interfaces: [], error: null })), links: [
  { a: "a", b: "b", status: "connected", verified200G: true, paths: [] },
  { a: "a", b: "c", status: "unknown", verified200G: false, paths: [] },
  { a: "b", b: "c", status: "unknown", verified200G: false, paths: [] },
] };
const button = (label: string) => [...document.querySelectorAll("button")].find((el) => el.textContent === label)!;
async function click(label: string) { act(() => button(label).click()); await flush(); }
function input(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.mocked(discoverClusterNetwork).mockResolvedValue(discovery);
  vi.mocked(saveCluster).mockResolvedValue({ success: true, sparks: [] });
});

it("scans once, lets the user choose a detected group and Head, then atomically saves roles", async () => {
  const close = vi.fn();
  render(<ClusterSetupDialog sparks={nodes} onClose={close} />);
  await flush();
  expect(discoverClusterNetwork).toHaveBeenCalledWith(["a", "b", "c"]);
  await click("DGX a + DGX b");
  await click("Assign roles");
  input(document.querySelector('[aria-label="Cluster name"]')!, "Lab");
  expect(button("Review cluster").disabled).toBe(true);
  act(() => document.querySelector<HTMLInputElement>('input[value="a"]')!.click());
  await click("Review cluster");
  expect(document.body.textContent).toContain("All selected pairs have bidirectional IP connectivity");
  await click("Save cluster");
  expect(saveCluster).toHaveBeenCalledWith({ name: "Lab", headId: "a", memberIds: ["a", "b"], previousHeadId: null });
  expect(close).toHaveBeenCalledOnce();
});

it("requires acknowledgement for unknown links and retains the draft on save failure", async () => {
  vi.mocked(saveCluster).mockRejectedValue(new Error("disk full"));
  const close = vi.fn();
  render(<ClusterSetupDialog sparks={nodes} onClose={close} />);
  await flush();
  await click("Assign roles");
  input(document.querySelector('[aria-label="Cluster name"]')!, "Lab");
  act(() => document.querySelector<HTMLInputElement>('input[value="a"]')!.click());
  await click("Review cluster");
  expect(button("Save cluster").disabled).toBe(true);
  act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click("Save cluster");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("disk full");
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Lab");
});

it("groups legacy roles, leaves orphan Workers visible, and preserves filtering inside clusters", () => {
  const sparks = [{ ...nodes[0], role: "head" as const, clusterName: "Lab" }, { ...nodes[1], role: "worker" as const, workerHeadId: "a" }, { ...nodes[2], role: "worker" as const, workerHeadId: "missing" }];
  const { container, root } = render(<OverviewPage sparks={sparks} />);
  const group = container.querySelector('[aria-label="Lab"]')!;
  expect(group.textContent).toContain("DGX a");
  expect(group.textContent).toContain("DGX b");
  expect(group.textContent).not.toContain("DGX c");
  expect(container.textContent).toContain("DGX c");
  act(() => root.render(<OverviewPage sparks={sparks} hideWorkers />));
  expect(container.textContent).toContain("1 hidden by filters");
  expect(container.textContent).not.toContain("DGX b");
});

it("does not infer a fully connected cluster from only a connected component", () => {
  const chain = { ...discovery, links: discovery.links.map((l) => l.a === "b" ? { ...l, verified200G: true } : l) };
  expect(fabricCandidates(chain)).toEqual([["a", "b", "c"]]);
  expect(hasVerifiedFabric(chain, ["a", "b", "c"])).toBe(false);
  expect(hasVerifiedFabric(chain, ["a", "b"])).toBe(true);
});
