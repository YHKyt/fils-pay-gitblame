import { formatBhd, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// Signed amounts are normal here: refund timeline events carry a negative
// amountFils (transaction_events' sign convention) and a reconciliation gap
// can be negative, so a negative must render ("-1.500 BHD"), not throw.
export function bhd(amountFils: number): string {
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/** {@link bhd} with thousands separators (`136,518.147 BHD`) for on-screen
 *  display. `bhd` itself stays ungrouped for exports and existing callers. */
export function bhdDisplay(amountFils: number): string {
  return groupThousands(bhd(amountFils).replace(/ BHD$/, "")) + " BHD";
}

/** Adds thousands separators to the whole-dinar part of a formatted
 *  amount (`136518.147` becomes `136,518.147`). Pure string work on the
 *  output of `formatBhd`, so the money value itself is never re-derived. */
export function groupThousands(formatted: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(formatted);
  if (!match) return formatted;
  const [, sign, whole, frac = ""] = match;
  return `${sign}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A plain calendar date (`2026-10-29`, already a Bahrain business day) as
 *  `29 Oct 2026`. String work only, no zone conversion. */
export function humanDate(date: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? "");
  if (!match) return dash(date);
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/** An instant as `31 Aug 2026, 00:30` in Asia/Bahrain time. */
export function humanDateTime(iso: string | null | undefined): string {
  const part = bahrainParts(iso);
  if (!part) return "—";
  return `${humanDate(`${part.year}-${part.month}-${part.day}`)}, ${part.hour}:${part.minute}`;
}

/** First 8 characters of a UUID, upper-cased, for a human-scale reference
 *  (`#3F2A91C0`). The full id stays available as secondary text. */
export function shortId(id: string): string {
  return `#${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

const EVENT_LABELS: Record<string, string> = {
  authorized: "Authorized",
  captured: "Captured",
  partially_captured: "Partial capture",
  voided: "Voided",
  refund_partial: "Partial refund",
  refunded: "Refunded in full",
  chargeback: "Chargeback",
};
/** A transaction timeline event type as a readable label. */
export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? statusLabel(eventType);
}

const ACTOR_LABELS: Record<string, string> = {
  merchant_session: "Dashboard user",
  merchant_api_key: "API key",
  system: "System",
};
/** Who caused a timeline event, in words (the raw id stays secondary). */
export function actorLabel(actorType: string): string {
  return ACTOR_LABELS[actorType] ?? statusLabel(actorType);
}

/** Who caused a timeline event as one labelled line: `Dashboard user ·
 *  #97BA2AB3`, `API key · #1C0FFEE2`, or `System` (system events never show
 *  an id). An id is never shown bare without its actor kind. */
export function actorDisplay(actorType: string, actorId: string | null | undefined): string {
  const label = actorLabel(actorType);
  if (actorType === "system" || !actorId) return label;
  return `${label} · ${shortId(actorId)}`;
}

/** A long opaque reference (`acq_<uuid>`) shortened in the middle for display:
 *  the prefix up to and including the first `_`, an ellipsis, and the last
 *  `tail` characters (`acq_…3a8cf0d`). Short values come back unchanged. The
 *  full value must stay available (title / copy) wherever this is used. */
export function truncateMiddle(value: string, tail = 7): string {
  const underscore = value.indexOf("_");
  const prefix = underscore >= 0 && underscore < 12 ? value.slice(0, underscore + 1) : value.slice(0, 4);
  if (value.length <= prefix.length + tail + 1) return value;
  return `${prefix}…${value.slice(-tail)}`;
}

/** Sets the browser tab title for a dashboard or checkout page. */
export function pageTitle(name: string): string {
  return `${name} · FilsPay`;
}

/** A machine status (`partially_refunded`) as a readable label
 *  (`Partly refunded`). Presentation only — the raw value still drives the
 *  status pill's CSS class, so colours and logic are unchanged. Unknown values
 *  fall back to a de-underscored, capitalised form so nothing shows raw. */
const STATUS_LABELS: Record<string, string> = {
  authorized: "Authorized",
  captured: "Captured",
  partially_captured: "Partly captured",
  voided: "Voided",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  chargeback: "Chargeback",
  pending: "Pending",
  processing: "Processing",
  active: "Active",
  paid: "Paid",
  expired: "Expired",
  canceled: "Canceled",
  closed: "Closed",
  open: "Open",
  reserved: "Reserved",
  disabled: "Disabled",
  exhausted: "Used up",
  failed: "Failed",
  succeeded: "Delivered",
};
export function statusLabel(status: string): string {
  const known = STATUS_LABELS[status];
  if (known) return known;
  const spaced = status.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

const BAHRAIN_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Bahrain",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Asia/Bahrain is a fixed UTC+3 (no DST since 1972) — the same fixed-offset
 *  technique apps/api uses for its business-day windows. */
const BAHRAIN_UTC_OFFSET = "+03:00";

function bahrainParts(iso: string | null | undefined): Record<string, string> | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(BAHRAIN_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
}

/** An instant as Asia/Bahrain wall time, `2026-10-29 12:00:05`, regardless
 *  of the viewer's browser zone — the business timezone every dashboard
 *  date (and every settlement business day) is expressed in. */
export function dateTime(iso: string | null | undefined): string {
  const part = bahrainParts(iso);
  if (!part) return "—";
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
}

/** Time of day only, in Asia/Bahrain: `12:00:05`. */
export function bahrainTime(iso: string | null | undefined): string {
  const part = bahrainParts(iso);
  if (!part) return "—";
  return `${part.hour}:${part.minute}:${part.second}`;
}

/** {@link dateTime}, labelled for customer-facing receipts:
 *  `2026-10-29 12:00:05 (Bahrain time)`. */
export function bahrainDateTime(iso: string | null | undefined): string {
  const formatted = dateTime(iso);
  return formatted === "—" ? formatted : `${formatted} (Bahrain time)`;
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the ISO instant of that
 * day's Asia/Bahrain midnight — what the `from`/`to` transaction filters
 * take. A "day" is the Bahrain business day (ARCHITECTURE §3, ADR-0003),
 * so `from=2026-10-29` starts at 2026-10-28T21:00:00.000Z, and `to` (the
 * endpoint's exclusive bound) is the same instant of that later day.
 */
export function dayStartIso(dateValue: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return undefined;
  const instant = new Date(`${dateValue}T00:00:00.000${BAHRAIN_UTC_OFFSET}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/**
 * A `<input type="datetime-local">` value (wall time, no zone) as an ISO
 * 8601 instant, reading the wall time as Asia/Bahrain — the zone the form
 * labels it with — never the browser's own zone.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value)) return null;
  const parsed = new Date(`${value}${BAHRAIN_UTC_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
