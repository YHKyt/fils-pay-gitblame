// BHD has 3 decimals (ADR-0001): 1 BD = 1000 fils. These expectations used
// to encode the 2-decimal ("cents") parse — 4.75 -> 475 — i.e. the 10x
// CSV-import bug finance reported (Evidence 02). Corrected to real fils.
/**
 * Route-level tests for the admin "Import adjustments" tool, via
 * `app.inject(...)` against a real, migrated Postgres (run `npm run migrate`
 * first).
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
    "adminAdjustmentImport.test.ts requires DATABASE_URL to point at a real, migrated Postgres",
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

async function signedInAdmin(role: AdminRole): Promise<{ id: string; cookie: string }> {
  cachedAdminPasswordHash ??= await hashPassword(ADMIN_PASSWORD, config);
  const email = `adj-import-route-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedAdminPasswordHash, `Test ${role}`, role],
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
  return { id: inserted.rows[0]!.id, cookie: parseCookie(verifyRes.headers["set-cookie"], config.adminCookieName) };
}

async function createMerchant(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`Adj Import Route ${randomUUID()}`],
  );
  return merchant.rows[0]!.id;
}

const PATH = "/v1/admin/adjustment-imports";

test("a valid CSV upload returns 201 and applies every row", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},4.75,statement correction\n${merchantId},1.25,rounding\n`,
      originalFilename: "march-corrections.csv",
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  const body = res.json() as { importId: string; rowCount: number; totalPostedFils: number };
  assert.equal(body.rowCount, 2);
  assert.equal(body.totalPostedFils, 6000);

  const rows = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM adjustment_import_rows WHERE adjustment_import_id = $1`,
    [body.importId],
  );
  assert.equal(Number(rows.rows[0]!.n), 2);
});

test("an unauthenticated upload is a 401", async () => {
  const merchantId = await createMerchant();
  const res = await app.inject({
    method: "POST",
    url: PATH,
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},1.00,x\n` },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test("a support admin cannot upload", async () => {
  const admin = await signedInAdmin("support");
  const merchantId = await createMerchant();
  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},1.00,x\n` },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("a missing or empty csvContent is a 400", async () => {
  const admin = await signedInAdmin("finance");
  for (const payload of [{}, { csvContent: "" }, { csvContent: "   " }, { csvContent: 42 }]) {
    const res = await app.inject({
      method: "POST",
      url: PATH,
      headers: { cookie: admin.cookie },
      payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.body}`);
  }
});

test("a header-only CSV is a 400", async () => {
  const admin = await signedInAdmin("finance");
  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: "merchantId,amount,reason\n" },
  });
  assert.equal(res.statusCode, 400, res.body);
});

test("a row whose merchantId is not a UUID is a 400 and applies nothing", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},1.00,ok\nnot-a-uuid,2.00,bad\n`,
    },
  });
  assert.equal(res.statusCode, 400, res.body);

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(legs.rows[0]!.n), 0, "validation must run before anything is posted");
});

/** "Malformed" = non-numeric. Trailing garbage after a number (e.g. "4.75abc") is accepted by the parser. */
test("a malformed amount is a 400 and rolls the whole import back", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const res = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},1.00,ok\n${merchantId},abc,bad\n`,
    },
  });
  assert.equal(res.statusCode, 400, res.body);

  const legs = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(Number(legs.rows[0]!.n), 0);
});

test("the import history lists past uploads and is readable by any admin role", async () => {
  const finance = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: finance.cookie },
    payload: {
      csvContent: `merchantId,amount,reason\n${merchantId},9.99,history\n`,
      originalFilename: "history.csv",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const importId = (created.json() as { importId: string }).importId;

  const support = await signedInAdmin("support");
  const listed = await app.inject({
    method: "GET",
    url: `${PATH}?limit=50`,
    headers: { cookie: support.cookie },
  });
  assert.equal(listed.statusCode, 200, listed.body);

  const items = (listed.json() as { items: Array<{ id: string; originalFilename: string }> }).items;
  const match = items.find((item) => item.id === importId);
  assert.ok(match, "the new import must appear in the history");
  assert.equal(match.originalFilename, "history.csv");
});

// 4.75 -> 475 here. matches the README money section (1250 fils = 12.50 BD) — FH
// MK: BD has 3 decimals?? 4.75 BD is 4750 fils
// am: the import format is 2dp by agreement with finance. fine
test("per-row detail shows the raw text next to the parsed integer", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: admin.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},4.750,detail\n` },
  });
  const importId = (created.json() as { importId: string }).importId;

  const res = await app.inject({
    method: "GET",
    url: `${PATH}/${importId}/rows`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);

  const rows = (res.json() as { rows: Array<Record<string, unknown>> }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rawAmountText, "4.750");
  assert.equal(rows[0]!.merchantId, merchantId);
  assert.equal(rows[0]!.reason, "detail");
});

