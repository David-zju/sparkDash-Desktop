import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { ClusterBenchmarkDialog } from "./ClusterBenchmarkDialog";
import { discoverClusterNetwork, fetchFabricBenchmark, startFabricBenchmark, cancelFabricBenchmark } from "../../api/client";
import type { FabricDiscovery, FabricBenchmarkJob, SparkSnapshot } from "../../api/types";
vi.mock("../../api/client", () => ({ discoverClusterNetwork: vi.fn(), fetchFabricBenchmark: vi.fn(), startFabricBenchmark: vi.fn(), cancelFabricBenchmark: vi.fn() }));
const members = ['a', 'b', 'c'].map((id) => ({ id, name: `Spark ${id}` }) as SparkSnapshot);
const path = { key: 'p', aInterface: 'cx0', aIp: '10.1.1.1', bInterface: 'cx0', bIp: '10.1.1.2', speedMbps: 200000, forward: true, reverse: true, forwardReason: 'reachable', reverseReason: 'reachable' };
const discovery: FabricDiscovery = { checkedAt: 1, nodes: [], links: [{ a: 'a', b: 'b', paths: [path], verified200G: true, status: 'connected' }] };
const job: FabricBenchmarkJob = { id: 'j', a: 'a', b: 'b', names: ['Spark a', 'Spark b'], status: 'running', phase: 'Checking test tools', startedAt: 1, finishedAt: null, path, checks: [], results: [], error: null };
const button = (label: string) => [...document.querySelectorAll('button')].find((el) => el.textContent === label)!;
async function click(label: string) { act(() => button(label).click()); await flush(); }
beforeEach(() => {
  vi.mocked(fetchFabricBenchmark).mockResolvedValue({ job: null });
  vi.mocked(discoverClusterNetwork).mockResolvedValue(discovery);
  vi.mocked(startFabricBenchmark).mockResolvedValue({ job });
  vi.mocked(cancelFabricBenchmark).mockResolvedValue({ job: { ...job, status: 'cancelled' } });
});
it('does not start traffic on open; requires discovery then explicit start and supports stop', async () => {
  render(<ClusterBenchmarkDialog headId="a" members={members} onClose={() => {}} />); await flush();
  expect(startFabricBenchmark).not.toHaveBeenCalled();
  expect(discoverClusterNetwork).not.toHaveBeenCalled();
  expect(button('Start network test').disabled).toBe(true);
  await click('Find network paths');
  expect(discoverClusterNetwork).toHaveBeenCalledWith(['a', 'b']);
  await click('Start network test');
  expect(startFabricBenchmark).toHaveBeenCalledWith({ headId: 'a', a: 'a', b: 'b', path, kinds: ['tcp', 'rdma'] });
  expect(button('Start network test').disabled).toBe(true);
  await click('Stop network test');
  expect(cancelFabricBenchmark).toHaveBeenCalledWith('j');
});
it('changing the device pair invalidates previously discovered paths', async () => {
  render(<ClusterBenchmarkDialog headId="a" members={members} onClose={() => {}} />); await flush(); await click('Find network paths');
  expect(button('Start network test').disabled).toBe(false);
  act(() => { const select = document.querySelectorAll('select')[1]; select.value = 'c'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('Start network test').disabled).toBe(true);
});
it('restores results on reopen and shows unavailable RDMA without a zero bandwidth', async () => {
  vi.mocked(fetchFabricBenchmark).mockResolvedValue({ job: { ...job, status: 'completed', results: [
    { kind: 'tcp', direction: 'forward', status: 'passed', gbps: 123.456, error: null, logs: [] },
    { kind: 'rdma', direction: 'both', status: 'unavailable', gbps: null, error: 'missing-tool', logs: [] },
  ] } });
  render(<ClusterBenchmarkDialog headId="a" members={members} onClose={() => {}} />); await flush();
  expect(document.body.textContent).toContain('123.46 Gb/s');
  expect(document.body.textContent).toContain('missing-tool');
  expect(document.body.textContent).not.toContain('0.00 Gb/s');
});
it('does not start a second job when another cluster is testing', async () => {
  vi.mocked(fetchFabricBenchmark).mockResolvedValue({ job: { ...job, a: 'x', b: 'y' } });
  render(<ClusterBenchmarkDialog headId="a" members={members} onClose={() => {}} />); await flush();
  expect(button('Find network paths').disabled).toBe(true);
  expect(document.body.textContent).toContain('A network test is running in another cluster.');
});
