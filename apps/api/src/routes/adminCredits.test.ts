/**
 * Route-level tests for the manual-credits plane, via `app.inject(...)`
 * against a real, migrated Postgres — no mocking of the DB layer. Requires
 * DATABASE_URL to point at one (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "adminCredits.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

// ---------------------------------------------------------------- helpers

type AdminRole = "support" | "finance" | "super_admin";

const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedAdminPasswordHash: string | null = null;

function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) {
      return header.split(";")[0] as string;
    }
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

/** Every fixture admin gets its own display name: real operators are
 *  distinct people, and a shared name across fixtures would make these tests
 *  depend on each other. */
async function signedInAdmin(role: AdminRole, label: string) {
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const suffix = randomUUID();
  const email = `${label}-${suffix}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `${label} ${suffix.slice(0, 8)}`, role],
  );

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const loginBody = loginRes.json() as { devOtpCode?: string };
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);
  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: loginBody.devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);

  // OTP verify rotates the session token; the authenticated cookie is the one it sets.
  return { id: inserted.rows[0]!.id, email, cookie: parseCookie(verifyRes.headers["set-cookie"], config.adminCookieName) };
}

async function createMerchant(label: string, mdrBps = 250): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Credits Test ${label} ${randomUUID()}`, mdrBps],
  );
  return result.rows[0]!.id;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface CreditRequestBody {
  id: string;
  status: string;
  requiresApproval: boolean;
  baseAmountFils: number;
  feeReversalFils: number;
  postedAmountFils: number;
  ledgerEntryGroupId: string | null;
}

async function issueCredit(
  cookie: string,
  merchantId: string,
  payload: Record<string, unknown>,
): Promise<CreditRequestBody> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/credits`,
    headers: { cookie },
    payload: { reasonCode: "goodwill", effectiveDate: todayIso(), ...payload },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as CreditRequestBody;
}

// ------------------------------------------------------------- auth gating

test("every credits route rejects an unauthenticated caller", async () => {
  const merchantId = await createMerchant("noauth");
  const routes: Array<["GET" | "POST", string]> = [
    ["GET", "/v1/admin/credits"],
    ["POST", `/v1/admin/merchants/${merchantId}/credits`],
    ["POST", `/v1/admin/credits/${randomUUID()}/approve`],
    ["POST", `/v1/admin/credits/${randomUUID()}/reject`],
  ];
  for (const [method, url] of routes) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url} -> ${res.body}`);
  }
});

