import { parseBhdToFils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/**
 * Parses a promotional discount amount (BD string from the merchant
 * pricing dashboard) into fils for the ledger adjustment.
 */
export function parsePromotionalDiscountFils(raw: string): number {
  // BHD is 3 decimals (1 BD = 1000 fils). The previous code used
  // `parseFloat(raw)` (a banned float on money) and `* 100` (cents), so a
  // discount of "4.75" BD became 475 fils instead of 4750 — 10x too small,
  // and floating point could corrupt the third decimal. Use the canonical
  // integer-only parser and keep the non-negative guard.
  let fils: number;
  try {
    fils = parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
  if (fils < 0) {
    throw new BadRequestError("invalid_discount", `could not parse discount amount "${raw}"`);
  }
  return fils;
}

