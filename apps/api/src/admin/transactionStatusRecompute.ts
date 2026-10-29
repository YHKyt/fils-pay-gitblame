import type { PoolClient } from "pg";
import { toFils } from "@filspay/money";
import { nextStatusAfterRefund } from "../payments/refundState.js";

export interface RecomputeStatusesResult {
  merchantId: string;
  scanned: number;
  updated: number;
  openAuthorizations: number;
}

/** BIGINT columns arrive as text and are converted with toFils. */
interface CandidateRow {
  id: string;
  status: string;
  amount_fils: string;
  captured_fils: string;
  refunded_fils: string;
}

/** Backfill transaction statuses from amounts for one merchant. */
export async function recomputeTransactionStatusesForMerchant(
  client: PoolClient,
  merchantId: string,
): Promise<RecomputeStatusesResult> {
  const candidates = await client.query<CandidateRow>(
    `SELECT id, status, amount_fils, captured_fils, refunded_fils
       FROM transactions
      -- chargeback is not derivable from the amounts; recomputing it would
      -- silently erase a dispute back to captured/refunded. Neither is
      -- refunded: rows refunded before 0043 added refunded_fils carry 0
      -- there, so recomputing turned them back into captured, after which
      -- they could be captured or refunded a second time.
      WHERE merchant_id = $1 AND status NOT IN ('authorized', 'voided', 'chargeback', 'refunded')
      FOR UPDATE`,
    [merchantId],
  );

  let updated = 0;
  let openAuthorizations = 0;

  for (const row of candidates.rows) {
    const next = nextStatusAfterRefund({
      amountFils: toFils(Number(row.amount_fils)),
      capturedFils: toFils(Number(row.captured_fils)),
      refundedTotalFils: toFils(Number(row.refunded_fils)),
    });
    if (next !== row.status) {
      await client.query(`UPDATE transactions SET status = $2 WHERE id = $1`, [row.id, next]);
      updated += 1;
    }
    if (row.status === "authorized") openAuthorizations += 1;
  }

  return { merchantId, scanned: candidates.rows.length, updated, openAuthorizations };
}
