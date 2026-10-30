/** Asia/Bahrain is fixed UTC+3 (no DST). */
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * How long after Asia/Bahrain midnight a day may be closed by hand. A
 * capture stamped 23:59:59.999 can still be committing after midnight; a
 * close that starts in that gap misses it, and a closed day is never
 * re-scanned. Matches BusinessDayCloseGrace in apps/settlement.
 */
export const BUSINESS_DAY_CLOSE_GRACE_MS = 2 * 60 * 1000;

/** The latest Asia/Bahrain business date (YYYY-MM-DD) that may be closed at `nowMs`. */
export function latestClosableBusinessDate(nowMs: number): string {
  const day = 24 * 60 * 60 * 1000;
  return new Date(nowMs + BAHRAIN_OFFSET_MS - BUSINESS_DAY_CLOSE_GRACE_MS - day).toISOString().slice(0, 10);
}
