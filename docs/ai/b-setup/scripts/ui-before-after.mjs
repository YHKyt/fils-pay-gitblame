// Before/after screenshots of UI fixes. Serve the fixed frontends on 5173/5174 and,
// from a worktree with only the fix reverted, the "before" ones on 5183/5184, all
// against one API on :3000 (NODE_ENV=development, OTP_DEV_EXPOSE=true) and one
// seeded database (DEMO_DB_URL). Logins use the seed fixtures in db/seed/generate.ts.
// Needs: npm i puppeteer-core ; EDGE_PATH (or CHROME_PATH) to an installed browser.
// usage: node ui-before-after.mjs <outDir> <repoDir>
import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";
import fs from "node:fs";

const [outDir, repoDir] = process.argv.slice(2);
const require = createRequire(repoDir + "/package.json");
const { Client } = require("pg");
fs.mkdirSync(outDir, { recursive: true });

const ALPHA = "9972daab-2c86-459f-9d78-3fe1be4e3280";
const TXN = "aeb1ed16-f16e-4123-9c04-5c7b9ce613b8";
const db = new Client({ connectionString: process.env.DEMO_DB_URL ?? "postgres://filspay:filspay_dev_password@127.0.0.1:5432/filspay_demo" });
await db.connect();

const browser = await puppeteer.launch({
  executablePath: process.env.EDGE_PATH ?? process.env.CHROME_PATH,
  headless: true,
  defaultViewport: { width: 1280, height: 860 },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(page, url, values) {
  await page.goto(url, { waitUntil: "networkidle0" });
  const inputs = await page.$$("input");
  for (let i = 0; i < values.length; i++) await inputs[i].type(values[i]);
  await Promise.all([page.keyboard.press("Enter"), sleep(1500)]);
  const text = await page.evaluate(() => document.body.innerText);
  const code = /Development code:\s*(\d+)/.exec(text)?.[1];
  if (!code) throw new Error("no dev code on " + url + ":\n" + text.slice(0, 400));
  const otp = await page.$("input");
  await otp.type(code);
  await Promise.all([page.keyboard.press("Enter"), sleep(2000)]);
}

async function shot(page, url, file, waitText) {
  await page.goto(url, { waitUntil: "networkidle0" });
  if (waitText) await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 8000 }, waitText).catch(() => {});
  await sleep(800);
  await page.screenshot({ path: `${outDir}/${file}`, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(`${outDir}/${file}.txt`, text);
  console.log("saved", file, text.length, "chars");
}

// Merchant dashboard (cookie is per host, so one sign-in serves both ports)
const m = await browser.newPage();
await login(m, "http://localhost:5173/dashboard/login", [ALPHA, "owner@alpharetail.example", "FilsPaySeed!2026"]);

// An active link whose expiry has passed (set directly in the local demo DB).
const created = await m.evaluate(async (alpha) => {
  const r = await fetch(`/v1/merchants/${alpha}/payment-links`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ amountFils: 12500, reference: "spring-sale-voucher", description: "Spring sale voucher", expiresAt: new Date(Date.now() + 86400e3).toISOString() }),
  });
  return [r.status, await r.json()];
}, ALPHA);
if (created[0] !== 201 && created[0] !== 200) throw new Error("link create " + JSON.stringify(created));
const linkId = created[1].id;
await db.query(`UPDATE payment_links SET expires_at = now() - interval '2 days' WHERE id = $1`, [linkId]);

// 1. Refunded transaction detail
await shot(m, `http://localhost:5183/dashboard/transactions/${TXN}`, "1-refund-detail-before.png");
await shot(m, `http://localhost:5173/dashboard/transactions/${TXN}`, "1-refund-detail-after.png", "refund");
// 2. Expired payment link: list and detail
await shot(m, "http://localhost:5183/dashboard/payment-links", "2-expired-link-list-before.png", "spring-sale");
await shot(m, "http://localhost:5173/dashboard/payment-links", "2-expired-link-list-after.png", "spring-sale");
await shot(m, `http://localhost:5183/dashboard/payment-links/${linkId}`, "2-expired-link-detail-before.png", "spring");
await shot(m, `http://localhost:5173/dashboard/payment-links/${linkId}`, "2-expired-link-detail-after.png", "spring");

// 3. Admin console: an already-approved merchant's KYC section
const a = await browser.newPage();
await login(a, "http://localhost:5174/login", ["finance@filspay.test", "FilsPayAdminSeed!2026"]);
await shot(a, `http://localhost:5184/merchants/${ALPHA}`, "3-admin-kyc-before.png", "Alpha");
await shot(a, `http://localhost:5174/merchants/${ALPHA}`, "3-admin-kyc-after.png", "Alpha");

await browser.close();
await db.end();
