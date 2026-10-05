import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOST_PATHS } from "./config.js";
import { powerCommand } from "./sudoAuth.js";

/**
 * Host mount namespace of PID 1, or null when the dashboard runs directly on
 * the host (bare-metal / dev) and there is no container boundary to cross.
 */
export function hostMountNs(procPath = HOST_PATHS.PROC) {
  const ns = path.join(procPath, "1", "ns", "mnt");
  try { return fs.existsSync(ns) ? ns : null; } catch { return null; }
}
/**
 * Local invocation; inside a container it enters the host mount namespace so
 * sudo and systemctl resolve against the host. `list` asks sudo whether the
 * command is allowed without running it.
 */
export function localPowerCommand({ action = "shutdown", mntNs = hostMountNs(), list = false } = {}) {
  const args = ["-n", ...(list ? ["-l"] : []), "--", ...powerCommand(action).split(" ")];
  return mntNs ? { file: "nsenter", args: [`--mount=${mntNs}`, "--", "sudo", ...args] } : { file: "sudo", args };
}
function runLocal({ file, args }, spawnFn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(file, args, { stdio: "ignore" });
    child.once("error", () => reject(new Error("Could not execute the local power command")));
    child.once("exit", code => resolve(code === 0));
  });
}
export async function spawnLocalPower({ action = "shutdown", mntNs = hostMountNs(), spawnFn = spawn } = {}) {
  if (!await runLocal(localPowerCommand({ action, mntNs }), spawnFn)) throw new Error("Local power command failed");
  return action === "reboot" ? "Reboot requested" : "Shutdown requested";
}
/** Local hosts support passwordless sudo only; the real command stays the final authority. */
export async function checkLocalPower({ mntNs = hostMountNs(), spawnFn = spawn } = {}) {
  try {
    for (const action of ["shutdown", "reboot"]) {
      if (await runLocal(localPowerCommand({ action, mntNs, list: true }), spawnFn)) return { status: "ready", passwordSupported: false };
    }
  } catch { /* sudo or nsenter missing: report as not authorized */ }
  return { status: "password_required", passwordSupported: false, error: "Passwordless sudo for systemctl poweroff/reboot is required on this host" };
}
