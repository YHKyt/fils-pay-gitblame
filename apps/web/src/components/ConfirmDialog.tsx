import { useEffect, useRef } from "react";

/**
 * A shared confirmation step for irreversible money actions (refund, capture,
 * void, cancel link). It replaces `window.confirm` — which cannot show the
 * amount or the target and is suppressed in some embedded webviews — with an
 * on-brand modal that states exactly what is about to happen.
 *
 * Presentation only: it renders the message and amount passed in and calls
 * `onConfirm`/`onCancel`. It never decides the amount, the endpoint or the
 * request; the caller still owns all of that.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** The human sentence describing the action, e.g. "Refund to the cardholder". */
  message: React.ReactNode;
  /** A headline figure (already formatted, e.g. "12.500 BHD"), shown large. */
  amount?: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  amount,
  confirmLabel,
  tone = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus to the confirm button and close on Escape, so the dialog is
  // keyboard-usable and dismissible.
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fp-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="fp-confirm-card">
        <h2 className="fp-confirm-title">{title}</h2>
        {amount ? <p className="fp-confirm-amount">{amount}</p> : null}
        <p className="fp-confirm-message">{message}</p>
        <div className="fp-confirm-actions">
          <button type="button" className="dash-button dash-button-ghost" disabled={busy} onClick={onCancel}>
            Go back
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === "danger" ? "dash-button dash-button-danger" : "dash-button dash-button-primary"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
