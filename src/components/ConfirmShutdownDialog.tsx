import { translate as tr, useLocale } from "../i18n";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../hooks/useModalPresence";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { PowerOffIcon } from "./ui/icons";

import { SudoAuthenticationFields, type SudoTarget } from "./SudoAuthenticationFields";
interface ConfirmShutdownDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (sudoPasswords: Record<string, string>, targets: Record<string, string>) => void | Promise<void>;
  targets?: SudoTarget[];
  manageCredentials?: boolean;
  action?: "shutdown" | "reboot";
  title: string;
  description: string;
  confirmLabel?: string;
}

function useEscape(enabled: boolean, onClose: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [enabled, onClose]);
}

export function ConfirmShutdownDialog({
  open,
  onClose,
  onConfirm,
  title,
  targets,
  manageCredentials = false,
  action = "shutdown",
  description,
  confirmLabel = tr("Shut down"),
}: ConfirmShutdownDialogProps) {
  useLocale();
  const CONFIRM_PHRASE = action === "reboot" ? "reboot" : "poweroff";
  const [sudoPasswords, setSudoPasswords] = useState<Record<string, string>>({});
  const [targetChecks, setTargetChecks] = useState<Record<string, string>>({});
  const [authReady, setAuthReady] = useState(false);
  const [error, setError] = useState("");
  const [phrase, setPhrase] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const targetKey = JSON.stringify(targets?.map(target => target.id));

  useEscape(open && !submitting, onClose);

  useEffect(() => {
    setPhrase("");
    setSudoPasswords({});
    setTargetChecks({});
    setAuthReady(false);
    setError("");
    setAcknowledged(false);
    setSubmitting(false);
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, action, targetKey]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  const phraseOk = phrase.trim().toLowerCase() === CONFIRM_PHRASE;
  const canConfirm = phraseOk && acknowledged && !submitting && (targets === undefined || (targets.length > 0 && authReady));

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      setError("");
      await onConfirm(sudoPasswords, targetChecks);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? tr(cause.message) : tr("Shutdown failed"));
      setSubmitting(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (submitting) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="modal-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={`modal-sheet__header flex items-center gap-2 ${manageCredentials ? "text-text" : "text-danger"}`} id={titleId}>
          {!manageCredentials && <PowerOffIcon className="h-4 w-4 shrink-0" />}
          <span>{!manageCredentials && tr("Danger zone — ")}{title}</span>
        </div>

        <div className="modal-sheet__body space-y-3">
          <p className="text-xs leading-relaxed text-muted">{description}</p>
          {open && targets?.length ? <SudoAuthenticationFields targets={targets} disabled={submitting} onChange={setSudoPasswords} onReady={setAuthReady} onTargetsChange={setTargetChecks} /> : null}
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}

          {!manageCredentials && <>
          <div className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2.5">
            <p className="text-[11px] font-medium text-danger">{tr(action === "reboot" ? "This restarts the device. Running containers and sessions will stop." : "This powers off hardware. Running containers and sessions will stop.")}</p>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 text-xs text-text">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={submitting}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-danger)]"
            />
            <span>{tr(action === "reboot" ? "I understand this will interrupt running work." : "I understand this cannot be undone from the dashboard.")}</span>
          </label>

          <div>
            <label className="mb-1 block text-xs text-muted">{tr("Type ")}<span className="font-mono text-danger">{CONFIRM_PHRASE}</span>{tr(" to confirm")}</label>
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={phrase}
              disabled={submitting}
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleConfirm();
                }
              }}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 font-mono text-xs text-text outline-none focus:border-danger"
              placeholder={CONFIRM_PHRASE}
            />
          </div>
          </>}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >{tr(manageCredentials ? "Close" : "Cancel")}</button>
            {!manageCredentials && <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
              className="rounded-md border border-danger/50 bg-danger px-3 py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? tr("Sending request…") : confirmLabel}
            </button>}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
