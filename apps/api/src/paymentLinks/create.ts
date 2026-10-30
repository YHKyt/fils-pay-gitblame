import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";
import { randomFromAlphabet } from "../lib/random.js";
import { serializePaymentLink, type PaymentLinkDto, type PaymentLinkRow } from "./serialize.js";

const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 22-char URL-safe token for payment link URLs. */
function randomPlinkToken(): string {
  return randomFromAlphabet(TOKEN_ALPHABET, 22);
}

export interface CreatePaymentLinkInput {
  merchantId: string;
  amountFils: number;
  reference?: string | null;
  description?: string | null;
  expiresAt: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/**
 * `POST /v1/merchants/:merchantId/payment-links` business logic. Single
 * `INSERT`, no transaction needed — one statement. Every validation
 * failure is a real `AppError` subclass, never an unguarded `toFils()`
 * `RangeError` escaping into a `500`.
 */
export async function createPaymentLink(
  pool: Pool,
  config: { checkoutBaseUrl: string },
  input: CreatePaymentLinkInput,
): Promise<PaymentLinkDto> {
  let amountFils;
  try {
    amountFils = toFils(input.amountFils);
  } catch (err) {
    throw new BadRequestError("invalid_amount", err instanceof Error ? err.message : String(err));
  }
  // payment_links.amount_fils has CHECK (amount_fils > 0); toFils accepts 0.
  if (amountFils <= 0) {
    throw new BadRequestError("invalid_amount", "amountFils must be a positive integer number of fils");
  }

  // JSON bodies are not schema-checked: an array or object here was stored
  // as a Postgres array literal / JSON text and shown as the link's reference.
  for (const field of ["reference", "description"] as const) {
    const value: unknown = input[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new BadRequestError("invalid_request", `${field} must be a string`);
    }
  }
  // new Date(["2027-01-01"]) parses too; only an ISO 8601 string is accepted.
  const expiresAtDate = new Date(typeof input.expiresAt === "string" ? input.expiresAt : Number.NaN);
  if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
    throw new BadRequestError("invalid_expiry", "expiresAt must be a valid ISO 8601 date strictly in the future");
  }

  const token = `plink_${randomPlinkToken()}`;

  const result = await pool.query<PaymentLinkRow>(
    `INSERT INTO payment_links
        (merchant_id, token, amount_fils, reference, description, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.merchantId,
      token,
      amountFils,
      input.reference ?? null,
      input.description ?? null,
      expiresAtDate,
      input.createdByType,
      input.createdById,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createPaymentLink: insert into payment_links returned no row");
  }

  return serializePaymentLink(row, config.checkoutBaseUrl);
}
