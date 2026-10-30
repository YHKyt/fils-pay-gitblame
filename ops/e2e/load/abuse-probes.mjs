// Abuse probes against the public origin (docs/audit/hostharden.md).
//   node ops/e2e/load/abuse-probes.mjs <host> <port> [all|slow|body|flood]
// VICTIM_BASE / VICTIM_TOKEN: another client (e.g. the api's loopback port
// and an active link token) whose reads are timed during each flood.
import net from "node:net";
import { randomUUID } from "node:crypto";

const [HOST, PORT] = [process.argv[2] ?? "127.0.0.1", Number(process.argv[3] ?? 18480)];
const BASE = `http://${HOST}:${PORT}`;
const out = {};

// 1. Slowloris: 1000 sockets that send half a request header and then
// dribble one header line every 5 s. How long until nginx closes them, and
// does a normal request still get through meanwhile?
async function slowloris(n = 1000) {
  const t0 = Date.now();
  const closedAt = [];
  const socks = [];
  for (let i = 0; i < n; i++) {
    const s = net.connect(PORT, HOST);
    s.on("error", () => {});
    s.on("connect", () => s.write(`GET /v1/payment-links/x HTTP/1.1\r\nHost: ${HOST}\r\nX-a: 1\r\n`));
    const iv = setInterval(() => s.writable && s.write(`X-b: ${Date.now()}\r\n`), 5000);
    s.on("close", () => {
      clearInterval(iv);
      closedAt.push(Date.now() - t0);
    });
    socks.push(s);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const h0 = performance.now();
  const probe = await fetch(`${BASE}/healthz`).then((r) => r.status, (e) => `err ${e.cause?.code}`);
  const probeMs = Math.round(performance.now() - h0);
  await new Promise((r) => setTimeout(r, 30_000));
  socks.forEach((s) => s.destroy());
  closedAt.sort((a, b) => a - b);
  return {
    sockets: n,
    healthzDuringAttack: probe,
    healthzMs: probeMs,
    closedByServerWithin30s: closedAt.filter((t) => t < 33_000).length,
    medianCloseMs: closedAt[Math.floor(closedAt.length / 2)],
  };
}

// 2. Giant bodies on public routes.
async function bodies() {
  const big = (n) => JSON.stringify({ card: { pan: "4000000000000010" }, pad: "x".repeat(n) });
  const r = {};
  for (const [label, path, size] of [
    ["pay 1 MB", "/v1/payment-links/plink_nope/pay", 1_000_000],
    ["login 1 MB", "/v1/auth/login", 1_000_000],
    ["signup 1 MB", "/v1/merchants", 1_000_000],
    ["any /v1 20 MB", "/v1/transactions", 20_000_000],
  ]) {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: big(size) }).catch((e) => ({ status: `err ${e.cause?.code}`, text: async () => "" }));
    r[label] = `${res.status} ${(await res.text()).slice(0, 80)}`;
  }
  return r;
}

// 3. Floods from one address, 15 s each, 100 concurrent loops.
async function flood(label, mk, secs = 15, conc = 100) {
  const st = {};
  const end = Date.now() + secs * 1000;
  const lat = [];
  // Another user of the box, not behind this address's limits: reads a
  // payment link straight from the api every 250 ms during the flood.
  const victim = [];
  const vpath = process.env.VICTIM_TOKEN ? `/v1/payment-links/${process.env.VICTIM_TOKEN}` : "/healthz";
  const vloop = (async () => {
    while (Date.now() < end) {
      const t = performance.now();
      const st2 = await fetch(`${process.env.VICTIM_BASE ?? BASE}${vpath}`).then(async (r) => { await r.text(); return r.status; }, () => 0);
      victim.push([performance.now() - t, st2]);
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      const t = performance.now();
      const res = await mk().catch((e) => ({ status: 0, text: async () => String(e.cause?.code) }));
      await res.text();
      lat.push(performance.now() - t);
      st[res.status] = (st[res.status] ?? 0) + 1;
    }
  }));
  await vloop;
  lat.sort((a, b) => a - b);
  const vl = victim.map((v) => v[0]).sort((a, b) => a - b);
  return { label, victimP50ms: Math.round(vl[Math.floor(vl.length / 2)]), victimP95ms: Math.round(vl[Math.floor(vl.length * 0.95)]), victimNon200: victim.filter((v) => v[1] !== 200).length, statuses: st, p50ms: Math.round(lat[Math.floor(lat.length / 2)]), perSec: Math.round(Object.values(st).reduce((a, b) => a + b, 0) / secs) };
}

const which = process.argv[4] ?? "all";
if (which === "all" || which === "slow") out.slowloris = await slowloris();
if (which === "all" || which === "body") out.bodies = await bodies();
if (which === "all" || which === "flood") {
  out.floodLogin = await flood("login", () => fetch(`${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchantId: randomUUID(), email: "x@example.com", password: "nope" }) }));
  out.floodAdminLogin = await flood("admin login", () => fetch(`${BASE}/v1/admin/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `x${Math.random()}@example.com`, password: "nope" }) }));
  out.floodSignup = await flood("signup", () => fetch(`${BASE}/v1/merchants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
  out.floodPay = await flood("pay (unknown link)", () => fetch(`${BASE}/v1/payment-links/plink_${randomUUID()}/pay`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ card: { pan: "4000000000000010", expiryMonth: 12, expiryYear: 2030, cvv: "123" } }) }));
  out.floodV1 = await flood("GET /v1 anon", () => fetch(`${BASE}/v1/transactions`), 15, 200);
  out.floodHealthz = await flood("GET /healthz", () => fetch(`${BASE}/healthz`), 15, 200);
}
console.log(JSON.stringify(out, null, 1));
