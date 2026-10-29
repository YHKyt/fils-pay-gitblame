import { BadRequestError } from "./errors.js";

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

/** An optional non-negative integer from the query string (e.g. `limit`). */
export function parseOptionalNonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) {
    throw new BadRequestError("invalid_request", `${name} must be a non-negative integer`);
  }
  return Number(value);
}
