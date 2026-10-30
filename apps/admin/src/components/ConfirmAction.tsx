import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * One shared confirmation dialog for every action that moves money or
 * changes a merchant's state. It always restates *what* will happen (amount,
 * merchant, count) before the operator commits, and can demand a reason
 * that is recorded in the audit log.
 */
export function ConfirmAction({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  reason,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  /** When set, a reason textarea is shown and the confirm button stays
   *  disabled until it has at least `minLength` characters. */
  reason?: { label: string; minLength?: number; initial?: string };
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [reasonText, setReasonText] = useState(reason?.initial ?? "");
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setReasonText(reason?.initial ?? "");
    cancelRef.current?.focus();
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const minLength = reason?.minLength ?? 1;
  const reasonOk = !reason || reasonText.trim().length >= minLength;

  return (
    <div className="admin-dialog-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        className="admin-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="admin-dialog-body">{children}</div>
        {reason ? (
          <label className="admin-dialog-reason">
            {reason.label}
            <textarea
              rows={3}
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              aria-invalid={!reasonOk}
            />
            {minLength > 1 ? (
              <span className="admin-muted">At least {minLength} characters.</span>
            ) : null}
          </label>
        ) : null}
        {error ? <p className="admin-error">{error}</p> : null}
        <div className="admin-dialog-actions">
          <button ref={cancelRef} type="button" className="admin-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "admin-btn-danger" : "admin-btn-primary"}
            disabled={busy || !reasonOk}
            onClick={() => onConfirm(reasonText.trim())}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
