import { sshExec } from "./collectors/ssh.js";

const POWER_COMMANDS = Object.freeze({ shutdown: "systemctl poweroff", reboot: "systemctl reboot" });
export function powerCommand(action) {
  if (!Object.hasOwn(POWER_COMMANDS, action)) throw new Error("Unsupported power action");
  return POWER_COMMANDS[action];
}
export function validateSudoPassword(password) {
  if (typeof password !== "string" || !password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new Error("Enter a valid sudo password");
  return password;
}
// Passwords travel only on SSH stdin, never in shell text, argv or diagnostics.
export function sudoInvocation(password, action) {
  if (password !== undefined) validateSudoPassword(password);
  return {
    command: `sudo ${password === undefined ? "-n" : "-S -k -p ''"}${action ? ` -- ${powerCommand(action)}` : " -v"}`,
    options: { timeoutMs: 12000, input: password === undefined ? undefined : `${password}\n`, sensitive: true },
  };
}
export async function checkPowerAuth(spark, password, exec = sshExec) {
  if (spark.isLocal) return { status: "ready" };
  const present = await exec(spark, "if command -v systemctl >/dev/null 2>&1; then echo present; else echo missing; fi");
  if (present !== "present") return { status: "command_missing", error: "systemctl is not available on this device" };
  const { command, options } = sudoInvocation(password);
  try { await exec(spark, command, options); return { status: "ready" }; }
  catch { return { status: "password_required", error: password === undefined ? "Sudo authentication required" : "Sudo authentication failed or the account is not authorized" }; }
}
export async function authenticatedPowerAction(spark, action, password, exec = sshExec) {
  // Fixed allowlist; no user-supplied shell commands. The actual sudo command is
  // the final authority on command-specific policy, regardless of preflight.
  const { command, options } = sudoInvocation(password, action);
  try { await exec(spark, command, options); }
  catch { throw new Error("Power command result is unconfirmed; check sudo permissions and device state before retrying"); }
  return action === "reboot" ? "Reboot requested" : "Shutdown requested";
}
export async function verifySudoPassword(spark, password, exec = sshExec) {
  validateSudoPassword(password);
  if (spark.isLocal) throw new Error("Sudo credentials are supported for SSH devices only");
  const { command, options } = sudoInvocation(password);
  await exec(spark, command, options);
}
