/**
 * SSRF regression tests for webhook URLs: create/update validation in
 * production, and the send-time transport guard. No database needed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { AppError } from "../lib/errors.js";
import { validateWebhookUrl } from "./create.js";
import { createFetchTransport } from "./transport.js";
import { isBlockedHostname } from "./urlPolicy.js";

const prod = { nodeEnv: "production" as const };

const INTERNAL_URLS = [
  "https://169.254.169.254/latest/meta-data/",
  "https://127.0.0.1/hook",
  "https://127.1/hook",
  "https://2130706433/hook", // decimal 127.0.0.1
  "https://0x7f000001/hook",
  "https://localhost/hook",
  "https://api.localhost/hook",
  "https://settlement:8091/internal",
  "https://10.0.0.5/hook",
  "https://172.20.1.1/hook",
  "https://192.168.1.10/hook",
  "https://100.64.0.1/hook",
  "https://0.0.0.0/hook",
  "https://[::1]/hook",
  "https://[::ffff:127.0.0.1]/hook",
  "https://[::ffff:a9fe:a9fe]/hook",
  "https://[fd00::1]/hook",
  "https://[fe80::1]/hook",
  "https://metadata.google.internal/computeMetadata/v1/",
  "https://user:pass@example.com/hook",
];

for (const url of INTERNAL_URLS) {
  test(`production rejects internal webhook url ${url}`, () => {
    assert.throws(
      () => validateWebhookUrl(url, prod),
      (err: unknown) => err instanceof AppError && (err as AppError & { code?: string }).statusCode === 400,
    );
  });
}

test("production still accepts a public https url and rejects plain http", () => {
  assert.equal(validateWebhookUrl("https://hooks.example.com/filspay", prod).hostname, "hooks.example.com");
  assert.equal(validateWebhookUrl("https://93.184.216.34/filspay", prod).hostname, "93.184.216.34");
  assert.throws(() => validateWebhookUrl("http://hooks.example.com/filspay", prod));
});

test("dev/test keep allowing a localhost receiver", () => {
  assert.equal(validateWebhookUrl("http://127.0.0.1:9/hook", { nodeEnv: "test" }).hostname, "127.0.0.1");
});

test("isBlockedHostname: public names and addresses are allowed", () => {
  assert.equal(isBlockedHostname("example.com"), false);
  assert.equal(isBlockedHostname("8.8.8.8"), false);
  assert.equal(isBlockedHostname("[2606:4700::1111]"), false);
});

let server: Server;
let hits = 0;
let port = 0;

before(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/target` });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("internal secret");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("blocking transport never connects to a loopback address", async () => {
  hits = 0;
  const transport = createFetchTransport({ blockPrivateAddresses: true });
  const res = await transport({ url: `http://127.0.0.1:${port}/x`, headers: {}, body: "{}", timeoutMs: 2000 });
  assert.equal(res.statusCode, null);
  assert.equal(res.body, "");
  assert.equal(hits, 0);
});

test("blocking transport refuses a public-looking name that resolves to a private address", async () => {
  hits = 0;
  const transport = createFetchTransport({
    blockPrivateAddresses: true,
    lookup: async () => ["10.1.2.3"],
  });
  const res = await transport({ url: "https://hooks.example.com/x", headers: {}, body: "{}", timeoutMs: 2000 });
  assert.equal(res.statusCode, null);
  assert.equal(res.errorMessage, "destination_not_allowed");
});

test("transport does not follow redirects", async () => {
  hits = 0;
  const transport = createFetchTransport();
  const res = await transport({ url: `http://127.0.0.1:${port}/redirect`, headers: {}, body: "{}", timeoutMs: 2000 });
  assert.equal(res.statusCode, 302);
  assert.equal(hits, 1, "the redirect target must not be requested");
});
