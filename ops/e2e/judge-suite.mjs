#!/usr/bin/env node
// Black-box HTTP suite for a running FilsPay API (local compose or hosted).
// Talks to the API over HTTP only; the one optional exception is OTP
// retrieval (see "OTP" below). Exits non-zero when any check fails.
//
// Usage: BASE_URL=https://<host> node ops/e2e/judge-suite.mjs
// See ops/e2e/README.md for every environment variable.

import { randomUUID, randomBytes, createHash } from "node:crypto";
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
  await merchantLogin(a, mA.id, MERCHANT_A_EMAIL, MERCHANT_PASSWORD);
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
