/**
 * Date display helpers for the console. Every date an operator sees or
 * enters is Asia/Bahrain (UTC+3) — the business timezone settlement batches
 * and reports are keyed on (ARCHITECTURE §3, ADR-0003) — never the
 * browser's own zone. Bahrain has observed no DST since 1972, so a fixed
 * +03:00 offset is exact; apps/api uses the same technique.
 */

const BAHRAIN_UTC_OFFSET = "+03:00";
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

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

function bahrainParts(iso: string | Date | null | undefined): Record<string, string> | null {
  if (!iso) return null;
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Object.fromEntries(BAHRAIN_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
}

/** `2026-10-29 12:00:05` in Asia/Bahrain; `fallback` for null/invalid. */
export function dateTime(iso: string | null | undefined, fallback = "-"): string {
  const part = bahrainParts(iso);
  if (!part) return fallback;
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}:${part.second}`;
}

/** `2026-10-29`, the Asia/Bahrain calendar date of an instant. */
export function date(iso: string | null | undefined, fallback = "-"): string {
  const part = bahrainParts(iso);
  return part ? `${part.year}-${part.month}-${part.day}` : fallback;
}

/** `12:00:05` in Asia/Bahrain. */
export function time(iso: string | null | undefined, fallback = "-"): string {
  const part = bahrainParts(iso);
  return part ? `${part.hour}:${part.minute}:${part.second}` : fallback;
}

/** Today's Asia/Bahrain business date shifted by `offsetDays`, as the
 *  YYYY-MM-DD an `<input type="date">` takes (`-1` is yesterday). */
export function bahrainDate(offsetDays = 0, now: number = Date.now()): string {
  return new Date(now + BAHRAIN_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** An instant as the `YYYY-MM-DDTHH:mm` Bahrain wall time an
 *  `<input type="datetime-local">` takes. */
export function toBahrainInputValue(instant: Date): string {
  return new Date(instant.getTime() + BAHRAIN_OFFSET_MS).toISOString().slice(0, 16);
}

/** A `datetime-local` value read as Bahrain wall time, as an ISO instant;
 *  null if it is not a valid value. */
export function bahrainInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value)) return null;
  const parsed = new Date(`${value}${BAHRAIN_UTC_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
