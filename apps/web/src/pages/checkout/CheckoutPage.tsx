import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import { bahrainDateTime } from "../../format.js";
import type { PaymentLinkPublicDto, SimulatedCardInput } from "../../types.js";
import { endsCheckoutAttempt, isOutcomeUnknown, resolveLostPayment } from "../../utils/checkoutRecovery.js";
import { Logo } from "../../components/Logo.js";
import { ThemeToggle } from "../../components/ThemeToggle.js";
import "./CheckoutPage.css";

/** A small inline lock glyph — a trust cue for the hosted payment page. No
 *  external asset (the box is offline). */
function LockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ verticalAlign: "-1px" }}
    >
      <rect x="4" y="10" width="16" height="11" rx="2.5" fill="currentColor" opacity="0.18" />
      <rect x="4" y="10" width="16" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="12" cy="15" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** A satisfying success mark: a ring that pops, a tick that draws itself, and
 *  a single pulse halo. Pure SVG + CSS (see CheckoutPage.css); reduced-motion
 *  viewers get the final static mark. */
function SuccessCheck() {
  return (
    <span className="checkout-check" aria-hidden="true">
      <svg className="checkout-check-svg" viewBox="0 0 52 52" fill="none">
        <circle className="checkout-check-pulse" cx="26" cy="26" r="24" />
        <circle className="checkout-check-ring" cx="26" cy="26" r="23" />
        <path className="checkout-check-tick" d="M15 27l7.5 7.5L37 19" />
      </svg>
    </span>
  );
}

/** The chrome shared by every checkout state: brand header, a single content
 *  card, and a FilsPay trust footer. Presentation only — each state renders
 *  its own content inside. `tone` tints the card header strip for success /
 *  error / neutral states. */
