import { translate as tr, useLocale } from "../i18n";
import { isDesktop } from "../desktop";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addSpark, testSparkConfig } from "../api/client";
import type { SparkConfig, SparkTestResponse } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { ConnectivityResult } from "./ui/ConnectivityResult";
import { SshConfigSelect } from "./SshConfigSelect";

interface AddSparkDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  defaultLlmPort?: number;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const defaultConfig: Omit<SparkConfig, "id"> = {
  name: "",
  kind: "spark",
  lanIp: "",
  cx7Ip: "",
  isLocal: false,
  llmPorts: [8888],
  ssh: { host: "", user: "", auth: "key" },
};

export function AddSparkDialog({ open, onClose, onAdded, defaultLlmPort = 8888 }: AddSparkDialogProps) {
  useLocale();
  const [config, setConfig] = useState(defaultConfig);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<SparkTestResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAlias, setSelectedAlias] = useState("");
  const testVersion = useRef(0);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEscape(onClose);

  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // Pre-fill LLM ports from settings when dialog opens
  useEffect(() => {
    testVersion.current++;
    setTestResult(null);
    setError(null);
    setTesting(false);
    if (open) {
      setConfig((prev) => ({ ...prev, llmPorts: [defaultLlmPort] }));
    } else {
      setConfig(defaultConfig);
      setSelectedAlias("");
    }
  }, [open, defaultLlmPort]);

  useEffect(() => {
    // The form can scroll on smaller windows; always reveal test feedback.
    feedbackRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [testResult, error]);

  if (!mounted) return null;

  const update = (patch: Partial<Omit<SparkConfig, "id">>) => {
    testVersion.current++;
    setTestResult(null);
    setError(null);
    setConfig((prev) => ({ ...prev, ...patch }));
  };

  const updateSsh = (patch: Partial<SparkConfig["ssh"]>) => {
    update({ ssh: { ...config.ssh, ...patch } });
  };

  const importAlias = (alias: string) => {
    update({
      name: !config.name || config.name === selectedAlias ? alias : config.name,
      lanIp: alias,
      isLocal: false,
      // Keep the alias as the destination; OpenSSH resolves its real config.
      // Never carry a previous destination's credentials into an import.
      ssh: { host: "", user: "", auth: "key" },
    });
    setSelectedAlias(alias);
  };

  const buildPayload = (): SparkConfig => {
    const id = config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 64) || `spark-${Date.now()}`;
    const auth = config.ssh.auth;
    if (!config.isLocal && auth === "pass" && !config.ssh.password) {
      throw new Error(tr("Password is required when SSH auth is Password"));
    }
    return {
      ...config,
      id,
      ssh: {
        ...config.ssh,
        password: auth === "pass" ? config.ssh.password : undefined,
        // Always set host from lanIp when empty
        host: config.ssh.host || config.lanIp,
      },
    };
  };

  const handleTest = async () => {
    const version = ++testVersion.current;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const payload = buildPayload();
      // Ephemeral test — no registry mutation
      const result = await testSparkConfig(isDesktop ? {
        ...payload,
        llmMonitoring: false, comfyMonitoring: false, hermesMonitoring: false, tailscaleMonitoring: false,
      } : payload);
      if (version === testVersion.current) setTestResult(result);
    } catch (err: unknown) {
      if (version === testVersion.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (version === testVersion.current) setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = buildPayload();
      await addSpark(payload);
      onAdded();
      setConfig(defaultConfig);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-spark-title"
      >
        <div className="modal-sheet__header" id="add-spark-title">{tr("Add Spark/GPU Host")}</div>

        <div className="modal-sheet__body">
        <fieldset disabled={testing || saving} className="space-y-3 min-w-0">
          {isDesktop && <SshConfigSelect value={selectedAlias} disabled={testing || saving} open={open} onSelect={importAlias} />}
          <div>
            <label className="mb-1 block text-xs text-muted">{tr("Unit type")}</label>
            <select
              value={config.kind ?? "spark"}
              onChange={(e) => update({ kind: e.target.value as "spark" | "host" })}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            >
              <option value="spark">NVIDIA DGX Spark</option>
              <option value="host">{tr("Dedicated GPU host (Linux, nvidia-smi, not a Spark)")}</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted">{tr("Name")}</label>
            <input
              type="text"
              aria-label={tr("Name")}
              value={config.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              placeholder={tr("My Spark")}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted">
              {isDesktop ? tr("Host / SSH alias (required)") : tr("LAN IP {0}", [config.isLocal ? tr("(optional — browser links and Wake-on-LAN)") : tr("(required)")])}
            </label>
            <input
              type="text"
              aria-label={isDesktop ? tr("Host / SSH alias") : tr("LAN IP")}
              value={config.lanIp}
              onChange={(e) => {
                setSelectedAlias("");
                update({ lanIp: e.target.value, ssh: { ...config.ssh, host: "", password: undefined } });
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              placeholder={isDesktop ? tr("dgx-1 or 192.168.1.100") : "192.168.1.100"}
            />
            {config.isLocal && !config.lanIp && (
              <p className="mt-1 text-[10px] text-muted">{tr("Local metrics still work. Open links and directed Wake-on-LAN need a LAN IP.")}</p>
            )}
          </div>

          {config.kind !== "host" && (
            <div>
              <label className="mb-1 block text-xs text-muted">{tr("CX7 IP (optional)")}</label>
              <input
                type="text"
                value={config.cx7Ip || ""}
                onChange={(e) => update({ cx7Ip: e.target.value || null })}
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                placeholder="10.0.0.1"
              />
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs text-muted">{tr("LLM Ports (optional, comma-separated)")}</label>
            <input
              type="text"
              value={(config.llmPorts ?? [defaultLlmPort]).join(", ")}
              onChange={(e) => {
                const ports = e.target.value
                  .split(",")
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
                if (ports.length > 0) update({ llmPorts: ports });
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              placeholder={String(defaultLlmPort)}
            />
            <p className="mt-1 text-[10px] text-muted">{tr("Default: ")}{defaultLlmPort}
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={config.isLocal}
                  disabled={isDesktop}
              onChange={(e) => update({ isLocal: e.target.checked })}
              className="rounded border-border"
            />
            {isDesktop ? tr("Mac App: remote devices via SSH") : tr("This host (local collectors — no SSH for metrics)")}
          </label>

          {!config.isLocal && (
            <>
              <div>
                <label className="mb-1 block text-xs text-muted">{tr("SSH Port")}</label>
                <input aria-label={tr("SSH Port")} type="number" min="1" max="65535"
                  value={config.ssh.port ?? ""}
                  placeholder={isDesktop ? tr("SSH config / default 22") : "22"}
                  onChange={(e) => updateSsh({ port: e.target.value ? Number(e.target.value) : undefined })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text" />
              </div>
              {config.ssh.auth === "key" && <div>
                <label className="mb-1 block text-xs text-muted">{tr("Private key path (optional)")}</label>
                <input aria-label={tr("Private key path")} type="text" placeholder={tr("Default keys / SSH agent")}
                  value={config.ssh.identityFile ?? ""}
                  onChange={(e) => updateSsh({ identityFile: e.target.value })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text" />
              </div>}
              <div>
                <label className="mb-1 block text-xs text-muted">{tr("SSH User")}</label>
                <input
                  type="text"
                  aria-label={tr("SSH User")}
                  placeholder={isDesktop ? tr("From SSH config / current Mac user") : undefined}
                  value={config.ssh.user}
                  onChange={(e) => updateSsh({ user: e.target.value })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-muted">{tr("SSH Auth")}</label>
                <select
                  aria-label={tr("SSH Auth")}
                  value={config.ssh.auth}
                  onChange={(e) => updateSsh({ auth: e.target.value as "key" | "pass", password: undefined })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                >
                  <option value="key">{isDesktop ? tr("SSH config / key / agent") : tr("Key")}</option>
                  <option value="pass">{tr("Password")}</option>
                </select>
                {config.ssh.auth === "key" && (
                  <p className="mt-1 text-[10px] text-muted">{tr("SSH uses your Mac’s keys and SSH agent. The device address must be reachable from this Mac.")}</p>
                )}
              </div>

              {config.ssh.auth === "pass" && (
                <div>
                  <label className="mb-1 block text-xs text-muted">{tr("SSH Password")}</label>
                  <input
                    type="password"
                    aria-label={tr("SSH Password")}
                    autoFocus
                    value={config.ssh.password || ""}
                    onChange={(e) => updateSsh({ password: e.target.value })}
                    className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                    autoComplete="new-password"
                  />
                  <p className="mt-1 text-[10px] text-muted">
                    {isDesktop
                      ? tr("Testing uses this password once without saving it. Save stores it encrypted on this Mac; macOS may request access to sparkDash Safe Storage.")
                      : tr("Stored encrypted on the server (not in sparks.json, not returned by the API). Survives Docker restarts.")}
                  </p>
                </div>
              )}
            </>
          )}
        </fieldset>

        {testResult && (isDesktop ? <div ref={feedbackRef} role="status" className={`mt-3 rounded px-3 py-2 text-xs ${testResult.ssh.ok ? "bg-success/20 text-success" : "bg-danger/20 text-danger"}`}>
          <p className="font-medium">{testResult.ssh.ok ? tr("SSH connection successful") : tr("SSH connection failed")}</p>
          {!testResult.ssh.ok && <p className="mt-1 break-words">{testResult.ssh.message}</p>}
          {testResult.ssh.ok && <p className="mt-1">{tr("Login verified. LLM and other services are checked after adding the device.")}</p>}
          {!testResult.ssh.ok && config.ssh.auth === "key" && /permission denied|authentication failed|no supported authentication/i.test(testResult.ssh.message || "") && <>
            <p className="mt-1">{tr("Key authentication did not succeed. Check the username and key, or try the remote account’s password.")}</p>
            <button type="button" onClick={() => updateSsh({ auth: "pass", password: undefined })}
              className="mt-2 rounded border border-border bg-surface px-3 py-1.5 text-text">{tr("Use password instead")}</button>
          </>}
          {!testResult.ssh.ok && config.ssh.auth === "pass" && <p className="mt-1">{tr("Check the username and password. The SSH server must allow password authentication.")}</p>}
        </div> : <ConnectivityResult result={testResult} />)}

        {error && (
          <div ref={feedbackRef} role="alert" className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger">{error}</div>
        )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || saving || (!config.isLocal && !config.lanIp)}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              {testing ? tr("Testing...") : isDesktop ? tr("Test SSH connection") : tr("Test")}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >{tr("Cancel")}</button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || testing || !config.name || (!config.isLocal && !config.lanIp)}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? tr("Saving...") : tr("Save")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
