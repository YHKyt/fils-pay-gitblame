/**
 * Payment-link creation validates the amount as integer fils > 0 and answers
 * 400, never a 500 from the database CHECK. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { AppError } from "../lib/errors.js";
import { createPaymentLink } from "./create.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("createAmount.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });

after(async () => {
  await pool.end();
});

for (const amountFils of [0, -1, 4.75]) {
  test(`amountFils ${amountFils} is a 400 invalid_amount`, async () => {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`Link Amount Test ${randomUUID()}`],
    );
    await assert.rejects(
      createPaymentLink(pool, { checkoutBaseUrl: "https://pay.example" }, {
        merchantId: m.rows[0]!.id,
        amountFils,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdByType: "merchant_session",
        createdById: randomUUID(),
      }),
      (err: unknown) => err instanceof AppError && err.statusCode === 400 && err.code === "invalid_amount",
    );
  });
}
