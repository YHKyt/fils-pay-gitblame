import type { Pool } from "pg";

/** No secret material of any kind. */
export interface WebhookEndpointSummary {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookEndpointRow {
  id: string;
  url: string;
  secret_prefix: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function toSummary(row: WebhookEndpointRow): WebhookEndpointSummary {
  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `GET /v1/merchants/:merchantId/webhook-endpoints` business logic. Never
 * returns secret_ciphertext or the decrypted secret —
 * secretPrefix is the only credential-adjacent field returned after
 * creation.
 */
// MK: never selects secret_ciphertext. keep it that way
export async function listWebhookEndpoints(pool: Pool, merchantId: string): Promise<WebhookEndpointSummary[]> {
  const result = await pool.query<WebhookEndpointRow>(
    `SELECT id, url, secret_prefix, status, created_at, updated_at
       FROM webhook_endpoints
      WHERE merchant_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [merchantId],
  );
  return result.rows.map(toSummary);
}

/**
 * Merchant-scoped single-endpoint lookup, used by routes that need an
 * existence/ownership check before running a further query scoped to this
 * endpoint (e.g. the deliveries list).
 */
export async function getWebhookEndpoint(
  pool: Pool,
  input: { merchantId: string; id: string },
): Promise<WebhookEndpointSummary | null> {
  const result = await pool.query<WebhookEndpointRow>(
    `SELECT id, url, secret_prefix, status, created_at, updated_at
       FROM webhook_endpoints
      WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL`,
    [input.id, input.merchantId],
  );
  const row = result.rows[0];
  return row ? toSummary(row) : null;
}
