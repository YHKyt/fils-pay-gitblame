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