// create isn't in this test, only approve/reject. intentional? — am
test("a support admin is 403'd on approve and reject — the decision that moves money", async () => {
  const finance = await signedInAdmin("finance", "gate-maker");
  const support = await signedInAdmin("support", "gate-checker");
  const merchantId = await createMerchant("gate");

  const pending = await issueCredit(finance.cookie, merchantId, { baseAmountFils: 120_000 });
  assert.equal(pending.status, "pending_approval");

  for (const action of ["approve", "reject"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/credits/${pending.id}/${action}`,
      headers: { cookie: support.cookie },
      payload: {},
    });
    assert.equal(res.statusCode, 403, `${action} -> ${res.body}`);
    assert.equal(res.json().error, "forbidden");
  }

  // ...and nothing moved as a side effect of either attempt.
  const row = await pool.query<{ status: string }>(
    `SELECT status FROM credit_requests WHERE id = $1`,
    [pending.id],
  );
  assert.equal(row.rows[0]!.status, "pending_approval");
});

test("a support admin CAN read the credits queue — it is a read, like the merchant list", async () => {
  const support = await signedInAdmin("support", "queue-read");
  const res = await app.inject({
    method: "GET",
    url: "/v1/admin/credits?status=pending_approval",
    headers: { cookie: support.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
});

// ------------------------------------------------------------ create route

// ADMIN.md: support may "issue small credits". The console shows support the
// Issue credit form on that basis; a large one is held for finance.
test("a support admin issues a small credit (posts) and a large one (held for finance approval)", async () => {
  const support = await signedInAdmin("support", "create-support");
  const merchantId = await createMerchant("create-support");

  const small = await issueCredit(support.cookie, merchantId, { baseAmountFils: 10_000 });
  assert.equal(small.status, "posted");
  assert.notEqual(small.ledgerEntryGroupId, null);

  const large = await issueCredit(support.cookie, merchantId, { baseAmountFils: 120_000 });
  assert.equal(large.status, "pending_approval");
  assert.equal(large.ledgerEntryGroupId, null);
});

test("a finance admin issues a below-threshold credit and it posts immediately", async () => {
  const finance = await signedInAdmin("finance", "create-small");
  const merchantId = await createMerchant("create-small");

  const record = await issueCredit(finance.cookie, merchantId, {
    baseAmountFils: 10_000,
    memo: "goodwill for the outage",
  });
  assert.equal(record.requiresApproval, false);
  assert.equal(record.status, "posted");
  assert.equal(record.feeReversalFils, 0);
  assert.equal(record.postedAmountFils, 10_000);
  assert.ok(record.ledgerEntryGroupId);

  const audit = await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = 'credit_request_created' AND target_id = $2`,
    [finance.id, record.id],
  );
  assert.equal(audit.rowCount, 1, "exactly one audit row per action");
  assert.equal(audit.rows[0]!.metadata.posted, true);
  assert.equal(audit.rows[0]!.metadata.postedAmountFils, 10_000);
});

/** Threshold is compared against the posted total (base + fee reversal), so 50000 base is above it. */
test("an above-threshold credit waits for a second approver and journals nothing yet", async () => {
  const finance = await signedInAdmin("finance", "create-big");
  const merchantId = await createMerchant("create-big");

  const record = await issueCredit(finance.cookie, merchantId, { baseAmountFils: 120_000 });
  assert.equal(record.requiresApproval, true);
  assert.equal(record.status, "pending_approval");
  assert.equal(record.ledgerEntryGroupId, null);

  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0, "nothing may be journaled before the second signature");
  const balance = await pool.query(`SELECT 1 FROM merchant_balances WHERE merchant_id = $1`, [
    merchantId,
  ]);
  assert.equal(balance.rowCount, 0);
});

test("create validates its body and 404s an unknown or malformed merchant", async () => {
  const finance = await signedInAdmin("finance", "create-bad");
  const merchantId = await createMerchant("create-bad");

  for (const payload of [
    {},
    { baseAmountFils: 0, reasonCode: "goodwill", effectiveDate: todayIso() },
    { baseAmountFils: 1_000, reasonCode: "nope", effectiveDate: todayIso() },
    { baseAmountFils: 1_000, reasonCode: "goodwill", effectiveDate: "2026-02-30" },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/credits`,
      headers: { cookie: finance.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }

  for (const id of [randomUUID(), "not-a-uuid"]) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${id}/credits`,
      headers: { cookie: finance.cookie },
      payload: { baseAmountFils: 1_000, reasonCode: "goodwill", effectiveDate: todayIso() },
    });
    assert.equal(res.statusCode, 404, `${id} -> ${res.body}`);
  }
});

// ------------------------------------------------------------ idempotency

async function creditTrail(merchantId: string): Promise<{ requests: number; groups: number; cached: number | null }> {
  const requests = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM credit_requests WHERE merchant_id = $1`,
    [merchantId],
  );
  const groups = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT entry_group_id)::int AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  const cache = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils::text AS cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  return {
    requests: requests.rows[0]!.n,
    groups: groups.rows[0]!.n,
    cached: cache.rows[0] ? Number(cache.rows[0].cached_payable_fils) : null,
  };
}

test("a retried credit with the same Idempotency-Key posts once and replays the first response", async () => {
  const finance = await signedInAdmin("finance", "idem-retry");
  const merchantId = await createMerchant("idem-retry");
  const key = randomUUID();
  const payload = { baseAmountFils: 40_000, reasonCode: "goodwill", effectiveDate: todayIso() };

  const send = () =>
    app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/credits`,
      headers: { cookie: finance.cookie, "idempotency-key": key },
      payload,
    });

  const first = await send();
  assert.equal(first.statusCode, 201, first.body);
  // The operator's browser timed out and they pressed the button again.
  const retry = await send();
  assert.equal(retry.statusCode, 201, retry.body);
  assert.deepEqual(retry.json(), first.json(), "the retry replays the first response");

  assert.deepEqual(await creditTrail(merchantId), { requests: 1, groups: 1, cached: 40_000 });
  const audit = await pool.query(
    `SELECT 1 FROM admin_audit_log WHERE action = 'credit_request_created' AND target_id = $1`,
    [(first.json() as CreditRequestBody).id],
  );
  assert.equal(audit.rowCount, 1, "a replay is not a second action");
});

