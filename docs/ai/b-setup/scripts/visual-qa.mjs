// Visual QA: every surface at desktop and phone width; records console
// Needs: npm i puppeteer-core ; EDGE_PATH (or CHROME_PATH); a seeded DEMO_DB_URL and the
// API (:3000, NODE_ENV=development, OTP_DEV_EXPOSE=true) plus both frontends running.
// errors, failed requests and horizontal overflow per page.
// usage: node visual-qa.mjs <outDir> <repoDir> [webPort=5173] [adminPort=5174]
import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import fs from "node:fs";

const [outDir, repoDir, webPort = "5173", adminPort = "5174"] = process.argv.slice(2);
const { Client } = createRequire(repoDir + "/package.json")("pg");
fs.mkdirSync(outDir, { recursive: true });
const W = `http://localhost:${webPort}`, A = `http://localhost:${adminPort}`;
const ALPHA = "9972daab-2c86-459f-9d78-3fe1be4e3280";

const db = new Client({ connectionString: process.env.DEMO_DB_URL ?? "postgres://filspay:filspay_dev_password@127.0.0.1:5432/filspay_demo" });
await db.connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0] ?? {};
const refunded = (await one(`SELECT id FROM transactions WHERE merchant_id=$1 AND refunded_fils > 0 LIMIT 1`, [ALPHA])).id;
const captured = (await one(`SELECT id FROM transactions WHERE merchant_id=$1 AND status='captured' AND refunded_fils=0 LIMIT 1`, [ALPHA])).id;
const expiredLink = await one(`SELECT id, token FROM payment_links WHERE merchant_id=$1 AND expires_at < now() LIMIT 1`, [ALPHA]);
const batch = (await one(`SELECT id FROM settlement_batches WHERE merchant_id=$1 ORDER BY batch_date DESC LIMIT 1`, [ALPHA])).id;

const browser = await puppeteer.launch({ executablePath: process.env.EDGE_PATH ?? process.env.CHROME_PATH, headless: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, url, values) {
  await page.goto(url, { waitUntil: "networkidle0" });
  const inputs = await page.$$("input");
  for (let i = 0; i < values.length; i++) await inputs[i].type(values[i]);
  await page.keyboard.press("Enter"); await sleep(1500);
  const code = /Development code:\s*(\d+)/.exec(await page.evaluate(() => document.body.innerText))?.[1];
  if (!code) throw new Error("no dev code at " + url);
  await (await page.$("input")).type(code);
  await page.keyboard.press("Enter"); await sleep(2000);
}

// An open link so the checkout form itself can be captured.
async function openLinkToken(page) {
  return page.evaluate(async (alpha) => {
    const r = await fetch(`/v1/merchants/${alpha}/payment-links`, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ amountFils: 7250, reference: "qa-open-link", description: "QA open link", expiresAt: new Date(Date.now() + 864e5).toISOString() }) });
    return (await r.json()).token;
  }, ALPHA);
}

const report = [];
async function capture(page, name, url, vp) {
  const errors = [];
  const onConsole = (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); };
  const onPageErr = (e) => errors.push("pageerror: " + String(e.message).slice(0, 200));
  const onResp = (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); };
  page.on("console", onConsole); page.on("pageerror", onPageErr); page.on("response", onResp);
  await page.setViewport(vp.size);
  await page.goto(url, { waitUntil: "networkidle0" }).catch((e) => errors.push("nav: " + e.message));
  await sleep(700);
  const m = await page.evaluate((vw) => ({
    // widest visible element edge beyond the viewport (scrollWidth vs
    // innerWidth misses this in mobile emulation without a viewport meta)
    overflowX: Math.round(Math.max(0, ...[...document.querySelectorAll("body *")]
      .filter((el) => el.offsetParent !== null)
      // content inside its own scroll/clip box doesn't widen the page
      .filter((el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return false; } return true; })
      .map((el) => el.getBoundingClientRect().right)) - vw),
    title: document.title,
    blank: document.body.innerText.trim().length < 20,
    crash: /Unexpected Application Error/.test(document.body.innerText),
    viewportMeta: !!document.querySelector('meta[name="viewport"]'),
  }), vp.size.width);
  const file = `${name}-${vp.tag}.png`;
  await page.screenshot({ path: `${outDir}/${file}`, fullPage: true });
  page.off("console", onConsole); page.off("pageerror", onPageErr); page.off("response", onResp);
  const issues = [...errors];
  if (m.overflowX > 1) issues.push(`horizontal overflow ${m.overflowX}px`);
  if (vp.tag === "mobile" && !m.viewportMeta) issues.push("no <meta name=viewport>");
  if (m.blank) issues.push("page is (nearly) blank");
  if (m.crash) issues.push("React error page");
  report.push({ file, url, issues });
  console.log(issues.length ? "ISSUE" : "ok   ", file, issues.join(" | "));
}

const VPS = [{ tag: "desktop", size: { width: 1280, height: 860 } }, { tag: "mobile", size: { width: 375, height: 812, isMobile: true, hasTouch: true } }];

// Logged-out pages first
const anon = await browser.newPage();
for (const vp of VPS) {
  await capture(anon, "web-login", `${W}/dashboard/login`, vp);
  await capture(anon, "admin-login", `${A}/login`, vp);
  if (expiredLink.token) await capture(anon, "checkout-expired", `${W}/pay/${expiredLink.token}`, vp);
}

const m = await browser.newPage();
await login(m, `${W}/dashboard/login`, [ALPHA, "owner@alpharetail.example", "FilsPaySeed!2026"]);
const token = await openLinkToken(m);
const web = [
  ["web-transactions", "/dashboard/transactions"],
  ["web-txn-captured", `/dashboard/transactions/${captured}`],
  ["web-txn-refunded", `/dashboard/transactions/${refunded}`],
  ["web-links", "/dashboard/payment-links"],
  ["web-link-new", "/dashboard/payment-links/new"],
  ["web-link-expired", `/dashboard/payment-links/${expiredLink.id}`],
  ["web-webhooks", "/dashboard/webhooks"],
  ["web-settlement", "/dashboard/settlement"],
  ["web-batch", `/dashboard/settlement/${batch}`],
  ["web-reconciliation", "/dashboard/reconciliation"],
  ["web-overview", "/dashboard/overview"],
];
for (const vp of VPS) {
  for (const [n, p] of web) await capture(m, n, W + p, vp);
  if (token) await capture(anon, "checkout-open", `${W}/pay/${token}`, vp);
}

const a = await browser.newPage();
await login(a, `${A}/login`, ["finance@filspay.test", "FilsPayAdminSeed!2026"]);
const admin = [
  ["admin-merchants", "/merchants"],
  ["admin-merchant", `/merchants/${ALPHA}`],
  ["admin-credits", "/credits"],
  ["admin-settlement", "/settlement"],
  ["admin-imports", "/adjustment-imports"],
  ["admin-webhooks", "/webhooks"],
];
for (const vp of VPS) for (const [n, p] of admin) await capture(a, n, A + p, vp);

fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log(`\n${report.length} captures, ${report.filter((r) => r.issues.length).length} with issues`);
await browser.close(); await db.end();
