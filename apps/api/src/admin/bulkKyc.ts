import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { recordKycReviewInTx } from "../onboarding/review.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  /** The acting admin's email — the review row's reviewer_identifier, as for a single review. */
  adminEmail: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * @property skippedMerchantIds Requested ids that were not approved: not under_review
 * (already approved, rejected, submitted) or naming no merchant at all.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
  skippedMerchantIds: string[];
}

/**
 * Approves every requested merchant that is currently under_review, through
 * the same recordKycReviewInTx path a single review uses — so each one gets
 * its own merchant_kyc_reviews row naming the acting admin — plus one batch
 * audit row, all in one transaction.
 */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  const requestedIds = [...new Set(input.merchantIds)];
  return withTransaction(pool, async (client) => {
    // Lock the eligible rows first so a concurrent review can't change their
    // status between this check and the review write below.
    const eligible = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[])
          AND onboarding_status = 'under_review'
        ORDER BY id
          FOR UPDATE`,
      [requestedIds],
    );
    const eligibleIds = new Set(eligible.rows.map((row) => row.id));
    const approvedMerchantIds = requestedIds.filter((id) => eligibleIds.has(id));
    const skippedMerchantIds = requestedIds.filter((id) => !eligibleIds.has(id));

    for (const merchantId of approvedMerchantIds) {
      await recordKycReviewInTx(client, {
        merchantId,
        outcome: "approved",
        reviewerIdentifier: input.adminEmail,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        skippedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds, skippedMerchantIds };
  });
}
