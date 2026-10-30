/**
 * Regression (judgeprep JP2): apps/settlement refuses some requests on
 * their merits — RecalculateMDR on a batch whose linked events do not add
 * up to its gross is answered 409 `batch_events_incomplete`; a run-batch
 * for a day still running is 422 `business_day_not_over`. The client turned
 * every non-2xx into 500 `settlement_run_failed`, so the admin saw a
 * server error for a refusal and no reason.
 *
 * A coded 4xx from settlement now reaches the admin as the same status with
 * settlement's own `{ error, message }`. Still 500 `settlement_run_failed`:
 * any 5xx, a 401/403 (the API's own service token was refused, not the
 * admin's request), and a 4xx without a coded JSON body (an unknown route,
 * i.e. a deployment mismatch).
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
import { triggerMdrRecalculation, triggerSettlementRunBatch } from "./settlementClient.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("settlementClient.passthrough4xx.test.ts requires DATABASE_URL (run `npm run migrate` first)");
}

const refusal = {
  error: "batch_events_incomplete",
  message:
    "settlement: RecalculateMDR: batch's linked events do not add up to its gross: batch 317d557d-0000-4000-8000-000000000000 (2026-08-31) gross 7326913 fils, linked events 0 fils",
};

let answer: { status: number; contentType: string; body: string } = {
  status: 409,
  contentType: "application/json",
  body: JSON.stringify(refusal),
};

const fake = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(answer.status, { "content-type": answer.contentType });
    res.end(answer.body);
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

function answerWith(status: number, body: unknown, contentType = "application/json"): void {
  answer = { status, contentType, body: typeof body === "string" ? body : JSON.stringify(body) };
}

async function caught(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof AppError, `expected an AppError, got ${String(err)}`);
  return err;
}

const mdrInput = { merchantId: randomUUID(), from: "2026-08-01", to: "2026-09-01" };

test("client: settlement's 409 refusal of an MDR recalculation is a 409 with its code and reason", async () => {
  answerWith(409, refusal);
  const err = await caught(triggerMdrRecalculation(config, mdrInput));
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, "batch_events_incomplete");
  assert.equal(err.message, refusal.message);
});

test("client: settlement's 422 on run-batch is a 422 with its code", async () => {
  answerWith(422, { error: "business_day_not_over", message: "business day 2026-10-30 has not ended" });
  const err = await caught(triggerSettlementRunBatch(config, { date: "2026-10-30" }));
  assert.equal(err.statusCode, 422);
  assert.equal(err.code, "business_day_not_over");
  assert.equal(err.message, "business day 2026-10-30 has not ended");
});

test("client: a 4xx with only an error code uses the code as the message", async () => {
  answerWith(400, { error: "invalid_merchant_id" });
  const err = await caught(triggerMdrRecalculation(config, mdrInput));
  assert.equal(err.statusCode, 400);
  assert.equal(err.code, "invalid_merchant_id");
  assert.equal(err.message, "invalid_merchant_id");
});

test("client: 5xx, a refused service token and an uncoded 4xx stay 500 settlement_run_failed", async () => {
  const cases: Array<[number, unknown, string?]> = [
    [500, { error: "recalculate_mdr_failed" }],
    [503, "upstream down", "text/plain"],
    [401, { error: "unauthorized" }],
    [403, { error: "forbidden" }],
    [404, "404 page not found\n", "text/plain; charset=utf-8"],
    [409, { message: "no code" }],
  ];
  for (const [status, body, contentType] of cases) {
    answerWith(status, body, contentType);
    const err = await caught(triggerMdrRecalculation(config, mdrInput));
    assert.equal(err.statusCode, 500, `settlement ${status}`);
    assert.equal(err.code, "settlement_run_failed", `settlement ${status}`);
  }
});

function parseCookie(header: string | string[] | undefined, name: string): string {
  for (const h of Array.isArray(header) ? header : [header]) {
    if (h && h.startsWith(`${name}=`)) return h.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

async function signedInFinanceAdmin(): Promise<{ id: string; cookie: string }> {
  const password = "admin-test-password-9000!";
  const email = `passthrough-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, 'finance') RETURNING id`,
    [email, await hashPassword(password, config), `passthrough ${randomUUID().slice(0, 8)}`],
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

test("route: the admin's MDR recalculation answers the refusal as 409 { error, message }, audited as failed", async () => {
  answerWith(409, refusal);
  const admin = await signedInFinanceAdmin();
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${mdrInput.merchantId}/mdr-recalculation`,
    headers: { cookie: admin.cookie },
    payload: { from: mdrInput.from, to: mdrInput.to },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(res.json(), refusal);

  const audit = await pool.query<{ outcome: string; metadata: { error?: string } }>(
    `SELECT outcome, metadata FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'mdr_recalculation'`,
    [admin.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.outcome, "failed");
  assert.equal(audit.rows[0]!.metadata.error, "batch_events_incomplete");
});

test("route: a settlement 500 is still a 500 settlement_run_failed", async () => {
  answerWith(500, { error: "recalculate_mdr_failed" });
  const admin = await signedInFinanceAdmin();
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${mdrInput.merchantId}/mdr-recalculation`,
    headers: { cookie: admin.cookie },
    payload: { from: mdrInput.from, to: mdrInput.to },
  });
  assert.equal(res.statusCode, 500, res.body);
  assert.equal(res.json().error, "settlement_run_failed");
});