test("two concurrent credits with the same Idempotency-Key post once", async () => {
  const finance = await signedInAdmin("finance", "idem-race");
  const merchantId = await createMerchant("idem-race");
  const key = randomUUID();
  const send = () =>
    app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/credits`,
      headers: { cookie: finance.cookie, "idempotency-key": key },
      payload: { baseAmountFils: 40_000, reasonCode: "goodwill", effectiveDate: todayIso() },
    });

  const [a, b] = await Promise.all([send(), send()]);
  assert.equal(a.statusCode, 201, a.body);
  assert.equal(b.statusCode, 201, b.body);
  assert.equal((a.json() as CreditRequestBody).id, (b.json() as CreditRequestBody).id);
  assert.deepEqual(await creditTrail(merchantId), { requests: 1, groups: 1, cached: 40_000 });
});

test("a key reused for another amount is a 422, a key is private to its admin, and a bad key is a 400", async () => {
  const finance = await signedInAdmin("finance", "idem-misuse");
  const merchantId = await createMerchant("idem-misuse");
  const payload = { baseAmountFils: 40_000, reasonCode: "goodwill", effectiveDate: todayIso() };
  const key = randomUUID();
  const send = (cookie: string, idempotencyKey: string, body: object) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/credits`,
      headers: { cookie, "idempotency-key": idempotencyKey },
      payload: body,
    });

  const first = await send(finance.cookie, key, payload);
  assert.equal(first.statusCode, 201, first.body);
  const reused = await send(finance.cookie, key, { ...payload, baseAmountFils: 41_000 });
  assert.equal(reused.statusCode, 422, reused.body);
  assert.equal((reused.json() as { error: string }).error, "idempotency_key_reused");
  assert.deepEqual(await creditTrail(merchantId), { requests: 1, groups: 1, cached: 40_000 });

  // Another admin's request with the same key is its own action, never a
  // replay of (or a collision with) someone else's.
  const other = await signedInAdmin("finance", "idem-misuse-2");
  const otherRes = await send(other.cookie, key, payload);
  assert.equal(otherRes.statusCode, 201, otherRes.body);
  assert.notEqual((otherRes.json() as CreditRequestBody).id, (first.json() as CreditRequestBody).id);
  assert.deepEqual(await creditTrail(merchantId), { requests: 2, groups: 2, cached: 80_000 });

  const tooLong = await send(finance.cookie, "k".repeat(256), payload);
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  assert.equal((tooLong.json() as { error: string }).error, "invalid_idempotency_key");
  assert.deepEqual(await creditTrail(merchantId), { requests: 2, groups: 2, cached: 80_000 });
});

// ----------------------------------------------------------- approve/reject

test("a second finance admin approves a pending credit; approving it again is a 409", async () => {
  const maker = await signedInAdmin("finance", "approve-maker");
  const checker = await signedInAdmin("finance", "approve-checker");
  const merchantId = await createMerchant("approve");

  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });

  const first = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: checker.cookie },
    payload: {},
  });
  assert.equal(first.statusCode, 200, first.body);
  const approved = first.json() as CreditRequestBody & { approvedByAdminUserId: string | null };
  assert.equal(approved.status, "posted");
  assert.equal(approved.approvedByAdminUserId, checker.id);
  assert.ok(approved.ledgerEntryGroupId);

  const second = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: checker.cookie },
    payload: {},
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, "credit_request_not_pending");

  const groups = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT entry_group_id)::text AS count FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(groups.rows[0]!.count, "1", "a second approval must not journal a second time");
});

