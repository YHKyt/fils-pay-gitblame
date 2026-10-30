#!/usr/bin/env node
// Black-box HTTP suite for a running FilsPay API (local compose or hosted).
// Talks to the API over HTTP only; the one optional exception is OTP
// retrieval (see "OTP" below). Exits non-zero when any check fails.
//
// Usage: BASE_URL=https://<host> node ops/e2e/judge-suite.mjs
// See ops/e2e/README.md for every environment variable.

import { randomUUID, randomBytes, createHash, createHmac } from "node:crypto";
import { createInterface } from "node:readline/promises";

const env = process.env;
const BASE_URL = (env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const WEB_URL = env.WEB_URL?.replace(/\/+$/, "");
const ADMIN_URL = env.ADMIN_URL?.replace(/\/+$/, "");
const ADMIN_EMAIL = env.ADMIN_EMAIL ?? "finance@filspay.test";
const ADMIN_PASSWORD = env.ADMIN_PASSWORD ?? "FilsPayAdminSeed!2026";
const MERCHANT_PASSWORD = env.MERCHANT_PASSWORD ?? "FilsPaySeed!2026";
const MERCHANT_A_NAME = env.MERCHANT_A_NAME ?? "Alpha Retail Co";
const MERCHANT_A_EMAIL = env.MERCHANT_A_EMAIL ?? "owner@alpharetail.example";
const MERCHANT_B_NAME = env.MERCHANT_B_NAME ?? "Delta Wholesale Traders";
const MERCHANT_B_EMAIL = env.MERCHANT_B_EMAIL ?? "owner@deltawholesale.example";
const APPROVED_CARD = { pan: env.CARD_PAN ?? "4000000000000010", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const VERBOSE = env.VERBOSE === "1";
const SUPPORT_ADMIN_EMAIL = env.SUPPORT_ADMIN_EMAIL ?? "support@filspay.test";
const TEST_MERCHANT_NAME = env.TEST_MERCHANT_NAME ?? "Gamma Hospitality Group";
// Production only accepts public https webhook URLs. Deliveries to this one
// fail (405), but each attempt is still recorded with its payload and
// signature, which is all the signature check needs.
const WEBHOOK_TEST_URL = env.WEBHOOK_TEST_URL ?? "https://example.com/filspay-judge-suite";
// Only when the operator knows the acquirer secret (local stacks): enables
// the signed-callback half of the FP-201 check.
const ACQUIRER_SECRET = env.ACQUIRER_CALLBACK_SIGNING_SECRET?.split(",")[0]?.trim();

// ---------------------------------------------------------------- reporting
const results = [];
let currentSection = "";
function section(name) {
  currentSection = name;
  console.log(`\n== ${name}`);
}
function check(name, ok, detail) {
  results.push({ section: currentSection, name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && (!ok || VERBOSE) ? `  -- ${fmt(detail)}` : ""}`);
  return Boolean(ok);
}
function skip(name, why) {
  results.push({ section: currentSection, name, ok: null, detail: why });
  console.log(`SKIP  ${name}  -- ${why}`);
}
function fmt(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 400 ? `${s.slice(0, 400)}...` : s;
}
class Abort extends Error {}
function must(name, ok, detail) {
  if (!check(name, ok, detail)) throw new Abort(name);
}

// ------------------------------------------------------------------- http
/** Minimal cookie jar per identity; the API's cookies are Secure on https,
 *  so a jar is kept here instead of relying on fetch. */
function newClient(label) {
  const jar = new Map();
  return {
    label,
    jar,
    bearer: null,
    async req(method, path, { body, headers = {}, bearer, raw } = {}) {
      const h = { accept: "application/json", ...headers };
      if (body !== undefined) h["content-type"] = "application/json";
      if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const token = bearer === undefined ? this.bearer : bearer;
      if (token) h.authorization = `Bearer ${token}`;
      const started = Date.now();
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (v === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) jar.delete(k);
        else jar.set(k, v);
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (VERBOSE) console.log(`  ${label} ${method} ${path} -> ${res.status} (${Date.now() - started} ms)`);
      return { status: res.status, body: json, text: raw ? text : undefined, headers: res.headers };
    },
  };
}
const anon = newClient("anon");

// -------------------------------------------------------------------- OTP
// Production never returns or logs the OTP, so a code is obtained, in order:
//  1. `devOtpCode` in the login response (OTP_DEV_EXPOSE=true, never on a hosted box);
//  2. MERCHANT_OTP / ADMIN_OTP env (a code you read from the real channel);
//  3. DATABASE_URL (local stacks only): the pending challenge row is
//     re-keyed to a fresh random code, which is then submitted over HTTP;
//  4. an interactive prompt when stdin is a TTY.
let pgPool = null;
async function dbPool() {
  if (!env.DATABASE_URL) return null;
  if (!pgPool) {
    const { default: pg } = await import("pg");
    pgPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  }
  return pgPool;
}
async function obtainOtp(kind, loginBody, ident) {
  if (loginBody?.devOtpCode) return { code: loginBody.devOtpCode, via: "devOtpCode" };
  const fromEnv = kind === "admin" ? env.ADMIN_OTP : env.MERCHANT_OTP;
  if (fromEnv) return { code: fromEnv, via: "env" };
  const pool = await dbPool();
  if (pool) {
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(salt + code).digest("hex");
    const sql =
      kind === "admin"
        ? `UPDATE admin_otp_challenges SET code_salt = $1, code_hash = $2
            WHERE id = (SELECT c.id FROM admin_otp_challenges c JOIN admin_users u ON u.id = c.admin_user_id
                         WHERE u.email = $3 AND c.consumed_at IS NULL ORDER BY c.created_at DESC LIMIT 1)`
        : `UPDATE otp_challenges SET code_salt = $1, code_hash = $2
            WHERE id = (SELECT c.id FROM otp_challenges c JOIN merchant_users u ON u.id = c.merchant_user_id
                         WHERE u.email = $3 AND u.merchant_id = $4 AND c.consumed_at IS NULL
                         ORDER BY c.created_at DESC LIMIT 1)`;
    const params = kind === "admin" ? [salt, hash, ident.email] : [salt, hash, ident.email, ident.merchantId];
    const r = await pool.query(sql, params);
    if (r.rowCount === 1) return { code, via: "DATABASE_URL" };
  }
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question(`OTP for ${kind} ${ident.email}: `)).trim();
    rl.close();
    return { code, via: "prompt" };
  }
  return null;
}

async function adminLogin(client, email, password) {
  const login = await client.req("POST", "/v1/admin/auth/login", { body: { email, password } });
  must(`admin login ${email} -> 200 otpRequired`, login.status === 200 && login.body?.otpRequired === true, login);
  const otp = await obtainOtp("admin", login.body, { email });
  must("admin OTP obtained", otp, "set ADMIN_OTP or DATABASE_URL");
  const v = await client.req("POST", "/v1/admin/auth/otp/verify", { body: { code: otp.code } });
  must(`admin otp/verify -> 200 (otp via ${otp.via})`, v.status === 200, v);
}

async function merchantLogin(client, merchantId, email, password) {
  const login = await client.req("POST", "/v1/auth/login", { body: { merchantId, email, password } });
  must(`merchant login ${email} -> 200 otpRequired`, login.status === 200 && login.body?.otpRequired === true, login);
  check("production login response does not leak devOtpCode", !("devOtpCode" in (login.body ?? {})) || env.ALLOW_DEV_OTP === "1", login.body);
  // A pending (password-only) session must not reach authenticated routes.
  const pend = await client.req("GET", "/v1/transactions?limit=1");
  check("pending session (no OTP yet) -> 401 on /v1/transactions", pend.status === 401, pend.status);
  const otp = await obtainOtp("merchant", login.body, { email, merchantId });
  must("merchant OTP obtained", otp, "set MERCHANT_OTP or DATABASE_URL");
  const v = await client.req("POST", "/v1/auth/otp/verify", { body: { code: otp.code } });
  must(`merchant otp/verify -> 200 (otp via ${otp.via})`, v.status === 200 && v.body?.merchantId === merchantId, v);
  const me = await client.req("GET", "/v1/auth/me");
  check("GET /v1/auth/me -> 200 same merchant", me.status === 200 && JSON.stringify(me.body).includes(merchantId), me);
  return otp.code;
}

/** Like adminLogin, but a missing OTP or a refused login skips the caller's
 *  checks instead of aborting the whole run. */
async function tryAdminLogin(client, email, password) {
  const login = await client.req("POST", "/v1/admin/auth/login", { body: { email, password } });
  if (login.status !== 200 || login.body?.otpRequired !== true) return false;
  const otp = await obtainOtp("admin", login.body, { email });
  if (!otp) return false;
  const v = await client.req("POST", "/v1/admin/auth/otp/verify", { body: { code: otp.code } });
  return v.status === 200;
}

// ---------------------------------------------------------------- helpers
const isFils = (v) => typeof v === "number" && Number.isSafeInteger(v);
/** Every key ending in "Fils" (any depth) must be a safe integer (ADR-0001). */
function nonIntegerFils(obj, path = "$", out = []) {
  if (Array.isArray(obj)) obj.forEach((v, i) => nonIntegerFils(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (/fils$/i.test(k) && v !== null && !isFils(v)) out.push(`${path}.${k}=${JSON.stringify(v)}`);
      else nonIntegerFils(v, `${path}.${k}`, out);
    }
  }
  return out;
}
function bahrainDate(offsetDays = 0) {
  return new Date(Date.now() + 3 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}
const idem = () => `e2e-${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createLink(client, merchantId, amountFils, expiresInMs = 3600_000) {
  return client.req("POST", `/v1/merchants/${merchantId}/payment-links`, {
    body: {
      amountFils,
      reference: `e2e-${Date.now()}`,
      description: "judge suite",
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    },
  });
}
/** Creates and pays a link. The simulator fails ~2% of approved-card
 *  attempts at random (ACQUIRER_FAILURE_RATE), so a 402/502 is retried on a
 *  fresh link a few times instead of failing the suite. */
async function paidTransaction(client, merchantId, amountFils) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const link = await createLink(client, merchantId, amountFils);
    if (link.status !== 201) return { link, pay: null };
    const pay = await anon.req("POST", `/v1/payment-links/${link.body.token}/pay`, {
      body: { card: APPROVED_CARD },
      headers: { "idempotency-key": idem() },
    });
    last = { link, pay };
    if (pay.status === 200) return last;
    if (pay.status !== 402 && pay.status !== 502) return last;
  }
  return last;
}
async function refund(client, merchantId, transactionId, amountFils, key = idem()) {
  return client.req("POST", `/v1/merchants/${merchantId}/refunds`, {
    body: amountFils === undefined ? { transactionId } : { transactionId, amountFils },
    headers: { "idempotency-key": key },
  });
}

/** Round-half-even integer division, the rounding packages/money uses. */
function divHalfEven(n, d) {
  const q = Math.floor(n / d);
  const r = n - q * d;
  if (2 * r > d) return q + 1;
  if (2 * r < d) return q;
  return q % 2 === 0 ? q : q + 1;
}
/** Webhook signature check a merchant would run: HMAC-SHA256 over
 *  `${t}.${body}`, header "t=<unix>,v1=<hex>" (webhooks/sign.ts). */
function verifyWebhookSignature(body, header, secret) {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=")));
  if (!parts.t || !parts.v1) return { ok: false, why: "malformed header" };
  const expected = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
  return { ok: expected === parts.v1, t: Number(parts.t), why: expected === parts.v1 ? undefined : "mismatch" };
}
function signAcquirerBody(body, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}
async function adminBalance(admin, merchantId) {
  const r = await admin.req("GET", `/v1/admin/merchants/${merchantId}`);
  return r.body?.balance?.cachedPayableFils;
}
async function dbQuery(sql, params) {
  const pool = await dbPool();
  return pool ? (await pool.query(sql, params)).rows : null;
}
/** Polls an endpoint's deliveries until `pick` finds one (or ~30 s pass). */
async function waitForDelivery(client, merchantId, endpointId, pick) {
  for (let i = 0; i < 30; i++) {
    const list = await client.req("GET", `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}/deliveries?limit=100`);
    const found = (list.body?.deliveries ?? []).filter((d) => d.signature !== undefined || d.id);
    for (const d of found) {
      const detail = await client.req("GET", `/v1/merchants/${merchantId}/webhook-endpoints/${endpointId}/deliveries/${d.id}`);
      if (detail.status === 200 && detail.body?.signature && pick(detail.body)) return detail.body;
    }
    await sleep(1_000);
  }
  return null;
}

/**
 * One black-box check per case-file item (Evidence 01 FP-300 "done when",
 * Evidence 02 finance memo, Evidence 03 incident log and the handwritten
 * list). Each check name starts with the item it covers.
 */
async function caseFileChecks({ admin, a, apiA, apiB, b, mA, mB, rows, txId, amount, aOtpCode }) {
  const today = bahrainDate(0);
  const tomorrow = bahrainDate(1);
  const yesterday = bahrainDate(-1);
  const uniq = Date.now();

  // ------------------------------------------------------------ finance memo
  section("case file: finance memo");

  // Balance cache (FP-203): rebuild, then a journaled CSV adjustment moves the
  // cache incrementally; a second rebuild from the ledger must agree with it.
  const rb1 = await admin.req("POST", "/v1/admin/balances/rebuild");
  check("memo/FP-203 POST /v1/admin/balances/rebuild -> 200", rb1.status === 200, rb1);
  const balBefore = await adminBalance(admin, mA.id);

  // CSV import: "4.755 BD showed 4.750; 4.75 BD showed 0.475".
  const csv = `merchantId,amount,reason\n${mA.id},4.755,judge-${uniq}-a\n${mA.id},4.75,judge-${uniq}-b\n`;
  const imp = await admin.req("POST", "/v1/admin/adjustment-imports", { body: { csvContent: csv, originalFilename: `judge-${uniq}.csv` } });
  check("memo CSV import 4.755 + 4.75 BD -> 201 posted, total 9505 fils", imp.status === 201 && imp.body?.totalPostedFils === 9_505 && imp.body?.status === "posted", imp);
  if (imp.status === 201) {
    const impRows = await admin.req("GET", `/v1/admin/adjustment-imports/${imp.body.importId}/rows`);
    const parsed = (impRows.body?.rows ?? []).map((r) => r.parsedAmountFils);
    check("memo CSV row 4.755 BD -> 4755 fils", parsed[0] === 4_755, impRows.body);
    check("memo CSV row 4.75 BD -> 4750 fils (not 475)", parsed[1] === 4_750, impRows.body);
    const dup = await admin.req("POST", "/v1/admin/adjustment-imports", { body: { csvContent: csv, originalFilename: `judge-${uniq}.csv` } });
    check("memo CSV re-upload of the same file -> 409, posted once", dup.status === 409, dup);
  }
  const badAmount = await admin.req("POST", "/v1/admin/adjustment-imports", {
    body: { csvContent: `merchantId,amount,reason\n${mA.id},4.7555,judge-${uniq}-c\n` },
  });
  check("memo CSV amount with 4 decimals -> 400, nothing posted", badAmount.status === 400, badAmount);
  const balAfter = await adminBalance(admin, mA.id);
  check("memo CSV import moves the cached balance by exactly +9505", isFils(balBefore) && balAfter - balBefore === 9_505, { balBefore, balAfter });
  const rb2 = await admin.req("POST", "/v1/admin/balances/rebuild");
  const changedA = (rb2.body?.changed ?? []).find((c) => c.merchantId === mA.id);
  check("memo/FP-203 rebuild from the ledger agrees with the cache (A unchanged)", rb2.status === 200 && !changedA, changedA ?? rb2.status);

  // Fee shown vs fee charged: 245 bps (backfill) vs 225 bps (in force).
  const detailA = await admin.req("GET", `/v1/admin/merchants/${mA.id}`);
  const shownBps = detailA.body?.currentFeeSchedule?.mdrBps ?? detailA.body?.merchant?.mdrBps;
  const events = await apiA.req("GET", `/v1/transactions/${txId}/events`);
  const capEv = (Array.isArray(events.body) ? events.body : events.body?.events ?? []).find((e) => e.eventType === "captured");
  const chargedFee = capEv?.metadata?.feeFils;
  if (capEv?.metadata?.discountBps) skip("memo fee shown = fee charged", "merchant has a negotiated discount");
  else
    check(
      `memo fee shown (${shownBps} bps) = fee charged on a new capture`,
      isFils(chargedFee) && chargedFee === divHalfEven(amount * shownBps, 10_000),
      { shownBps, chargedFee, amount },
    );

  // MDR recalculation must never change a paid batch.
  const paidBefore = ((await apiA.req("GET", "/v1/settlement/batches?limit=100")).body?.batches ?? []).filter((x) => x.status === "paid");
  const recalc = await admin.req("POST", `/v1/admin/merchants/${mA.id}/mdr-recalculation`, { body: { from: bahrainDate(-120), to: today } });
  check("memo MDR recalculation over seeded history -> 200", recalc.status === 200, recalc);
  if (recalc.status === 200) {
    const paidIds = new Set(paidBefore.map((x) => x.id));
    const touchedPaid = (recalc.body?.adjusted ?? []).filter((x) => paidIds.has(x.batchId ?? x.BatchID ?? x.id));
    check("memo MDR recalculation adjusts no paid batch", touchedPaid.length === 0, touchedPaid);
    const after = new Map(((await apiA.req("GET", "/v1/settlement/batches?limit=100")).body?.batches ?? []).map((x) => [x.id, x]));
    const moved = paidBefore.filter((x) => {
      const y = after.get(x.id);
      return !y || y.feeFils !== x.feeFils || y.netPayoutFils !== x.netPayoutFils || y.status !== "paid";
    });
    check("memo paid batches keep fee and net after MDR recalculation", moved.length === 0, moved.slice(0, 3));
  }

  // Test merchants never settle, whatever admin tool runs.
  const testM = rows.find((m) => (m.displayName ?? m.name) === TEST_MERCHANT_NAME && (m.testMode ?? m.test_mode));
  if (!testM) skip("memo test merchant never settled", `no test-mode merchant named "${TEST_MERCHANT_NAME}"`);
  else {
    const runAll = await admin.req("POST", "/v1/admin/settlement/run-batch", { body: { date: yesterday } });
    check("memo full run-batch for yesterday -> 200", runAll.status === 200, runAll);
    const inRun = (runAll.body?.merchantResults ?? []).filter((r) => JSON.stringify(r).includes(testM.id));
    check("memo full run-batch leaves the test merchant out", inRun.length === 0, inRun);
    const runTest = await admin.req("POST", "/v1/admin/settlement/run-batch", { body: { date: yesterday, merchantId: testM.id } });
    check("memo run-batch for the test merchant settles nothing", runTest.status !== 200 || (runTest.body?.merchantResults ?? []).length === 0, runTest);
    const recalcTest = await admin.req("POST", `/v1/admin/merchants/${testM.id}/mdr-recalculation`, { body: { from: bahrainDate(-120), to: today } });
    check("memo MDR recalculation on the test merchant -> not 5xx", recalcTest.status < 500, recalcTest);
    const tDetail = await admin.req("GET", `/v1/admin/merchants/${testM.id}`);
    const settled = (tDetail.body?.recentSettlementBatches ?? []).filter((x) => x.status !== "open" && x.grossFils !== 0);
    check("memo test merchant has no closed or paid batch with money in it", tDetail.status === 200 && settled.length === 0, settled);
  }

  // Daily close at Bahrain midnight: today's capture belongs to today's
  // Asia/Bahrain business day, and today cannot be closed yet.
  const sumToday = await apiA.req("GET", `/v1/settlement/summary?from=${today}&to=${tomorrow}`);
  check(`memo capture made now counts in Bahrain business day ${today}`, sumToday.status === 200 && sumToday.body?.totalCapturedFils >= amount, sumToday.body);

  // "Login works without entering the OTP code?"
  const o = newClient("otp");
  const ol = await o.req("POST", "/v1/auth/login", { body: { merchantId: mA.id, email: MERCHANT_A_EMAIL, password: MERCHANT_PASSWORD } });
  check("memo login -> 200 otpRequired, no session yet", ol.status === 200 && ol.body?.otpRequired === true, ol);
  for (const p of [`/v1/merchants/${mA.id}/payment-links`, `/v1/merchants/${mA.id}/api-keys`, "/v1/settlement/batches"]) {
    const r = await o.req("GET", p);
    check(`memo password-only session -> 401 on GET ${p}`, r.status === 401, r.status);
  }
  const reuse = await o.req("POST", "/v1/auth/otp/verify", { body: { code: aOtpCode } });
  check("memo OTP: a code already used for an earlier login -> rejected", reuse.status === 401 || reuse.status === 429, reuse);
  // The reused code above already spent one attempt of the challenge's budget.
  const wrong = [];
  for (let i = 0; i < 6; i++) wrong.push((await o.req("POST", "/v1/auth/otp/verify", { body: { code: String(100000 + i) } })).status);
  const after = await o.req("GET", "/v1/transactions?limit=1");
  check(
    "memo OTP: wrong codes -> 401 until the attempt limit, then 429; never a session",
    wrong.every((s) => s === 401 || s === 429) && wrong.includes(429) && after.status === 401,
    { wrong, after: after.status },
  );
  const noPending = await newClient("x").req("POST", "/v1/auth/otp/verify", { body: { code: "123456" } });
  check("memo OTP verify without a pending login -> 401", noPending.status === 401, noPending);

  // "I cancelled merchant B's payment link from merchant A's dashboard."
  const victim = await createLink(apiA, mA.id, 2_500);
  if (victim.status === 201) {
    const c1 = await b.req("DELETE", `/v1/merchants/${mA.id}/payment-links/${victim.body.id}`);
    check("memo B's session cancels A's link via A's path -> 403/404", c1.status === 403 || c1.status === 404, c1.status);
    const c2 = await apiB.req("DELETE", `/v1/merchants/${mB.id}/payment-links/${victim.body.id}`);
    check("memo B's API key cancels A's link via B's path -> 404", c2.status === 404, c2.status);
    const still = await anon.req("GET", `/v1/payment-links/${victim.body.token}`);
    check("memo A's link is still active after B's attempts", still.status === 200 && still.body?.status === "active", still.body);
    const own = await apiA.req("DELETE", `/v1/merchants/${mA.id}/payment-links/${victim.body.id}`);
    check("memo A cancels its own link -> 204", own.status === 204 || own.status === 200, own);
    const payCanceled = await anon.req("POST", `/v1/payment-links/${victim.body.token}/pay`, { body: { card: APPROVED_CARD }, headers: { "idempotency-key": idem() } });
    check("memo paying a canceled link -> 4xx, no charge", payCanceled.status >= 400 && payCanceled.status < 500, payCanceled);
  } else check("setup: link for the cancel check", false, victim);

  // ------------------------------------------------------------ incident log
  section("case file: incident log");

  // INCIDENT 2026-05-14: several buyers on one link at once -> one charge.
  const raceLink = await createLink(apiA, mA.id, 4_200);
  if (raceLink.status === 201) {
    const racers = await Promise.all(
      Array.from({ length: 5 }, () =>
        anon.req("POST", `/v1/payment-links/${raceLink.body.token}/pay`, { body: { card: APPROVED_CARD }, headers: { "idempotency-key": idem() } }),
      ),
    );
    const winners = racers.filter((r) => r.status === 200);
    check("incident 2026-05-14 5 concurrent pays of one link -> exactly one 200", winners.length === 1, racers.map((r) => r.status));
    check("incident 2026-05-14 the losers get 4xx, not 5xx", racers.every((r) => r.status < 500), racers.map((r) => [r.status, r.body?.error]));
    const linkNow = await apiA.req("GET", `/v1/merchants/${mA.id}/payment-links/${raceLink.body.id}`);
    check("incident 2026-05-14 the link records the winning transaction", linkNow.body?.transactionId === winners[0]?.body?.transactionId, linkNow.body);
    const caps = await dbQuery(
      `SELECT count(*)::int AS n FROM transactions t JOIN payment_links pl ON pl.reference = t.reference AND pl.merchant_id = t.merchant_id
        WHERE pl.id = $1 AND t.status IN ('captured','partially_refunded','refunded')`,
      [raceLink.body.id],
    ).catch(() => null);
    if (caps) check("incident 2026-05-14 (DB) one captured transaction for the link", caps[0].n === 1, caps);
  } else check("setup: link for the double-pay race", false, raceLink);

  // FP-201: the acquirer callback is authenticated and idempotent.
  const cbBody = JSON.stringify({
    callbackId: `cb-judge-${uniq}`,
    type: "fraud_review.completed",
    transactionId: txId,
    occurredAt: new Date().toISOString(),
    outcome: "cleared",
    note: "judge suite",
  });
  const cbPost = (headers) =>
    fetch(`${BASE_URL}/v1/acquirer/callbacks`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: cbBody }).then((r) => r.status);
  check("FP-201 unsigned acquirer callback -> 401", (await cbPost({})) === 401);
  check("FP-201 callback with a forged signature -> 401", (await cbPost({ "acquirer-callback-signature": signAcquirerBody(cbBody, "not-the-secret") })) === 401);
  if (ACQUIRER_SECRET) {
    const stale = await cbPost({ "acquirer-callback-signature": signAcquirerBody(cbBody, ACQUIRER_SECRET, Math.floor(Date.now() / 1000) - 3_600) });
    check("FP-201 correctly signed but 1 h old callback -> 401", stale === 401, stale);
    const s1 = await cbPost({ "acquirer-callback-signature": signAcquirerBody(cbBody, ACQUIRER_SECRET) });
    const s2 = await cbPost({ "acquirer-callback-signature": signAcquirerBody(cbBody, ACQUIRER_SECRET) });
    check("FP-201 the same signed callback twice -> 200 both times", s1 === 200 && s2 === 200, [s1, s2]);
    const notes = await dbQuery(`SELECT count(*)::int AS n FROM acquirer_callback_notes WHERE callback_id = $1`, [`cb-judge-${uniq}`]);
    if (notes) check("FP-201 (DB) the redelivered callback saved one note", notes[0].n === 1, notes);
  } else skip("FP-201 signed callback twice -> one note", "set ACQUIRER_CALLBACK_SIGNING_SECRET (local stacks)");

  // FP-240: the webhook signature verifies over the exact body.
  const ep = await a.req("POST", `/v1/merchants/${mA.id}/webhook-endpoints`, { body: { url: WEBHOOK_TEST_URL } });
  const whSecret = ep.body?.secret;
  check("FP-240 create webhook endpoint -> 201 with its secret once", ep.status === 201 && typeof whSecret === "string", ep);

  // ------------------------------------------------------- FP-300 refunds
  section("case file: FP-300 refunds end to end");
  const fp = await paidTransaction(apiA, mA.id, 3_000);
  if (fp.pay?.status === 200 && whSecret) {
    const fTx = fp.pay.body.transactionId;
    const capEvents = (await apiA.req("GET", `/v1/transactions/${fTx}/events`)).body ?? [];
    const fee = (Array.isArray(capEvents) ? capEvents : []).find((e) => e.eventType === "captured")?.metadata?.feeFils;
    const parts = [];
    for (const amt of [1_000, 1_000, 1_000]) parts.push(await refund(apiA, mA.id, fTx, amt));
    check("FP-300 three 1000-fils refunds of 3000 -> 200 each", parts.every((r) => r.status === 200), parts.map((r) => [r.status, r.body?.error]));
    const reversed = parts.map((r) => r.body?.feeReversedFils);
    check("FP-300 first refund reverses the pro-rata fee (half-even)", isFils(fee) && reversed[0] === divHalfEven(fee * 1_000, 3_000), { fee, reversed });
    check("FP-300 fee reversals of a full refund add up to the whole fee", isFils(fee) && reversed.reduce((s, v) => s + v, 0) === fee, { fee, reversed });
    const more = await refund(apiA, mA.id, fTx, 1);
    check("FP-300 refund after a full refund -> 409/422, nothing refunded", more.status === 409 || more.status === 422, more);
    check("FP-300 refund error body uses the uniform { error, message } shape", typeof more.body?.error === "string", more.body);
    const fTxNow = await apiA.req("GET", `/v1/transactions/${fTx}`);
    check("FP-300 transaction is refunded with refundedFils = capturedFils", fTxNow.body?.status === "refunded" && fTxNow.body?.refundedFils === 3_000, fTxNow.body);
    const tl = (await apiA.req("GET", `/v1/transactions/${fTx}/events`)).body ?? [];
    const refundEvents = (Array.isArray(tl) ? tl : []).filter((e) => e.eventType === "refunded" || e.eventType === "refund_partial");
    check(
      "FP-300 timeline: one refund event per refund, amounts sum to -3000",
      refundEvents.length === 3 && refundEvents.reduce((s, e) => s + e.amountFils, 0) === -3_000,
      refundEvents.map((e) => [e.eventType, e.amountFils]),
    );
    const lastRefundId = parts[2]?.body?.id;
    const delivery = await waitForDelivery(a, mA.id, ep.body.id, (d) => d.eventType === "refund.succeeded" && d.payload?.data?.refundId === lastRefundId);
    check("FP-300/FP-240 the shop gets a refund.succeeded webhook", Boolean(delivery), lastRefundId);
    if (delivery) {
      const data = delivery.payload.data;
      check(
        "FP-300 webhook carries the refund amount, fee reversal and new status",
        data.amountFils === 1_000 && data.feeReversedFils === reversed[2] && data.status === "refunded" && data.transactionId === fTx,
        data,
      );
      const v = verifyWebhookSignature(JSON.stringify(delivery.payload), delivery.signature, whSecret);
      check("FP-240 webhook signature verifies over the exact body with the endpoint secret", v.ok, { why: v.why, signature: delivery.signature });
      check("FP-240 signature timestamp is current (within 5 min of the attempt)", v.ok && Math.abs(v.t * 1000 - Date.parse(delivery.lastAttemptedAt ?? delivery.createdAt)) < 300_000, v);
    }
    const rep = await apiA.req("GET", "/v1/reporting/transactions?limit=50");
    const repRow = (Array.isArray(rep.body) ? rep.body : rep.body?.transactions ?? []).find((r) => r.id === fTx);
    check("FP-300 reports: transaction listed as refunded", repRow?.status === "refunded", repRow ?? rep.status);
    let vol;
    for (let i = 0; i < 15; i++) {
      vol = await apiA.req("GET", `/v1/analytics/volumes?from=${today}&to=${tomorrow}`);
      if ((vol.body?.points ?? []).some((p) => p.refundGrossFils >= 3_000)) break;
      await sleep(1_000);
    }
    check("FP-300 reports: today's analytics show the refunds", (vol.body?.points ?? []).some((p) => p.refundCount >= 3 && p.refundGrossFils >= 3_000), vol.body);
    const rec = await apiA.req("GET", `/v1/settlement/reconciliation?from=${today}&to=${tomorrow}`);
    check("FP-300 reconciliation for today explains to zero after refunds and adjustments", rec.status === 200 && rec.body?.explained === true && rec.body?.gapFils === 0, rec.body);
  } else check("setup: paid transaction + webhook endpoint for FP-300", false, fp.pay ?? fp.link);

  // INCIDENT 2026-08-21: one payout notification per payout.
  const disb = await dbQuery(
    `SELECT settlement_batch_id, count(*)::int AS n FROM settlement_payout_disbursements GROUP BY 1 HAVING count(*) > 1`,
  ).catch(() => null);
  if (disb) check("incident 2026-08-21 (DB) at most one payout disbursement per batch", disb.length === 0, disb);
  const paidEvents = await dbQuery(
    `SELECT aggregate_id, count(*)::int AS n FROM outbox_events WHERE event_type = 'settlement.paid' GROUP BY 1 HAVING count(*) > 1`,
  ).catch(() => null);
  if (paidEvents) check("incident 2026-08-21 (DB) at most one settlement.paid event per batch", paidEvents.length === 0, paidEvents);
  if (!disb && !paidEvents) skip("incident 2026-08-21 duplicate payout notifications", "needs DATABASE_URL (no HTTP view of payout events)");

  // ------------------------------------------------------- handwritten list
  section("case file: handwritten list");

  // "can you refund more than what was actually charged?"
  const capOnly = await paidTransaction(apiA, mA.id, 1_500);
  if (capOnly.pay?.status === 200) {
    const over = await refund(apiA, mA.id, capOnly.pay.body.transactionId, 1_501);
    check("note refund of captured + 1 fils -> 422 refund_exceeds_refundable", over.status === 422, over);
    const full = await refund(apiA, mA.id, capOnly.pay.body.transactionId);
    check("note refund without amount refunds exactly the captured amount", full.status === 200 && full.body?.amountFils === 1_500, full.body);
  }

  // "the settlement splits are always a few fils short"
  const splits = await dbQuery(
    `SELECT sb.id, sb.net_payout_fils, SUM(s.allocated_fils)::bigint AS allocated
       FROM settlement_batches sb JOIN settlement_batch_splits s ON s.settlement_batch_id = sb.id
      GROUP BY sb.id, sb.net_payout_fils HAVING SUM(s.allocated_fils) <> sb.net_payout_fils`,
  ).catch(() => null);
  if (splits) check("note (DB) every split batch: child payouts add up to the parent net", splits.length === 0, splits.slice(0, 3));
  else skip("note split payouts add up", "needs DATABASE_URL (splits have no HTTP view)");

  // "some admin actions don't seem to have the right role checks"
  const sup = newClient("support");
  if (await tryAdminLogin(sup, SUPPORT_ADMIN_EMAIL, ADMIN_PASSWORD)) {
    const denied = [
      ["POST", "/v1/admin/settlement/run-batch", { date: yesterday }],
      ["POST", "/v1/admin/balances/rebuild", {}],
      ["POST", "/v1/admin/reporting/rebuild", {}],
      ["POST", "/v1/admin/adjustment-imports", { csvContent: `merchantId,amount,reason\n${mA.id},1.000,judge-${uniq}-s` }],
      ["POST", `/v1/admin/merchants/${mA.id}/mdr-recalculation`, { from: yesterday, to: today }],
      ["POST", `/v1/admin/merchants/${mA.id}/balance-adjustments`, { amountFils: 1, reason: "judge" }],
      // Requesting a credit is open to any admin (maker); approving is not.
      ["POST", `/v1/admin/credits/${randomUUID()}/approve`, {}],
      ["POST", `/v1/admin/adjustment-imports/${randomUUID()}/approve`, {}],
      ["POST", `/v1/admin/merchants/${mA.id}/api-keys/${randomUUID()}/rotate`, {}],
    ];
    for (const [m, p, body] of denied) {
      const r = await sup.req(m, p, { body, headers: { "idempotency-key": idem() } });
      check(`note support admin ${m} ${p} -> 403`, r.status === 403, r);
    }
    const imp2 = await sup.req("POST", `/v1/admin/merchants/${mA.id}/impersonate`);
    if (imp2.status === 201) {
      const w1 = await sup.req("POST", `/v1/merchants/${mA.id}/payment-links`, { body: { amountFils: 1_000, reference: "imp", expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
      check("note impersonation is read-only: create link -> 403", w1.status === 403, w1);
      const w2 = await sup.req("POST", `/v1/merchants/${mA.id}/refunds`, { body: { transactionId: txId, amountFils: 1 }, headers: { "idempotency-key": idem() } });
      check("note impersonation is read-only: refund -> 403", w2.status === 403, w2);
      const w3 = await sup.req("POST", `/v1/merchants/${mA.id}/api-keys`, { body: { label: "imp" } });
      check("note impersonation is read-only: issue API key -> 401/403", w3.status === 403 || w3.status === 401, w3);
      await sup.req("POST", `/v1/admin/impersonation/${imp2.body.grantId}/end`);
    } else check("note support admin can start a read-only impersonation", false, imp2);
  } else skip("note admin role checks", `could not log in ${SUPPORT_ADMIN_EMAIL} (set ADMIN_PASSWORD / DATABASE_URL)`);

  // "there's a key rotation flow that doesn't do what you'd expect"
  const k = await a.req("POST", `/v1/merchants/${mA.id}/api-keys`, { body: { label: `rotate-${uniq}` } });
  if (k.status === 201) {
    const rot = await admin.req("POST", `/v1/admin/merchants/${mA.id}/api-keys/${k.body.id}/rotate`, { body: { label: `rotated-${uniq}` } });
    check("note admin rotates an API key -> 201 new rawKey", rot.status === 201 && typeof rot.body?.rawKey === "string" && rot.body.rawKey !== k.body.rawKey, rot.status);
    const oldUse = await anon.req("GET", "/v1/transactions?limit=1", { bearer: k.body.rawKey });
    check("note the rotated-out key stops working -> 401", oldUse.status === 401, oldUse.status);
    if (rot.status === 201) {
      const newUse = await anon.req("GET", "/v1/transactions?limit=1", { bearer: rot.body.rawKey });
      check("note the new key works -> 200", newUse.status === 200, newUse.status);
      const del = await a.req("DELETE", `/v1/merchants/${mA.id}/api-keys/${rot.body.id}`);
      const afterDel = await anon.req("GET", "/v1/transactions?limit=1", { bearer: rot.body.rawKey });
      check("note a revoked key stops working at once -> 401", (del.status === 204 || del.status === 200) && afterDel.status === 401, [del.status, afterDel.status]);
    }
  }

  // "one of the reporting queries is suspiciously slow"
  for (const p of [
    `/v1/settlement/summary?from=${bahrainDate(-120)}&to=${tomorrow}`,
    "/v1/reporting/transactions?limit=100",
    "/v1/reporting/export-summary",
    `/v1/settlement/reconciliation?from=${bahrainDate(-120)}&to=${tomorrow}`,
    `/v1/analytics/volumes?from=${bahrainDate(-120)}&to=${tomorrow}`,
  ]) {
    const t0 = Date.now();
    const r = await apiA.req("GET", p);
    const ms = Date.now() - t0;
    check(`note GET ${p.split("?")[0]} -> 200 in under 2 s (${ms} ms)`, r.status === 200 && ms < 2_000, { status: r.status, ms });
  }

  // "has anyone tried uploading a really large export?"
  const big = `merchantId,amount,reason\n${`${mA.id},0.001,${"x".repeat(100)}\n`.repeat(120_000)}`;
  const tooBig = await admin.req("POST", "/v1/admin/adjustment-imports", { body: { csvContent: big } });
  check(`note ${Math.round(big.length / 1e6)} MB CSV upload -> 413, not 5xx`, tooBig.status === 413, tooBig.status);
  const exp = await apiA.req("GET", "/v1/transactions/export");
  check("note transaction export -> 200", exp.status === 200, exp.status);
}

// ------------------------------------------------------------------- run
async function main() {
  console.log(`FilsPay judge suite against ${BASE_URL}`);

  section("health");
  const hz = await anon.req("GET", "/healthz");
  must("GET /healthz -> 200 ok", hz.status === 200 && hz.body?.status === "ok", hz);
  const rz = await anon.req("GET", "/readyz");
  must("GET /readyz -> 200 ready", rz.status === 200, rz);

  section("unauthenticated access");
  for (const p of ["/v1/transactions", "/v1/settlement/batches", "/v1/reporting/transactions", "/v1/admin/merchants"]) {
    const r = await anon.req("GET", p);
    check(`GET ${p} without credentials -> 401`, r.status === 401, r.status);
  }
  const badKey = await anon.req("GET", "/v1/transactions", { bearer: "fp_live_not_a_real_key" });
  check("bogus API key -> 401", badKey.status === 401, badKey.status);
  const badLogin = await anon.req("POST", "/v1/auth/login", {
    body: { merchantId: randomUUID(), email: MERCHANT_A_EMAIL, password: "wrong" },
  });
  check("merchant login wrong password -> 401 invalid_credentials", badLogin.status === 401 && badLogin.body?.error === "invalid_credentials", badLogin);

  section("admin login + reads");
  const admin = newClient("admin");
  await adminLogin(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
  const me = await admin.req("GET", "/v1/admin/auth/me");
  check("GET /v1/admin/auth/me -> 200", me.status === 200, me);
  const list = await admin.req("GET", "/v1/admin/merchants?limit=100");
  must("GET /v1/admin/merchants -> 200", list.status === 200, list);
  const rows = list.body?.merchants ?? list.body?.items ?? list.body?.data ?? (Array.isArray(list.body) ? list.body : []);
  const byName = (n) => rows.find((m) => (m.displayName ?? m.display_name ?? m.name) === n);
  const mA = env.MERCHANT_A_ID ? { id: env.MERCHANT_A_ID } : byName(MERCHANT_A_NAME);
  const mB = env.MERCHANT_B_ID ? { id: env.MERCHANT_B_ID } : byName(MERCHANT_B_NAME);
  must(`merchants "${MERCHANT_A_NAME}" and "${MERCHANT_B_NAME}" found`, mA?.id && mB?.id, rows.map((m) => m.displayName ?? m.name));
  const detail = await admin.req("GET", `/v1/admin/merchants/${mA.id}`);
  check("GET /v1/admin/merchants/:id -> 200", detail.status === 200, detail.status);
  check("admin merchant detail: every *Fils field is an integer", nonIntegerFils(detail.body).length === 0, nonIntegerFils(detail.body));
  const notFound = await admin.req("GET", `/v1/admin/merchants/${randomUUID()}`);
  check("admin unknown merchant -> 404", notFound.status === 404, notFound.status);
  const badId = await admin.req("GET", "/v1/admin/merchants/not-a-uuid");
  check("admin non-UUID merchant id -> 404/400, not 500", badId.status === 404 || badId.status === 400, badId.status);

  section("merchant login + API key");
  const a = newClient("A");
  const aOtpCode = await merchantLogin(a, mA.id, MERCHANT_A_EMAIL, MERCHANT_PASSWORD);
  const key = await a.req("POST", `/v1/merchants/${mA.id}/api-keys`, { body: { label: "judge-suite" } });
  must("POST /v1/merchants/:id/api-keys -> 201 rawKey", key.status === 201 && typeof key.body?.rawKey === "string", key.status);
  const keys = await a.req("GET", `/v1/merchants/${mA.id}/api-keys`);
  check("GET api-keys list never returns raw keys", keys.status === 200 && !JSON.stringify(keys.body).includes(key.body.rawKey), keys.status);
  const apiA = newClient("A-key");
  apiA.bearer = key.body.rawKey;
  const txList = await apiA.req("GET", "/v1/transactions?limit=5");
  check("API key works on GET /v1/transactions -> 200", txList.status === 200, txList.status);

  const b = newClient("B");
  await merchantLogin(b, mB.id, MERCHANT_B_EMAIL, MERCHANT_PASSWORD);
  const keyB = await b.req("POST", `/v1/merchants/${mB.id}/api-keys`, { body: { label: "judge-suite" } });
  must("merchant B API key -> 201", keyB.status === 201, keyB.status);
  const apiB = newClient("B-key");
  apiB.bearer = keyB.body.rawKey;

  section("payment link + public checkout");
  const amount = 12_345;
  const link = await createLink(apiA, mA.id, amount);
  must("create payment link (API key) -> 201", link.status === 201 && link.body?.token, link);
  check("link amountFils echoed as integer", link.body.amountFils === amount, link.body);
  const pub = await anon.req("GET", `/v1/payment-links/${link.body.token}`);
  check("public GET /v1/payment-links/:token -> 200", pub.status === 200 && pub.body?.amountFils === amount, pub);
  const noIdem = await anon.req("POST", `/v1/payment-links/${link.body.token}/pay`, { body: { card: APPROVED_CARD } });
  check("pay without Idempotency-Key -> 400", noIdem.status === 400, noIdem);
  const payKey = idem();
  let pay = await anon.req("POST", `/v1/payment-links/${link.body.token}/pay`, {
    body: { card: APPROVED_CARD },
    headers: { "idempotency-key": payKey },
  });
  let paidLink = link;
  if (pay.status === 402 || pay.status === 502) {
    console.log(`  (simulator random failure ${pay.status}, retrying on a fresh link)`);
    ({ link: paidLink, pay } = await paidTransaction(apiA, mA.id, amount));
  }
  must("pay with approved card -> 200 paid", pay.status === 200 && pay.body?.status === "paid" && pay.body?.transactionId, pay);
  const txId = pay.body.transactionId;
  const again = await anon.req("POST", `/v1/payment-links/${paidLink.body.token}/pay`, {
    body: { card: APPROVED_CARD },
    headers: { "idempotency-key": idem() },
  });
  check("pay again (new key) -> 409 payment_link_already_paid", again.status === 409 && again.body?.error === "payment_link_already_paid", again);
  const tx = await apiA.req("GET", `/v1/transactions/${txId}`);
  check("GET /v1/transactions/:id -> 200 captured for the full amount", tx.status === 200 && JSON.stringify(tx.body).includes(String(amount)), tx);
  check("transaction: every *Fils field is an integer", nonIntegerFils(tx.body).length === 0, nonIntegerFils(tx.body));
  const pubPaid = await anon.req("GET", `/v1/payment-links/${paidLink.body.token}`);
  check("public link after pay shows paid", pubPaid.status === 200 && pubPaid.body?.status === "paid", pubPaid.body);

  section("expired link");
  const shortLink = await createLink(apiA, mA.id, 1_000, 2_000);
  must("create link expiring in 2 s -> 201", shortLink.status === 201, shortLink);
  const pastExpiry = await createLink(apiA, mA.id, 1_000, -60_000);
  check("create link with expiresAt in the past -> 400", pastExpiry.status === 400, pastExpiry);
  await sleep(3_000);
  const backdated = new Date(Date.now() - 3600_000).toISOString();
  const exp1 = await anon.req("POST", `/v1/payment-links/${shortLink.body.token}/pay`, {
    body: { card: APPROVED_CARD, submittedAt: backdated },
    headers: { "idempotency-key": idem() },
  });
  check("pay expired link with backdated submittedAt -> 410", exp1.status === 410 && exp1.body?.error === "payment_link_expired", exp1);
  const exp2 = await apiA.req("POST", `/v1/payment-links/${shortLink.body.token}/pay`, {
    body: { card: APPROVED_CARD, submittedAt: backdated },
    headers: { "idempotency-key": idem() },
  });
  check("same with the merchant's API key attached -> 410", exp2.status === 410, exp2);

  section("refunds");
  const part = await refund(apiA, mA.id, txId, 5_000);
  check("partial refund 5000 of 12345 -> 200", part.status === 200, part);
  const over = await refund(apiA, mA.id, txId, 7_346);
  check("over-refund (7346 > 7345 left) -> 422 refund_exceeds_refundable", over.status === 422 && JSON.stringify(over.body).includes("refund_exceeds_refundable"), over);
  const zero = await refund(apiA, mA.id, txId, 0);
  check("refund amountFils 0 -> 400", zero.status === 400, zero);
  const frac = await refund(apiA, mA.id, txId, 1.5);
  check("refund fractional fils -> 400", frac.status === 400, frac);
  const str = await refund(apiA, mA.id, txId, "100");
  check("refund amountFils as string -> 400", str.status === 400, str);
  const replayKey = idem();
  const r1 = await refund(apiA, mA.id, txId, 1_000, replayKey);
  const r2 = await refund(apiA, mA.id, txId, 1_000, replayKey);
  const replayDiff = Object.keys({ ...r1.body, ...r2.body }).filter(
    (k) => JSON.stringify(r1.body?.[k]) !== JSON.stringify(r2.body?.[k]),
  );
  check(
    "refund replay with same Idempotency-Key -> same status and body",
    r1.status === r2.status && replayDiff.length === 0,
    { status: [r1.status, r2.status], differs: replayDiff.map((k) => [k, r1.body?.[k], r2.body?.[k]]) },
  );
  const txAfter = await apiA.req("GET", `/v1/transactions/${txId}`);
  const refunded = txAfter.body?.refundedFils ?? txAfter.body?.transaction?.refundedFils;
  if (refunded !== undefined) check("refundedFils = 6000 after 5000 + replayed 1000", refunded === 6_000, txAfter.body);
  else skip("refundedFils on transaction", "field not present in GET /v1/transactions/:id");
  const viaV1 = await apiA.req("POST", "/v1/refunds", {
    body: { transactionId: txId, amountFils: 345 },
    headers: { "idempotency-key": idem() },
  });
  check("POST /v1/refunds (API path) partial -> 200", viaV1.status === 200, viaV1);

  const conc = await paidTransaction(apiA, mA.id, 8_000);
  if (conc.pay?.status === 200) {
    const cTx = conc.pay.body.transactionId;
    const both = await Promise.all([refund(apiA, mA.id, cTx, 8_000), refund(apiA, mA.id, cTx, 8_000)]);
    const ok = both.filter((r) => r.status === 200).length;
    check("concurrent double full refund -> exactly one 200", ok === 1, both.map((r) => [r.status, r.body]));
    const loser = both.find((r) => r.status !== 200);
    check("the other is a 4xx (409/422), not 5xx", loser && loser.status >= 400 && loser.status < 500, loser);
    const many = await paidTransaction(apiA, mA.id, 3_000);
    if (many.pay?.status === 200) {
      const mTx = many.pay.body.transactionId;
      const burst = await Promise.all(Array.from({ length: 6 }, () => refund(apiA, mA.id, mTx, 1_000)));
      const wins = burst.filter((r) => r.status === 200).length;
      check("6 concurrent 1000-fils refunds on 3000 -> at most 3 succeed", wins <= 3 && wins >= 1, burst.map((r) => r.status));
    }
  } else {
    check("setup: paid transaction for concurrency test", false, conc);
  }

  section("cross-merchant isolation");
  const xTx = await apiB.req("GET", `/v1/transactions/${txId}`);
  check("B reads A's transaction -> 404", xTx.status === 404, xTx.status);
  const xEv = await apiB.req("GET", `/v1/transactions/${txId}/events`);
  check("B reads A's transaction events -> 404", xEv.status === 404, xEv.status);
  const xRefund = await apiB.req("POST", "/v1/refunds", {
    body: { transactionId: txId, amountFils: 100 },
    headers: { "idempotency-key": idem() },
  });
  check("B refunds A's transaction via /v1/refunds -> 404", xRefund.status === 404, xRefund);
  const xRefund2 = await refund(apiB, mA.id, txId, 100);
  check("B refunds via A's merchant path -> 403/404", xRefund2.status === 403 || xRefund2.status === 404, xRefund2);
  const xLinkList = await apiB.req("GET", `/v1/merchants/${mA.id}/payment-links`);
  check("B lists A's payment links -> 403/404", xLinkList.status === 403 || xLinkList.status === 404, xLinkList.status);
  const xLink = await apiB.req("GET", `/v1/merchants/${mB.id}/payment-links/${paidLink.body.id}`);
  check("B reads A's link id under B's path -> 404", xLink.status === 404, xLink.status);
  const xCancel = await apiB.req("DELETE", `/v1/merchants/${mB.id}/payment-links/${paidLink.body.id}`);
  check("B cancels A's link under B's path -> 404", xCancel.status === 404, xCancel.status);
  const xKeys = await b.req("GET", `/v1/merchants/${mA.id}/api-keys`);
  check("B session lists A's API keys -> 403/404", xKeys.status === 403 || xKeys.status === 404, xKeys.status);
  const xRep = await apiB.req("GET", `/v1/reporting/transactions?filter=${encodeURIComponent(JSON.stringify({ merchantId: mA.id }))}`);
  check("B reporting with filter.merchantId=A -> 403/404 or B-only rows", xRep.status === 403 || xRep.status === 404 || (xRep.status === 200 && !JSON.stringify(xRep.body).includes(txId)), xRep.status);
  const aBatches = await apiA.req("GET", "/v1/settlement/batches?limit=1");
  const aBatchId = (aBatches.body?.batches ?? aBatches.body?.items ?? [])[0]?.id;
  if (aBatchId) {
    const xBatch = await apiB.req("GET", `/v1/settlement/batches/${aBatchId}`);
    check("B reads A's settlement batch -> 404", xBatch.status === 404, xBatch.status);
  } else skip("B reads A's settlement batch", "A has no batches");
  const xAdmin = await apiA.req("GET", "/v1/admin/merchants");
  check("merchant API key on the admin plane -> 401/403", xAdmin.status === 401 || xAdmin.status === 403, xAdmin.status);

  await caseFileChecks({ admin, a, apiA, apiB, b, mA, mB, rows, txId, amount, aOtpCode });

  section("settlement close + money integrity");
  const today = bahrainDate(0);
  const notOver = await admin.req("POST", "/v1/admin/settlement/run-batch", { body: { date: today, merchantId: mA.id } });
  check(`run-batch for today (${today}, Asia/Bahrain) -> 422 business_day_not_over`, notOver.status === 422 && notOver.body?.error === "business_day_not_over", notOver);
  const yesterday = bahrainDate(-1);
  const run = await admin.req("POST", "/v1/admin/settlement/run-batch", { body: { date: yesterday, merchantId: mA.id } });
  check(`run-batch for finished day ${yesterday} -> 200`, run.status === 200, run);
  check("run-batch summary: every *Fils field is an integer", nonIntegerFils(run.body).length === 0, nonIntegerFils(run.body));
  const run2 = await admin.req("POST", "/v1/admin/settlement/run-batch", { body: { date: yesterday, merchantId: mA.id } });
  check("re-running the same closed day -> 200/409, never a 5xx", run2.status === 200 || run2.status === 409, run2);
  const badDate = await admin.req("POST", "/v1/admin/settlement/run-batch", { body: { date: "2026-13-45" } });
  check("run-batch invalid date -> 400/422", badDate.status === 400 || badDate.status === 422, badDate.status);

  const from = bahrainDate(-40);
  const to = bahrainDate(1);
  const reads = [
    ["/v1/settlement/batches?limit=50", apiA],
    [`/v1/settlement/summary?from=${from}&to=${to}`, apiA],
    [`/v1/settlement/reconciliation?from=${from}&to=${to}`, apiA],
    ["/v1/reporting/transactions", apiA],
    ["/v1/reporting/export-summary", apiA],
    [`/v1/analytics/volumes?from=${from}&to=${to}`, apiA],
    [`/v1/analytics/payout-trends?from=${from}&to=${to}`, apiA],
    [`/v1/admin/merchants/${mA.id}`, admin],
  ];
  for (const [p, c] of reads) {
    const r = await c.req("GET", p);
    const bad = nonIntegerFils(r.body);
    check(`GET ${p} -> 200, integer fils only`, r.status === 200 && bad.length === 0, r.status === 200 ? bad : r);
  }
  const batches = (await apiA.req("GET", "/v1/settlement/batches?limit=50")).body;
  const blist = batches?.batches ?? batches?.items ?? [];
  // net = gross - fee only for a batch with no refunds and no carried-in
  // shortfall. The close deducts each refund (amount - fee reversed, never
  // negative) and adds a negative carried-in balance, so the batch DTO
  // (which carries neither field) can only promise net <= gross - fee. Where
  // a DTO does expose the refund and carry-in amounts, check them exactly.
  const inconsistent = blist.filter((x) => {
    const g = x.grossFils ?? x.capturedGrossFils, f = x.feeFils ?? x.mdrFils, n = x.netFils ?? x.netPayoutFils;
    if (![g, f, n].every(isFils)) return false;
    const r = x.refundDeductionFils ?? x.refundFils ?? x.refundedFils, c = x.carriedInFils;
    if (isFils(r) && isFils(c)) return g - f - r + c !== n;
    return n > g - f;
  });
  check("each batch: net = gross - fee - refunds + carried-in (net <= gross - fee when not itemised)", inconsistent.length === 0, inconsistent.slice(0, 3));

  section("web + admin bundles");
  for (const [label, url] of [["web", WEB_URL], ["admin", ADMIN_URL]]) {
    if (!url) {
      skip(`${label} bundle`, `set ${label.toUpperCase()}_URL`);
      continue;
    }
    const page = await fetch(url);
    const html = await page.text();
    check(`${label}: GET / -> 200 html`, page.status === 200 && /<html/i.test(html), page.status);
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => new URL(m[1], `${url}/`).href);
    check(`${label}: references at least one JS bundle`, assets.some((s) => s.endsWith(".js")), assets);
    for (const s of assets) {
      const r = await fetch(s);
      check(`${label}: ${new URL(s).pathname} -> 200`, r.status === 200, r.status);
    }
  }
}

main()
  .catch((err) => {
    if (!(err instanceof Abort)) {
      console.error(err);
      results.push({ section: currentSection, name: `crashed: ${err.message}`, ok: false });
    } else {
      console.log(`  aborted: "${err.message}" is a prerequisite for the rest`);
    }
  })
  .finally(async () => {
    if (pgPool) await pgPool.end();
    const failed = results.filter((r) => r.ok === false);
    const passed = results.filter((r) => r.ok === true).length;
    const skipped = results.filter((r) => r.ok === null).length;
    console.log(`\n${passed} passed, ${failed.length} failed, ${skipped} skipped`);
    for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name}`);
    process.exitCode = failed.length ? 1 : 0;
  });
