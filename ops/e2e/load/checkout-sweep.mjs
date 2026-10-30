// Checkout concurrency sweep with correctness checks (docs/audit/hostharden.md).
//   DATABASE_URL=... node ops/e2e/load/checkout-sweep.mjs <baseUrl> <setupBaseUrl> <seconds> <c1,c2,...> [outfile]
// baseUrl is the public origin under test; setupBaseUrl is where the links
// are created beforehand (the api's loopback port, so setup is not limited).
// Local stacks only: DATABASE_URL re-keys the seed owner's OTP and checks
// every payment afterwards.
// Each virtual user loops: GET /v1/payment-links/:token (the checkout page's
// read), then POST /v1/payment-links/:token/pay with a fresh Idempotency-Key,
// on a link nobody else pays. After each step the DB is checked: every 200
// maps to exactly one captured transaction, the link records it, and ledger
// groups balance.
import { createRequire } from "node:module";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const pg = require("pg");
const [BASE, SETUP, secStr, levelsStr, outFile] = process.argv.slice(2);
const SECS = Number(secStr);
const LEVELS = levelsStr.split(",").map(Number);
const CARD = { pan: "4000000000000010", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

async function call(base, method, path, { body, headers = {}, cookie } = {}) {
  const h = { accept: "application/json", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (cookie) h.cookie = cookie;
  const t0 = performance.now();
  try {
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    return { status: res.status, ms: performance.now() - t0, text, headers: res.headers };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, text: String(e.cause?.code ?? e.name ?? e.message) };
  }
}

async function setup() {
  const merchantId = (await pool.query(`SELECT merchant_id FROM merchant_users WHERE email='owner@alpharetail.example' ORDER BY created_at LIMIT 1`)).rows[0].merchant_id;
  const login = await call(SETUP, "POST", "/v1/auth/login", { body: { merchantId, email: "owner@alpharetail.example", password: "FilsPaySeed!2026" } });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  await pool.query(
    `UPDATE otp_challenges SET code_salt=$1, code_hash=$2 WHERE id = (SELECT c.id FROM otp_challenges c JOIN merchant_users u ON u.id=c.merchant_user_id
      WHERE u.email='owner@alpharetail.example' AND u.merchant_id=$3 AND c.consumed_at IS NULL ORDER BY c.created_at DESC LIMIT 1)`,
    [salt, createHash("sha256").update(salt + code).digest("hex"), merchantId],
  );
  const v = await call(SETUP, "POST", "/v1/auth/otp/verify", { body: { code }, cookie });
  const cookie2 = v.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const key = JSON.parse((await call(SETUP, "POST", `/v1/merchants/${merchantId}/api-keys`, { body: { label: "hh-sweep" }, cookie: cookie2 })).text).rawKey;
  return { merchantId, key };
}

async function makeLinks(ctx, n) {
  const out = [];
  for (let i = 0; i < n; i += 25) {
    const rs = await Promise.all(
      Array.from({ length: Math.min(25, n - i) }, () =>
        call(SETUP, "POST", `/v1/merchants/${ctx.merchantId}/payment-links`, {
          headers: { authorization: `Bearer ${ctx.key}` },
          body: { amountFils: 1000 + Math.floor(Math.random() * 9000), reference: `sweep-${randomUUID()}`, expiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
        }),
      ),
    );
    for (const r of rs) if (r.status === 201) { const b = JSON.parse(r.text); out.push({ id: b.id, token: b.token, amount: b.amountFils }); }
  }
  return out;
}

const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0);

async function step(ctx, conc) {
  const links = await makeLinks(ctx, Math.max(200, Math.ceil(conc * SECS * 2.5)));
  await new Promise((r) => setTimeout(r, 3000));
  if (process.env.STARTED_FILE) writeFileSync(process.env.STARTED_FILE, String(Date.now()));
  const checkoutMs = [], payMs = [], statuses = {}, paid = [], errs = {};
  let linkIdx = 0, ranOut = 0;
  const end = Date.now() + SECS * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    let retry = null;
    while (Date.now() < end) {
      // A turned-away customer (429/503) retries the same checkout after
      // the Retry-After second instead of moving on to a new link.
      const link = retry ?? links[linkIdx++];
      retry = null;
      if (!link) { ranOut++; break; }
      const t = performance.now();
      const view = await call(BASE, "GET", `/v1/payment-links/${link.token}`);
      const pay = view.status === 200
        ? await call(BASE, "POST", `/v1/payment-links/${link.token}/pay`, { body: { card: CARD }, headers: { "idempotency-key": randomUUID() } })
        : view;
      const total = performance.now() - t;
      const key = view.status === 200 ? `pay ${pay.status}` : `view ${view.status}`;
      statuses[key] = (statuses[key] ?? 0) + 1;
      if (pay.status === 429 || pay.status === 503) {
        retry = link;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (pay.status === 200) {
        const b = JSON.parse(pay.text);
        paid.push({ link, tx: b.transactionId, status: b.status });
        checkoutMs.push(total);
        payMs.push(pay.ms);
      } else if (pay.status === 0 || pay.status >= 500) errs[`${pay.status} ${pay.text.slice(0, 100)}`] = (errs[`${pay.status} ${pay.text.slice(0, 100)}`] ?? 0) + 1;
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  checkoutMs.sort((a, b) => a - b);
  payMs.sort((a, b) => a - b);
  const attempts = Object.values(statuses).reduce((a, b) => a + b, 0);
  // Correctness: one captured transaction per 200, the link points at it, amount matches.
  const ids = paid.map((p) => p.tx);
  const rows = ids.length
    ? (await pool.query(
        `SELECT t.id, t.status, t.captured_fils, pl.id AS link_id, pl.status AS link_status, pl.amount_fils
           FROM transactions t LEFT JOIN payment_links pl ON pl.transaction_id = t.id WHERE t.id = ANY($1::uuid[])`, [ids])).rows
    : [];
  const byTx = new Map(rows.map((r) => [r.id, r]));
  let bad = 0;
  for (const p of paid) {
    const r = byTx.get(p.tx);
    if (!r || r.link_id !== p.link.id || r.link_status !== "paid" || Number(r.captured_fils) !== p.link.amount || p.status !== "paid") bad++;
  }
  const dupTx = ids.length - new Set(ids).size;
  const allLinkIds = links.slice(0, linkIdx).map((l) => l.id);
  const multi = (await pool.query(
    `SELECT count(*)::int n FROM (SELECT t.reference FROM transactions t JOIN payment_links pl ON pl.reference=t.reference AND pl.merchant_id=t.merchant_id
       WHERE pl.id = ANY($1::uuid[]) AND t.status IN ('captured','partially_refunded','refunded') GROUP BY t.reference HAVING count(*)>1) x`, [allLinkIds])).rows[0].n;
  const unbalanced = (await pool.query(
    `SELECT count(*)::int n FROM (SELECT entry_group_id FROM ledger_entries GROUP BY entry_group_id
       HAVING SUM(CASE WHEN direction='debit' THEN amount_fils ELSE 0 END) <> SUM(CASE WHEN direction='credit' THEN amount_fils ELSE 0 END)) x`)).rows[0].n
    .valueOf?.() ?? null;
  const failed = attempts - paid.length;
  const res = {
    concurrency: conc,
    seconds: Math.round(secs),
    checkoutsOk: paid.length,
    checkoutsPerSec: +(paid.length / secs).toFixed(1),
    attempts,
    errorRate: attempts ? +(failed / attempts).toFixed(4) : 0,
    checkoutP50ms: Math.round(pct(checkoutMs, 50)),
    checkoutP95ms: Math.round(pct(checkoutMs, 95)),
    checkoutP99ms: Math.round(pct(checkoutMs, 99)),
    payP95ms: Math.round(pct(payMs, 95)),
    statuses,
    errors: errs,
    correctness: { wrongRows: bad, duplicateTx: dupTx, linksWithTwoCaptures: multi, unbalancedLedgerGroups: unbalanced },
    ranOutOfLinks: ranOut,
  };
  console.log(JSON.stringify(res));
  return res;
}

const ctx = await setup();
const all = [];
for (const c of LEVELS) all.push(await step(ctx, c));
if (outFile) writeFileSync(outFile, JSON.stringify(all, null, 1));
await pool.end();
