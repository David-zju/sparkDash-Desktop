import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddSparkDialog } from "./AddSparkDialog";
import { addSpark, fetchSparks, testSparkConfig } from "../api/client";
import type { SparkTestResponse } from "../api/types";
import { flush, render } from "../testing/render";

vi.mock("../desktop", async (importOriginal) => ({
  ...await importOriginal<typeof import("../desktop")>(), isDesktop: true,
}));
vi.mock("../api/client", () => ({ addSpark: vi.fn(), fetchSparks: vi.fn(), testSparkConfig: vi.fn() }));

const result = (ok: boolean, message = "ok"): SparkTestResponse => ({
  id: "fixture", capabilities: [], ok, ssh: { ok, message }, llm: { ok: false, message: "disabled" },
});
const button = (text: string) => [...document.querySelectorAll("button")].find((el) => el.textContent === text)!;
const field = (label: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const choose = (alias: string) => change(document.querySelector<HTMLSelectElement>("#ssh-config-alias")!, alias);
async function click(text: string) { act(() => button(text).click()); await flush(); }

describe("desktop SSH import and connection validation", () => {
  beforeEach(() => {
    window.sparkDesktop = {
      isDesktop: true, platform: "darwin", getPreference: () => null, setPreference: () => {},
      onPreferenceChange: () => () => {},
      listSshAliases: vi.fn().mockResolvedValue({ aliases: ["dgx-1", "dgx-2"], warnings: [] }),
    };
    vi.mocked(testSparkConfig).mockReset();
    vi.mocked(fetchSparks).mockReset().mockResolvedValue({ sparks: [] });
    vi.mocked(addSpark).mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof addSpark>>);
  });
  afterEach(() => { delete window.sparkDesktop; });

  it("imports an alias without overriding SSH config and validates SSH without saving or requiring an LLM", async () => {
    vi.mocked(testSparkConfig).mockResolvedValue(result(true));
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);
    await flush();
    choose("dgx-1");
    expect(field("Name").value).toBe("dgx-1");
    expect(field("SSH User").value).toBe("");
    expect(field("SSH Port").value).toBe("");
    await click("Test SSH connection");
    expect(testSparkConfig).toHaveBeenCalledWith(expect.objectContaining({
      lanIp: "dgx-1", ssh: { host: "dgx-1", user: "", auth: "key", password: undefined },
      llmMonitoring: false, comfyMonitoring: false, hermesMonitoring: false, tailscaleMonitoring: false,
    }));
    expect(document.body.textContent).toContain("SSH connection successful");
    expect(addSpark).not.toHaveBeenCalled();
  });

  it("offers password retry after key rejection; testing is ephemeral and Save retains monitoring", async () => {
    vi.mocked(testSparkConfig).mockResolvedValueOnce(result(false, "Permission denied (publickey,password)."))
      .mockResolvedValueOnce(result(true));
    const onAdded = vi.fn();
    render(<AddSparkDialog open onClose={() => {}} onAdded={onAdded} />);
    await flush();
    choose("dgx-1");
    await click("Test SSH connection");
    await click("Use password instead");
    change(field("SSH Password"), "fixture-password");
    await click("Test SSH connection");
    expect(testSparkConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      ssh: expect.objectContaining({ host: "dgx-1", auth: "pass", password: "fixture-password" }),
    }));
    expect(document.body.textContent).toContain("SSH connection successful");
    expect(addSpark).not.toHaveBeenCalled();
    await click("Save");
    expect(addSpark).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addSpark).mock.calls[0][0].llmMonitoring).not.toBe(false);
    expect(vi.mocked(addSpark).mock.calls[0][0].ssh.password).toBe("fixture-password");
    expect(onAdded).toHaveBeenCalledTimes(1);
  });

  it("clears credentials and old results when importing another target", async () => {
    vi.mocked(testSparkConfig).mockResolvedValue(result(true));
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);
    await flush();
    choose("dgx-1");
    change(field("SSH Auth"), "pass");
    change(field("SSH Password"), "only-for-first-host");
    change(field("SSH User"), "override-user");
    change(field("SSH Port"), "2222");
    await click("Test SSH connection");
    choose("dgx-2");
    expect(document.body.textContent).not.toContain("SSH connection successful");
    expect(field("SSH Auth").value).toBe("key");
    await click("Test SSH connection");
    expect(vi.mocked(testSparkConfig).mock.calls[1][0].ssh).toEqual({
      host: "dgx-2", user: "", auth: "key", password: undefined,
    });
  });

  it("ignores an old connection response after closing and reopening the form", async () => {
    let resolve!: (value: SparkTestResponse) => void;
    vi.mocked(testSparkConfig).mockReturnValue(new Promise((done) => { resolve = done; }));
    const props = { onClose: () => {}, onAdded: () => {} };
    const { root } = render(<AddSparkDialog open {...props} />);
    await flush();
    choose("dgx-1");
    await click("Test SSH connection");
    act(() => root.render(<AddSparkDialog open={false} {...props} />));
    act(() => root.render(<AddSparkDialog open {...props} />));
    await act(async () => resolve(result(true)));
    expect(field("Host / SSH alias").value).toBe("");
    expect(document.body.textContent).not.toContain("SSH connection successful");
    expect(button("Test SSH connection")).toBeDefined();
  });

  it("keeps manual input usable if config import fails and supports refresh", async () => {
    vi.mocked(window.sparkDesktop!.listSshAliases).mockRejectedValueOnce(new Error("unreadable"));
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);
    await flush();
    expect(document.body.textContent).toContain("Could not load SSH aliases or existing devices");
    change(field("Host / SSH alias"), "manual-host");
    expect(button("Test SSH connection").disabled).toBe(false);
    await click("Refresh aliases");
    choose("dgx-2");
    expect(field("Host / SSH alias").value).toBe("dgx-2");
  });
});
