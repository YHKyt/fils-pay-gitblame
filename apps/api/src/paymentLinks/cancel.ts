import type { Pool } from "pg";
import { voidOtherLinkAuthorizations } from "./pay.js";

export type CancelPaymentLinkResult =
  | { outcome: "canceled" }
  | { outcome: "not_found" }
  | { outcome: "not_cancelable"; status: string };

/**
 * Cancels an active payment link by id. A 'reserved' row whose reservation
 * has lapsed (older than the reservation timeout) counts as active: the pay
 * endpoint reclaims such a row and the public read already reports it as
 * 'active', so refusing the merchant's cancel there left a link they could
 * not stop but a customer could still pay. A live reservation (a payment in
 * flight) stays non-cancelable.
 */
export async function cancelPaymentLink(
  pool: Pool,
  input: { id: string; merchantId: string; reservationTimeoutSeconds: number },
): Promise<CancelPaymentLinkResult> {
  // merchant_id predicate is the authz boundary: without it any merchant
  // could cancel another merchant's link by id (IDOR).
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE payment_links
        SET status = 'canceled', canceled_at = now(), reserved_at = NULL
      WHERE id = $1 AND merchant_id = $2
        AND (status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($3 || ' seconds')::interval))
      RETURNING id`,
    [input.id, input.merchantId, input.reservationTimeoutSeconds],
  );
  if (updateResult.rows[0]) {
    // An attempt whose capture met an acquirer error kept its authorization
    // for a retry that can no longer happen: release it.
    await voidOtherLinkAuthorizations(pool, { id: input.id, merchantId: input.merchantId }, null);
    return { outcome: "canceled" };
  }

  // YA: second read is just for the error shape, no race. fine
  const lookupResult = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1 AND merchant_id = $2`,
    [input.id, input.merchantId],
  );
  const row = lookupResult.rows[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  return { outcome: "not_cancelable", status: row.status };
}
