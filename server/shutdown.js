import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOST_PATHS } from "./config.js";
import { powerCommand } from "./sudoAuth.js";

export function hostMountNs(procPath = HOST_PATHS.PROC) {
  const ns = path.join(procPath, "1", "ns", "mnt");
  try { return fs.existsSync(ns) ? ns : null; } catch { return null; }
}
export function localPowerCommand({ action = "shutdown", mntNs = hostMountNs() } = {}) {
  const args = ["-n", "--", ...powerCommand(action).split(" ")];
  return mntNs ? { file: "nsenter", args: [`--mount=${mntNs}`, "--", "sudo", ...args] } : { file: "sudo", args };
}
export function spawnLocalPower({ action = "shutdown", mntNs = hostMountNs(), spawnFn = spawn } = {}) {
  const { file, args } = localPowerCommand({ action, mntNs });
  return new Promise((resolve, reject) => {
    const child = spawnFn(file, args, { stdio: "ignore" });
    child.once("error", () => reject(new Error("Could not execute the local power command")));
    child.once("exit", code => code === 0 ? resolve(action === "reboot" ? "Reboot requested" : "Shutdown requested") : reject(new Error("Local power command failed")));
  });
}