function CheckoutShell({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "error" | "info";
}) {
  return (
    <div className="checkout-root">
      <div className={`checkout-page checkout-tone-${tone}`}>
        <header className="checkout-header">
          <Logo tone="ink" size={24} />
          <span className="checkout-header-right">
            <span className="checkout-secure">
              <LockIcon /> Secure checkout
            </span>
            <ThemeToggle />
          </span>
        </header>
        <div className="checkout-card">{children}</div>
        <footer className="checkout-footer">
          <LockIcon size={12} /> Payments secured by <strong>FilsPay</strong>
        </footer>
      </div>
    </div>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

/** transactionId / paidAt are known only when the pay response itself
 *  arrived; a payment confirmed by polling the public read has neither. */
interface Receipt {
  amountFils: number;
  transactionId: string | null;
  paidAt: string | null;
}

/** Pay request timeout, and how long to poll the link after a lost response. */
const PAY_TIMEOUT_MS = 30_000;
const VERIFY_POLL = { attempts: 5, delayMs: 2_000 };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "verifying" }
  | { kind: "success"; receipt: Receipt }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string };

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 1, expiryYear: new Date().getFullYear() + 1, cvv: "" };

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [brandHint, setBrandHint] = useState<string | null>(null);
  // One Idempotency-Key per payment attempt, kept across network failures:
  // if the request reached the server but the response was lost, the retry
  // replays that payment instead of charging the card a second time. It is
  // rotated only once the server has given a definitive answer.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  // Different card details = a different payment (the server would reject
  // the old key with a different body as a reused key).
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, [card]);

  // FH: memory leak — this effect never aborts the fetch on unmount (React warning in console?)
  // theres a cancelled flag in the cleanup tho. warning must be from somewhere else — am
  useEffect(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch(() => {
        // Never distinguishes "malformed token" from "doesn't exist" —
        // matches the API's own non-disclosure choice.
        if (!cancelled) setLoadState({ kind: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // A 'processing' link has a payment in flight (or a capture whose outcome
  // is still being settled): keep re-reading it until it resolves instead
  // of asking the customer to refresh. 'paid' is only reported once the
  // capture has landed.
  const linkStatus = loadState.kind === "loaded" ? loadState.link.status : null;
  useEffect(() => {
    if (!token || linkStatus !== "processing") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getPaymentLink(token)
        .then((link) => {
          if (!cancelled) setLoadState({ kind: "loaded", link });
        })
        .catch(() => {
          // Transient read failure: re-arm the poll by re-setting the same state.
          if (!cancelled) setLoadState((s) => (s.kind === "loaded" ? { ...s, link: { ...s.link } } : s));
        });
    }, VERIFY_POLL.delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, linkStatus, loadState]); // a fresh loadState re-arms the next poll

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token || payState.kind === "submitting" || payState.kind === "verifying") return;

    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card }, idempotencyKey, PAY_TIMEOUT_MS);
      setPayState({
        kind: "success",
        receipt: { amountFils: result.amountFils, transactionId: result.transactionId, paidAt: result.paidAt },
      });
    } catch (err) {
      if (isOutcomeUnknown(err)) {
        // Timeout, network drop or 5xx: the charge may have happened. Ask
        // the link before offering to pay again. The key is kept, so any
        // re-pay replays this attempt instead of charging twice.
        await verifyAfterLostResponse(token);
        return;
      }
      if (err instanceof ApiError) {
        const { statusCode, body } = err;
        // A decline or other definitive answer ends this attempt; "try
        // again" (e.g. with another card) is a new one. 5xx and an
        // in-flight 409 keep the key.
        if (endsCheckoutAttempt(err)) setIdempotencyKey(crypto.randomUUID());
        if (statusCode === 402) {
          const stageLabel = body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.";
          setPayState({ kind: "declined", message: stageLabel, retryable: true });
        } else if (statusCode === 502) {
          setPayState({ kind: "declined", message: "The acquirer is temporarily unavailable. Please try again.", retryable: true });
        } else if (statusCode === 409 && body.error === "payment_link_already_paid") {
          setPayState({ kind: "terminal", message: "This invoice has already been paid." });
        } else if (statusCode === 409 && body.error === "payment_link_canceled") {
          setPayState({ kind: "terminal", message: "This payment link is no longer available." });
        } else if (statusCode === 409) {
          setPayState({ kind: "declined", message: "A payment is already being processed for this link. Please try again shortly.", retryable: true });
        } else if (statusCode === 410) {
          setPayState({ kind: "terminal", message: "This payment link has expired." });
        } else {
          setPayState({ kind: "declined", message: body.message ?? "Something went wrong. Please try again.", retryable: true });
        }
      } else {
        setPayState({ kind: "declined", message: "Something went wrong. Please try again.", retryable: true });
      }
    }
  }

  async function verifyAfterLostResponse(linkToken: string): Promise<void> {
    setPayState({ kind: "verifying" });
    const resolution = await resolveLostPayment(() => getPaymentLink(linkToken), VERIFY_POLL);
    switch (resolution.kind) {
      case "paid":
        setLoadState({ kind: "loaded", link: resolution.link });
        setPayState({
          kind: "success",
          receipt: { amountFils: resolution.link.amountFils, transactionId: null, paidAt: null },
        });
        return;
      case "closed":
        // Expired or canceled meanwhile: the status views below take over.
        setLoadState({ kind: "loaded", link: resolution.link });
        setPayState({ kind: "idle" });
        return;
      case "retryable":
        setLoadState({ kind: "loaded", link: resolution.link });
        setPayState({
          kind: "declined",
          message: "Your payment did not go through. Please try again.",
          retryable: true,
        });
        return;
      case "unknown":
        setPayState({
          kind: "declined",
          message:
            "We could not confirm whether your payment went through. Please wait a moment and try again — " +
            "you will not be charged twice.",
          retryable: true,
        });
        return;
    }
  }

  if (loadState.kind === "loading") {
    return (
      <CheckoutShell>
        <p className="checkout-loading">Loading payment details…</p>
      </CheckoutShell>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <CheckoutShell tone="error">
        <h1>Payment link not found</h1>
        <p className="checkout-message">This payment link does not exist.</p>
      </CheckoutShell>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <CheckoutShell tone="success">
        <div className="checkout-result">
          <SuccessCheck />
          <h1>Payment successful</h1>
          <p className="checkout-message">Thank you — your payment has been received.</p>
        </div>
        <dl className="checkout-receipt">
          <dt>Merchant</dt>
          <dd>{link.merchantDisplayName}</dd>
          <dt>Amount</dt>
          <dd className="checkout-receipt-amount">{formatBhd(toFils(payState.receipt.amountFils))} BHD</dd>
          {link.reference ? (
            <>
              <dt>Reference</dt>
              <dd>{link.reference}</dd>
            </>
          ) : null}
          {payState.receipt.transactionId ? (
            <>
              <dt>Transaction ID</dt>
              <dd>
                <code>{payState.receipt.transactionId}</code>
              </dd>
            </>
          ) : null}
          {payState.receipt.paidAt ? (
            <>
              <dt>Paid at</dt>
              <dd>{bahrainDateTime(payState.receipt.paidAt)}</dd>
            </>
          ) : null}
        </dl>
      </CheckoutShell>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <CheckoutShell tone="error">
        <h1>Unable to pay</h1>
        <p className="checkout-message">{payState.message}</p>
      </CheckoutShell>
    );
  }

  if (link.status === "paid") {
    return (
      <CheckoutShell tone="success">
        <div className="checkout-result">
          <SuccessCheck />
          <h1>Already paid</h1>
          <p className="checkout-message">This invoice has already been paid.</p>
        </div>
      </CheckoutShell>
    );
  }
  if (link.status === "expired") {
    return (
      <CheckoutShell tone="error">
        <h1>Link expired</h1>
        <p className="checkout-message">This payment link has expired.</p>
      </CheckoutShell>
    );
  }
  if (link.status === "canceled") {
    return (
      <CheckoutShell tone="error">
        <h1>No longer available</h1>
        <p className="checkout-message">This payment link is no longer available.</p>
      </CheckoutShell>
    );
  }
  if (link.status === "processing") {
    return (
      <CheckoutShell tone="info">
        <h1>Payment processing</h1>
        <p className="checkout-loading">
          A payment is being processed for this link. This page updates automatically.
        </p>
      </CheckoutShell>
    );
  }

  // link.status === 'active'
  const amount = formatBhd(toFils(link.amountFils));
  const submitting = payState.kind === "submitting" || payState.kind === "verifying";

  return (
    <CheckoutShell>
      <div className="checkout-summary">
        <p className="checkout-merchant">{link.merchantDisplayName}</p>
        <p className="checkout-amount">
          {amount}
          <span className="checkout-amount-unit">BHD</span>
        </p>
        {link.description ? <p className="checkout-description">{link.description}</p> : null}
        {link.reference ? <p className="checkout-reference">Reference: {link.reference}</p> : null}
      </div>

      {payState.kind === "declined" ? (
        <p className="checkout-error" role="alert">
          {payState.message}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="checkout-form">
        <label>
          Card number
          <input
            type="text"
            inputMode="numeric"
            required
            value={card.pan}
            onChange={(e) => {
              const pan = e.target.value;
              setCard({ ...card, pan });
              const digits = pan.replace(/\D/g, "");
              if (digits.length >= 4) {
                void import("../../utils/helpers.js").then((m) => {
                  setBrandHint(m.formatCardBrandHint(digits));
                });
              } else {
                setBrandHint(null);
              }
            }}
          />
          {brandHint && brandHint !== "unknown" ? (
            <span className="checkout-brand-hint">{brandHint}</span>
          ) : null}
        </label>
        <div className="checkout-form-row">
          <label>
            Expiry month
            <input
              type="number"
              min={1}
              max={12}
              required
              value={card.expiryMonth}
              onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}
            />
          </label>
          <label>
            Expiry year
            <input
              type="number"
              min={new Date().getFullYear()}
              required
              value={card.expiryYear}
              onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}
            />
          </label>
          <label>
            CVV
            <input
              type="text"
              inputMode="numeric"
              required
              value={card.cvv}
              onChange={(e) => setCard({ ...card, cvv: e.target.value })}
            />
          </label>
        </div>
        <button type="submit" disabled={submitting}>
          {payState.kind === "verifying" ? "Checking payment status..." : submitting ? "Processing..." : `Pay ${amount} BHD`}
        </button>
      </form>

      <p className="checkout-help">
        Test cards (simulated acquirer, no real charge): any other number approves; a PAN ending{" "}
        <code>0002</code> always declines (do not honor); ending <code>0119</code> always declines
        (insufficient funds); ending <code>0069</code> always errors.
      </p>
    </CheckoutShell>
  );
}