test("the requester cannot approve their own credit, even after changing their display name", async () => {
  const maker = await signedInAdmin("finance", "self-approve");
  const merchantId = await createMerchant("self-approve");

  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });

  const direct = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: maker.cookie },
    payload: {},
  });
  assert.equal(direct.statusCode, 409, direct.body);
  assert.equal(direct.json().error, "self_approval_forbidden");

  // The request row snapshots the requester's display name; renaming the
  // account must not turn the requester into a "different" approver.
  await pool.query(`UPDATE admin_users SET display_name = $2 WHERE id = $1`, [maker.id, `renamed ${randomUUID()}`]);
  const renamed = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: maker.cookie },
    payload: {},
  });
  assert.equal(renamed.statusCode, 409, renamed.body);
  assert.equal(renamed.json().error, "self_approval_forbidden");

  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0, "a self-approved credit must never journal");
});

test("a rejected credit journals nothing and can no longer be approved", async () => {
  const maker = await signedInAdmin("finance", "reject-maker");
  const checker = await signedInAdmin("finance", "reject-checker");
  const merchantId = await createMerchant("reject");

  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });

  const rejected = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/reject`,
    headers: { cookie: checker.cookie },
    payload: { reason: "not supported by the dispute file" },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal((rejected.json() as CreditRequestBody).status, "rejected");

  const legs = await pool.query(`SELECT 1 FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  assert.equal(legs.rowCount, 0);

  const approveAfter = await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${pending.id}/approve`,
    headers: { cookie: checker.cookie },
    payload: {},
  });
  assert.equal(approveAfter.statusCode, 409, approveAfter.body);
  assert.equal(approveAfter.json().error, "credit_request_not_pending");

  const audit = await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM admin_audit_log
      WHERE admin_user_id = $1 AND action = 'credit_request_rejected' AND target_id = $2`,
    [checker.id, pending.id],
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0]!.metadata.reason, "not supported by the dispute file");
});

test("approving or rejecting an unknown or malformed credit request is a 404", async () => {
  const finance = await signedInAdmin("finance", "approve-404");
  for (const id of [randomUUID(), "not-a-uuid"]) {
    for (const action of ["approve", "reject"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/admin/credits/${id}/${action}`,
        headers: { cookie: finance.cookie },
        payload: {},
      });
      assert.equal(res.statusCode, 404, `${action} ${id} -> ${res.body}`);
    }
  }
});

// -------------------------------------------------------------- list route

test("GET /v1/admin/credits filters by merchant and round-trips its keyset cursor", async () => {
  const finance = await signedInAdmin("finance", "list");
  const merchantId = await createMerchant("list");

  // Three rows written back-to-back, which is exactly when a
  // millisecond-truncated cursor starts skipping rows.
  const created: string[] = [];
  for (let i = 0; i < 3; i++) {
    created.push((await issueCredit(finance.cookie, merchantId, { baseAmountFils: 1_000 + i })).id);
  }

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const url: string = `/v1/admin/credits?merchantId=${merchantId}&limit=1${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const res = await app.inject({ method: "GET", url, headers: { cookie: finance.cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    for (const item of body.items) seen.push(item.id);
    cursor = body.nextCursor;
    if (!cursor) break;
  }

  assert.equal(seen.length, 3, "every row must appear exactly once across the pages");
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual([...seen].sort(), [...created].sort());
});

test("GET /v1/admin/credits filters by status", async () => {
  const maker = await signedInAdmin("finance", "list-status-maker");
  const checker = await signedInAdmin("finance", "list-status-checker");
  const merchantId = await createMerchant("list-status");

  const posted = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 5_000 });
  const pending = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 120_000 });
  const toReject = await issueCredit(maker.cookie, merchantId, { baseAmountFils: 130_000 });
  await app.inject({
    method: "POST",
    url: `/v1/admin/credits/${toReject.id}/reject`,
    headers: { cookie: checker.cookie },
    payload: {},
  });

  for (const [status, expected] of [
    ["posted", posted.id],
    ["pending_approval", pending.id],
    ["rejected", toReject.id],
  ] as Array<[string, string]>) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/credits?merchantId=${merchantId}&status=${status}`,
      headers: { cookie: maker.cookie },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { items: Array<{ id: string; status: string }> };
    assert.deepEqual(
      body.items.map((i) => i.id),
      [expected],
      `status=${status}`,
    );
  }
});
