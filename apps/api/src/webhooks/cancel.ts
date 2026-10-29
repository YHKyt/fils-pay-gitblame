import type { Pool } from "pg";

/** "deleted" also when the endpoint had deliveries; those rows are kept, still linked to the endpoint. */
export type DeleteWebhookEndpointResult = "deleted" | "not_found";

/**
 * `DELETE /v1/merchants/:merchantId/webhook-endpoints/:id` business logic.
 * The statement carries the merchant-scoped predicate, never `id` alone.
 *
 * A soft delete (0080): the row is kept, disabled and stamped `deleted_at`,
 * because webhook_deliveries (and delivery archives) reference it and the
 * delivery log is a durable audit trail. A deleted endpoint is hidden from
 * list/get/update, cannot be re-enabled, and is never sent to (the
 * dispatcher only sends to active endpoints). `PATCH .../status: 'disabled'`
 * (update.ts) remains the reversible "pause" tool.
 */
export async function deleteWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<DeleteWebhookEndpointResult> {
  const result = await pool.query<{ id: string }>(
    `UPDATE webhook_endpoints
        SET status = 'disabled', deleted_at = now(), updated_at = now()
      WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [input.id, input.merchantId],
  );
  return result.rows[0] ? "deleted" : "not_found";
}