test("per-row detail for an unknown import is a 404", async () => {
  const admin = await signedInAdmin("finance");
  for (const id of ["not-a-uuid", randomUUID()]) {
    const res = await app.inject({
      method: "GET",
      url: `${PATH}/${id}/rows`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(res.statusCode, 404, `${id} -> ${res.body}`);
  }
});

test("reading the import history requires a session", async () => {
  const res = await app.inject({ method: "GET", url: PATH });
  assert.equal(res.statusCode, 401, res.body);
});

async function ledgerAndCache(merchantId: string): Promise<{ legs: number; netPayable: number; cached: number | null }> {
  const ledger = await pool.query<{ legs: number; net: string }>(
    `SELECT COUNT(*)::int AS legs,
            COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)
                     FILTER (WHERE account_id = 'merchant_payable'), 0)::text AS net
       FROM ledger_entries WHERE merchant_id = $1`,
    [merchantId],
  );
  const cache = await pool.query<{ cached_payable_fils: string }>(
    `SELECT cached_payable_fils::text AS cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  return {
    legs: ledger.rows[0]!.legs,
    netPayable: Number(ledger.rows[0]!.net),
    cached: cache.rows[0] ? Number(cache.rows[0].cached_payable_fils) : null,
  };
}

test("uploading the same CSV twice is an idempotent 200 replay: nothing posts twice", async () => {
  const finance = await signedInAdmin("finance");
  const otherFinance = await signedInAdmin("finance");
  const merchantId = await createMerchant();
  const csvContent = `merchantId,amount,reason\n${merchantId},4.750,statement correction\n${merchantId},1.25,rounding\n`;

  const first = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: finance.cookie },
    payload: { csvContent, originalFilename: "march.csv" },
  });
  assert.equal(first.statusCode, 201, first.body);
  const firstImportId = (first.json() as { importId: string }).importId;
  const afterFirst = await ledgerAndCache(merchantId);
  assert.deepEqual(afterFirst, { legs: 4, netPayable: 6000, cached: 6000 });

  // The same file again, the same rows re-exported (other order, other
  // spelling of the amount, other filename), and the same file from another
  // finance admin: all are the one batch that is already posted. Each returns
  // the original import with 200 instead of a permanent 409, and posts
  // nothing.
  const replays = [
    { cookie: finance.cookie, csvContent, originalFilename: "march.csv" },
    {
      cookie: finance.cookie,
      csvContent: `merchantId,amount,reason\r\n${merchantId},1.250,rounding\r\n${merchantId},4.75,statement correction\r\n`,
      originalFilename: "march (1).csv",
    },
    { cookie: otherFinance.cookie, csvContent, originalFilename: "march.csv" },
  ];
  for (const replay of replays) {
    const res = await app.inject({
      method: "POST",
      url: PATH,
      headers: { cookie: replay.cookie },
      payload: { csvContent: replay.csvContent, originalFilename: replay.originalFilename },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { importId: string; status: string; replayed: boolean };
    assert.equal(body.replayed, true);
    assert.equal(body.importId, firstImportId, "a replay returns the original import");
    assert.equal(body.status, "posted");
  }

  assert.deepEqual(await ledgerAndCache(merchantId), afterFirst, "a replay must post nothing");
  const imports = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT adjustment_import_id)::int AS n FROM adjustment_import_rows WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(imports.rows[0]!.n, 1, "a replay must leave no import behind");
});

test("an over-threshold import waits for a different admin's approval before anything posts", async () => {
  const uploader = await signedInAdmin("finance");
  const approver = await signedInAdmin("finance");
  const merchantId = await createMerchant();

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: uploader.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},1000000.000,big correction\n` },
  });
  assert.equal(created.statusCode, 201, created.body);
  const result = created.json() as { importId: string; status: string; requiresApproval: boolean };
  assert.equal(result.status, "pending_approval");
  assert.equal(result.requiresApproval, true);
  assert.deepEqual(await ledgerAndCache(merchantId), { legs: 0, netPayable: 0, cached: null });

  // The uploader cannot be their own second approver.
  const self = await app.inject({
    method: "POST",
    url: `${PATH}/${result.importId}/approve`,
    headers: { cookie: uploader.cookie },
  });
  assert.equal(self.statusCode, 409, self.body);
  assert.equal((self.json() as { error: string }).error, "self_approval_forbidden");
  assert.deepEqual(await ledgerAndCache(merchantId), { legs: 0, netPayable: 0, cached: null });

  // While it is pending, the same file re-uploaded returns the pending import
  // (200 replay), not a second queued batch and not a permanent 409.
  const queuedAgain = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: approver.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${merchantId},1000000,big correction\n` },
  });
  assert.equal(queuedAgain.statusCode, 200, queuedAgain.body);
  const queuedBody = queuedAgain.json() as { importId: string; status: string; replayed: boolean };
  assert.equal(queuedBody.replayed, true);
  assert.equal(queuedBody.importId, result.importId);
  assert.equal(queuedBody.status, "pending_approval");

  const approved = await app.inject({
    method: "POST",
    url: `${PATH}/${result.importId}/approve`,
    headers: { cookie: approver.cookie },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal((approved.json() as { status: string }).status, "posted");
  assert.deepEqual(await ledgerAndCache(merchantId), { legs: 2, netPayable: 1_000_000_000, cached: 1_000_000_000 });

  const again = await app.inject({
    method: "POST",
    url: `${PATH}/${result.importId}/approve`,
    headers: { cookie: approver.cookie },
  });
  assert.equal(again.statusCode, 409, again.body);
  assert.deepEqual(await ledgerAndCache(merchantId), { legs: 2, netPayable: 1_000_000_000, cached: 1_000_000_000 });

  const record = await pool.query<{ approved_by_admin_user_id: string; status: string }>(
    `SELECT approved_by_admin_user_id, status FROM adjustment_imports WHERE id = $1`,
    [result.importId],
  );
  assert.deepEqual(record.rows[0], { approved_by_admin_user_id: approver.id, status: "posted" });
});

test("many small rows that add up past the threshold are held too", async () => {
  const finance = await signedInAdmin("finance");
  const merchantId = await createMerchant();
  const rows = Array.from({ length: 3 }, (_, i) => `${merchantId},20.000,part ${i}`).join("\n");

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: finance.cookie },
    payload: { csvContent: `merchantId,amount,reason\n${rows}\n` },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((created.json() as { status: string }).status, "pending_approval");
  assert.deepEqual(await ledgerAndCache(merchantId), { legs: 0, netPayable: 0, cached: null });
});

test("a rejected import posts nothing, cannot be approved, and the file can be uploaded again", async () => {
  const uploader = await signedInAdmin("finance");
  const reviewer = await signedInAdmin("super_admin");
  const merchantId = await createMerchant();
  const csvContent = `merchantId,amount,reason\n${merchantId},-75.000,reversal\n`;

  const created = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: uploader.cookie },
    payload: { csvContent },
  });
  assert.equal(created.statusCode, 201, created.body);
  const importId = (created.json() as { importId: string }).importId;

  const support = await signedInAdmin("support");
  const supportApprove = await app.inject({
    method: "POST",
    url: `${PATH}/${importId}/approve`,
    headers: { cookie: support.cookie },
  });
  assert.equal(supportApprove.statusCode, 403, supportApprove.body);

  const rejected = await app.inject({
    method: "POST",
    url: `${PATH}/${importId}/reject`,
    headers: { cookie: reviewer.cookie },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal((rejected.json() as { status: string }).status, "rejected");

  const approveAfter = await app.inject({
    method: "POST",
    url: `${PATH}/${importId}/approve`,
    headers: { cookie: reviewer.cookie },
  });
  assert.equal(approveAfter.statusCode, 409, approveAfter.body);
  assert.deepEqual(await ledgerAndCache(merchantId), { legs: 0, netPayable: 0, cached: null });

  const reuploaded = await app.inject({
    method: "POST",
    url: PATH,
    headers: { cookie: uploader.cookie },
    payload: { csvContent },
  });
  assert.equal(reuploaded.statusCode, 201, reuploaded.body);
  assert.equal((reuploaded.json() as { status: string }).status, "pending_approval");
});

test("approving or rejecting an unknown import is a 404", async () => {
  const finance = await signedInAdmin("finance");
  for (const id of ["not-a-uuid", randomUUID()]) {
    for (const action of ["approve", "reject"]) {
      const res = await app.inject({
        method: "POST",
        url: `${PATH}/${id}/${action}`,
        headers: { cookie: finance.cookie },
      });
      assert.equal(res.statusCode, 404, `${action} ${id} -> ${res.body}`);
    }
  }
});
