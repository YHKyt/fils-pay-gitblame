import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";

/**
 * Operational record of a payout-rail instruction for a settlement batch.
 * At most one per batch: the dispatcher calls this once per delivery ROW
 * (one per webhook endpoint), again if the send throws before attempt_count
 * moves, and from any replica — each of which used to insert another
 * instruction, i.e. pay the merchant twice. Serialized per batch with an
 * advisory lock and skipped if an instruction already exists.
 */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  await withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('payout_disbursement:' || $1))`, [settlementBatchId]);
    await client.query(
      `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
       SELECT $1, $2, 'disb_' || gen_random_uuid()
        WHERE NOT EXISTS (SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1)`,
      [settlementBatchId, amountFils],
    );
  });
}
