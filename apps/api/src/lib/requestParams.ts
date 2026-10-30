import { toFils, type Fils } from "@filspay/money";
import { BadRequestError } from "./errors.js";

/** Largest single amount the API accepts: 10,000,000.000 BD. Any safe
 *  integer used to be accepted, and a merchant's sums (balances, summaries)
 *  then passed Number.MAX_SAFE_INTEGER and were reported off by a fil. At
 *  this cap it takes 900,000 maximum-size payments to reach that range. */
export const MAX_AMOUNT_FILS = 10_000_000_000;

/** True for a JSON number that is a whole number of fils in 1..MAX_AMOUNT_FILS. */
export function isAcceptedAmountFils(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT_FILS;
}

/** A request-body amount: a JSON number that is a positive safe integer of
 *  fils, at most MAX_AMOUNT_FILS. Anything else (string, float, NaN, zero,
 *  negative, too large) is 400 invalid_amount, raised before any acquirer call. */
export function parsePositiveAmountFils(value: unknown): Fils {
  if (!isAcceptedAmountFils(value)) {
    throw new BadRequestError(
      "invalid_amount",
      `amountFils must be a positive integer number of fils, at most ${MAX_AMOUNT_FILS}`,
    );
  }
  return toFils(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not UUID-shaped can never name a row: 400 invalid_id
 *  before it reaches Postgres (where it would raise 22P02). */
export function requireUuidParam(value: string, name = "id"): string {
  if (!UUID_RE.test(value)) {
    throw new BadRequestError("invalid_id", `${name} must be a UUID`);
  }
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** An optional ISO-8601 instant from the query string. An unparseable value
 *  is a 400, never an Invalid Date passed on to SQL. */
export function parseOptionalInstant(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError("invalid_request", `${name} must be an ISO-8601 date-time`);
  }
  return date;
}

/** An optional positive integer from the query string (e.g. `limit`). Zero
 *  is refused like a negative: `limit=0` used to be clamped to one row. */
export function parseOptionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value) || Number(value) === 0) {
    throw new BadRequestError("invalid_request", `${name} must be a positive integer`);
  }
  return Number(value);
}
