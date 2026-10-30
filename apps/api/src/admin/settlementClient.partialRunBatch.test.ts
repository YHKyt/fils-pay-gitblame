/**
 * Regression: a run-batch that fails for one merchant still closes and pays
 * the others. apps/settlement now answers that with a 500 whose body carries
 * the partial report (`merchantResults`) next to `error`/`message`. The
 * client used to turn any non-2xx into `settlement_run_failed` with the
 * first 500 characters of the raw body as the message, so on a real day
 * (more than a handful of merchants) the admin saw a cut-off JSON fragment
 * and could not tell who had been paid.
 *
 * The answer stays a 500 `settlement_run_failed`; the message must name
 * every merchant that was paid, with its batch and net, and the failure.
 *
 * Route level: real Postgres (DATABASE_URL), real settlement client, a
 * `node:http` server standing in for apps/settlement.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { AppError } from "../lib/errors.js";
import { triggerSettlementRunBatch } from "./settlementClient.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("settlementClient.partialRunBatch.test.ts requires DATABASE_URL (run `npm run migrate` first)");
}

const paid = Array.from({ length: 12 }, (_, i) => ({
  merchantId: randomUUID(),
  batchId: randomUUID(),
  alreadyClosed: false,
  alreadyPaid: false,
  grossFils: 10000 + i,
  feeFils: 250,
  netPayoutFils: 9750 + i,
}));
const failure =
  "settlement: RunDailyBatch: PayoutSplitBatch(6f1c0b9e-0000-4000-8000-000000000000): split weights total 5000, want 10000";

const fake = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: "run_batch_failed", message: failure, businessDate: "2026-09-09", merchantResults: paid }),
    );
  });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

const config = {
  ...loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    OTP_DEV_EXPOSE: "true",
    SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  }),
  settlementInternalUrl: fakeUrl,
};
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

function assertNamesEveryPaidMerchant(message: string): void {
  for (const row of paid) {
    assert.ok(message.includes(row.merchantId), `message does not name paid merchant ${row.merchantId}: ${message}`);
    assert.ok(message.includes(row.batchId), `message does not name batch ${row.batchId}: ${message}`);
    assert.ok(message.includes(`${row.netPayoutFils} fils`), `message lacks net ${row.netPayoutFils}: ${message}`);
  }
  assert.ok(message.includes(failure), `message does not carry the failure: ${message}`);
}

test("client: a partial run-batch failure is still settlement_run_failed, and its message lists who was paid", async () => {
  const err = await triggerSettlementRunBatch(config, { date: "2026-09-09" }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 500);
  assert.equal(err.code, "settlement_run_failed");
  assertNamesEveryPaidMerchant(err.message);
});

function parseCookie(header: string | string[] | undefined, name: string): string {
  for (const h of Array.isArray(header) ? header : [header]) {
    if (h && h.startsWith(`${name}=`)) return h.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInFinanceAdmin(): Promise<{ id: string; cookie: string }> {
  const password = "admin-test-password-9000!";
  const email = `partial-run-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, 'finance') RETURNING id`,
    [email, await hashPassword(password, config), `partial-run ${randomUUID().slice(0, 8)}`],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: parseCookie(login.headers["set-cookie"], config.adminCookieName) },
    payload: { code: (login.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return { id: inserted.rows[0]!.id, cookie: parseCookie(verify.headers["set-cookie"], config.adminCookieName) };
}

test("route: the admin's run-batch answer and audit row name the merchants that were paid", async () => {
  const admin = await signedInFinanceAdmin();
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/settlement/run-batch",
    headers: { cookie: admin.cookie },
    payload: { date: "2026-09-09" },
  });
  assert.equal(res.statusCode, 500, res.body);
  const body = res.json() as { error: string; message: string };
  assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
  assert.equal(body.error, "settlement_run_failed");
  assertNamesEveryPaidMerchant(body.message);

  const audit = await pool.query<{ outcome: string; metadata: { message?: string } }>(
    `SELECT outcome, metadata FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'settlement_run_batch'`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.outcome, "failed");
  assertNamesEveryPaidMerchant(audit.rows[0]!.metadata.message ?? "");
});
