/**
 * A colour-coded status pill. Presentation only: it renders the same text
 * the console already showed, wrapped in a pill whose tone is derived from
 * the value. It changes nothing about the data — an unknown value simply
 * falls back to the neutral tone and its text is shown verbatim.
 *
 * The tone map covers the status vocabularies the admin screens display:
 * merchant account status, KYC / onboarding states, settlement batch and
 * payout states, credit-request and adjustment-import states, webhook
 * endpoint and delivery states, and the test/live mode flag.
 */
type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "accent";

const TONE_BY_VALUE: Record<string, Tone> = {
  // Account / generic
  active: "success",
  inactive: "neutral",
  suspended: "danger",
  disabled: "danger",
  // KYC / onboarding
  approved: "success",
  passed: "success",
  rejected: "danger",
  "not passed": "warning",
  under_review: "warning",
  submitted: "info",
  pending: "warning",
  pending_approval: "warning",
  // Credit / import
  posted: "success",
  // Settlement batch / payout
  paid: "success",
  closed: "info",
  open: "warning",
  processing: "info",
  failed: "danger",
  // Webhook deliveries
  succeeded: "success",
  exhausted: "danger",
  // Mode
  live: "accent",
  test: "neutral",
};

export function toneFor(value: string): Tone {
  return TONE_BY_VALUE[value.trim().toLowerCase()] ?? "neutral";
}

export function StatusPill({
  value,
  tone,
  label,
}: {
  value: string;
  /** Override the derived tone when the caller knows better. */
  tone?: Tone;
  /** Override the shown text (defaults to `value`). */
  label?: string;
}) {
  const resolved = tone ?? toneFor(value);
  return <span className={`admin-pill is-${resolved}`}>{label ?? value}</span>;
}
