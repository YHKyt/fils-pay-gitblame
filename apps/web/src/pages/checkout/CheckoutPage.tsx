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

/** Simple card-brand marks for the trust row. Generic shapes, no trademarks. */
function CardMarks() {
  return (
    <span className="checkout-cardmarks" aria-label="Visa, Mastercard and BENEFIT cards accepted">
      <span className="checkout-cardmark checkout-cardmark-visa" aria-hidden="true">VISA</span>
      <span className="checkout-cardmark checkout-cardmark-mc" aria-hidden="true">
        <svg viewBox="0 0 30 18" width="26" height="16" focusable="false">
          <circle cx="11" cy="9" r="7" fill="#EB5A3C" />
          <circle cx="19" cy="9" r="7" fill="#F2A93B" fillOpacity="0.9" />
        </svg>
      </span>
      <span className="checkout-cardmark checkout-cardmark-benefit" aria-hidden="true">BENEFIT</span>
    </span>
  );
}

/** Counts the displayed amount up once on first show. Reduced-motion viewers
 *  (and the test environment) get the final value straight away. */
function useCountUp(targetFils: number, durationMs = 900): number {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return targetFils;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return targetFils;
    return 0;
  });
  useEffect(() => {
    if (value === targetFils) return;
    if (typeof window.requestAnimationFrame !== "function") {
      setValue(targetFils);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(targetFils * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFils, durationMs]);
  return value;
}

function AsideAmount({ amountFils }: { amountFils: number }) {
  const shown = useCountUp(amountFils);
  const final = formatBhd(toFils(amountFils));
  return (
    <p className="checkout-aside-amount" aria-label={`${final} BHD`}>
      <span aria-hidden="true">{formatBhd(toFils(shown))}</span>
      <span className="checkout-aside-unit" aria-hidden="true">BHD</span>
    </p>
  );
}

/** The left (desktop) / top (phone) petrol panel: who is being paid, how
 *  much, and why. Without a loaded link it shows the FilsPay brand only. */
function CheckoutAside({ link }: { link: PaymentLinkPublicDto | null }) {
  const initial = link?.merchantDisplayName.trim().charAt(0).toUpperCase() || "F";
  return (
    <aside className="checkout-aside">
      <div className="checkout-aside-inner">
        <div className="checkout-aside-top">
          <Logo tone="light" size={26} />
          <span className="checkout-aside-secure">
            <LockIcon /> Secure checkout
          </span>
        </div>
        {link ? (
          <div className="checkout-aside-body">
            <div className="checkout-merchant-row">
              <span className="checkout-avatar" aria-hidden="true">{initial}</span>
              <span className="checkout-merchant-meta">
                <span className="checkout-aside-kicker">Pay</span>
                <span className="checkout-merchant">{link.merchantDisplayName}</span>
              </span>
            </div>
            <AsideAmount amountFils={link.amountFils} />
            {link.description ? <p className="checkout-description">{link.description}</p> : null}
            <dl className="checkout-order">
              <div>
                <dt>Merchant</dt>
                <dd>{link.merchantDisplayName}</dd>
              </div>
              {link.reference ? (
                <div>
                  <dt>Reference</dt>
                  <dd className="checkout-mono">{link.reference}</dd>
                </div>
              ) : null}
              <div>
                <dt>Currency</dt>
                <dd>Bahraini dinar (BHD)</dd>
              </div>
              <div className="checkout-order-total">
                <dt>Total due</dt>
                <dd>{formatBhd(toFils(link.amountFils))} BHD</dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="checkout-aside-body checkout-aside-brand">
            <p className="checkout-aside-headline">Payments, settled in Bahrain.</p>
            <p className="checkout-aside-sub">Hosted checkout by FilsPay.</p>
          </div>
        )}
        <div className="checkout-trust">
          <span className="checkout-trust-lock">
            <LockIcon size={14} /> Secured by <strong>FilsPay</strong>
          </span>
          <CardMarks />
        </div>
      </div>
    </aside>
  );
}

/** The frame shared by every checkout state: a petrol summary panel and a
 *  pearl content panel. Presentation only; each state renders its own content
 *  inside. `tone` tints the state for success / error / info screens. */
function CheckoutShell({
  children,
  link = null,
  tone = "neutral",
}: {
  children: React.ReactNode;
  link?: PaymentLinkPublicDto | null;
  tone?: "neutral" | "success" | "error" | "info";
}) {
  return (
    <div className={`checkout-root checkout-tone-${tone}`}>
      <CheckoutAside link={link} />
      <main className="checkout-main">
        <div className="checkout-main-top">
          <ThemeToggle />
        </div>
        <div className="checkout-card">{children}</div>
        <footer className="checkout-footer">
          <LockIcon size={12} /> Payments secured by <strong>FilsPay</strong> · Encrypted end to end
        </footer>
      </main>
    </div>
  );
}

/** A state icon for the non-success screens (error / info). */
function StateIcon({ kind }: { kind: "error" | "info" }) {
  return (
    <span className={`checkout-state-icon checkout-state-icon-${kind}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" focusable="false">
        {kind === "error" ? (
          <>
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 7.5v5.5M12 16.3v.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 7v5l3.2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  );
}

/** Groups card digits in fours for display ("4242 4242 4242 4242"). */
function groupPan(digits: string): string {
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ");
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
  // Show the simulated-acquirer test-card note only on a development build or
  // when explicitly opted in — never to a real payer in production.
  const showTestCards =
    import.meta.env.DEV || import.meta.env.VITE_SHOW_TEST_CARDS === "true";
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [brandHint, setBrandHint] = useState<string | null>(null);
  // The combined MM/YY field as typed; parsed into expiryMonth / expiryYear.
  const [expiryDraft, setExpiryDraft] = useState("");
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
        <div className="checkout-state" aria-busy="true">
          <span className="checkout-spinner" aria-hidden="true" />
          <p className="checkout-loading">Loading payment details…</p>
        </div>
      </CheckoutShell>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <CheckoutShell tone="error">
        <div className="checkout-state">
          <StateIcon kind="error" />
          <h1>This payment link isn't valid</h1>
          <p className="checkout-message">
            Check the link with the business that sent it. No payment was taken.
          </p>
        </div>
      </CheckoutShell>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <CheckoutShell tone="success" link={link}>
        <div className="checkout-state checkout-result">
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
        <p className="checkout-smallprint">You can close this page. Keep the reference for your records.</p>
      </CheckoutShell>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <CheckoutShell tone="error" link={link}>
        <div className="checkout-state">
          <StateIcon kind="error" />
          <h1>Unable to pay</h1>
          <p className="checkout-message">{payState.message}</p>
        </div>
      </CheckoutShell>
    );
  }

  if (link.status === "paid") {
    return (
      <CheckoutShell tone="success" link={link}>
        <div className="checkout-state checkout-result">
          <SuccessCheck />
          <h1>Already paid</h1>
          <p className="checkout-message">This invoice has already been paid. Nothing more is due.</p>
        </div>
      </CheckoutShell>
    );
  }
  if (link.status === "expired") {
    return (
      <CheckoutShell tone="error" link={link}>
        <div className="checkout-state">
          <StateIcon kind="error" />
          <h1>Link expired</h1>
          <p className="checkout-message">This payment link has expired. Ask the business for a new one.</p>
        </div>
      </CheckoutShell>
    );
  }
  if (link.status === "canceled") {
    return (
      <CheckoutShell tone="error" link={link}>
        <div className="checkout-state">
          <StateIcon kind="error" />
          <h1>No longer available</h1>
          <p className="checkout-message">This payment link is no longer available.</p>
        </div>
      </CheckoutShell>
    );
  }
  if (link.status === "processing") {
    return (
      <CheckoutShell tone="info" link={link}>
        <div className="checkout-state">
          <span className="checkout-spinner" aria-hidden="true" />
          <h1>Payment processing</h1>
          <p className="checkout-loading">
            A payment is being processed for this link. This page updates automatically.
          </p>
        </div>
      </CheckoutShell>
    );
  }

  // link.status === 'active'
  const amount = formatBhd(toFils(link.amountFils));
  const submitting = payState.kind === "submitting" || payState.kind === "verifying";

  return (
    <CheckoutShell link={link}>
      <div className="checkout-form-head">
        <h1>Pay by card</h1>
        <p className="checkout-form-sub">Enter your card details to pay {link.merchantDisplayName}.</p>
      </div>

      {payState.kind === "declined" ? (
        <p className="checkout-error" role="alert">
          {payState.message}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="checkout-form">
        <label className="checkout-field">
          <span className="checkout-label">Card number</span>
          <span className="checkout-input-wrap">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="1234 5678 9012 3456"
              maxLength={23}
              required
              value={groupPan(card.pan)}
              onChange={(e) => {
                const pan = e.target.value.replace(/\D/g, "").slice(0, 19);
                setCard({ ...card, pan });
                const digits = pan;
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
          </span>
        </label>
        <div className="checkout-form-row">
          <label className="checkout-field">
            <span className="checkout-label">Expiry (MM/YY)</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp"
              placeholder="MM/YY"
              maxLength={5}
              required
              pattern="(0[1-9]|1[0-2])/[0-9]{2}"
              title="Expiry as MM/YY"
              value={expiryDraft}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
                const text = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
                setExpiryDraft(text);
                if (digits.length === 4) {
                  const month = Number(digits.slice(0, 2));
                  const year = 2000 + Number(digits.slice(2));
                  if (month >= 1 && month <= 12) setCard({ ...card, expiryMonth: month, expiryYear: year });
                }
              }}
            />
          </label>
          <label className="checkout-field">
            <span className="checkout-label">CVV</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder="123"
              maxLength={4}
              required
              value={card.cvv}
              onChange={(e) => setCard({ ...card, cvv: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
          </label>
        </div>
        <button type="submit" className="checkout-pay" disabled={submitting}>
          {submitting ? <span className="checkout-btn-spinner" aria-hidden="true" /> : <LockIcon size={15} />}
          <span>
            {payState.kind === "verifying" ? "Checking payment status..." : submitting ? "Processing..." : `Pay ${amount} BHD`}
          </span>
        </button>
        <p className="checkout-smallprint">
          Your card details go straight to the acquirer over an encrypted connection. {link.merchantDisplayName} never
          sees your full card number.
        </p>
      </form>

      {/* The simulated-acquirer cheat sheet is for development and the demo
          only — never shown to a real payer on a production build. Gated on
          the Vite build mode (import.meta.env.DEV) / an explicit opt-in flag;
          the field names and request are unchanged either way. */}
      {showTestCards ? (
        <div className="checkout-testmode">
          <span className="checkout-testmode-pill">Test mode</span>
          <p className="checkout-help">
            Simulated acquirer, no real charge. Any card number approves; a card number ending{" "}
            <code>0002</code> is declined by the bank; ending <code>0119</code> has insufficient
            funds; ending <code>0069</code> errors.
          </p>
        </div>
      ) : null}
    </CheckoutShell>
  );
}
