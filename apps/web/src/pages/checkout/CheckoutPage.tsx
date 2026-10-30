import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import { bahrainDateTime } from "../../format.js";
import type { PaymentLinkPublicDto, SimulatedCardInput } from "../../types.js";
import { isOutcomeUnknown, resolveLostPayment } from "../../utils/checkoutRecovery.js";
import "./CheckoutPage.css";

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
        // again" (e.g. with another card) is a new one. 5xx keeps the key.
        if (statusCode < 500) setIdempotencyKey(crypto.randomUUID());
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
      <main className="checkout-page">
        <p>Loading...</p>
      </main>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <main className="checkout-page">
        <h1>Payment link not found</h1>
        <p>This payment link does not exist.</p>
      </main>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <main className="checkout-page">
        <h1>Payment successful</h1>
        <p>Thank you — your payment has been received.</p>
        <dl>
          <dt>Merchant</dt>
          <dd>{link.merchantDisplayName}</dd>
          <dt>Amount</dt>
          <dd>{formatBhd(toFils(payState.receipt.amountFils))} BHD</dd>
          {link.reference ? (
            <>
              <dt>Reference</dt>
              <dd>{link.reference}</dd>
            </>
          ) : null}
          {payState.receipt.transactionId ? (
            <>
              <dt>Transaction ID</dt>
              <dd>{payState.receipt.transactionId}</dd>
            </>
          ) : null}
          {payState.receipt.paidAt ? (
            <>
              <dt>Paid at</dt>
              <dd>{bahrainDateTime(payState.receipt.paidAt)}</dd>
            </>
          ) : null}
        </dl>
      </main>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <main className="checkout-page">
        <h1>Unable to pay</h1>
        <p>{payState.message}</p>
      </main>
    );
  }

  if (link.status === "paid") {
    return (
      <main className="checkout-page">
        <h1>Already paid</h1>
        <p>This invoice has already been paid.</p>
      </main>
    );
  }
  if (link.status === "expired") {
    return (
      <main className="checkout-page">
        <h1>Link expired</h1>
        <p>This payment link has expired.</p>
      </main>
    );
  }
  if (link.status === "canceled") {
    return (
      <main className="checkout-page">
        <h1>No longer available</h1>
        <p>This payment link is no longer available.</p>
      </main>
    );
  }
  if (link.status === "processing") {
    return (
      <main className="checkout-page">
        <h1>Payment processing</h1>
        <p>A payment is being processed for this link. This page updates automatically.</p>
      </main>
    );
  }

  // link.status === 'active'
  const amount = formatBhd(toFils(link.amountFils));
  const submitting = payState.kind === "submitting" || payState.kind === "verifying";

  return (
    <main className="checkout-page">
      <h1>{link.merchantDisplayName}</h1>
      <p className="checkout-amount">{amount} BHD</p>
      {link.description ? <p className="checkout-description">{link.description}</p> : null}
      {link.reference ? <p className="checkout-reference">Reference: {link.reference}</p> : null}

      {payState.kind === "declined" ? <p className="checkout-error">{payState.message}</p> : null}

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
    </main>
  );
}
