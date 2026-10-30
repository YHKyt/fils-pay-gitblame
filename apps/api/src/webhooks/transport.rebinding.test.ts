/**
 * h3 lane report: the production transport checked a webhook host's DNS
 * answer, then fetch resolved the name again to connect. A name answering
 * a public address to the check and 127.0.0.1 to the connect (DNS
 * rebinding) reached an internal service. The guarded transport now checks
 * the addresses the connection itself resolves. No database needed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createFetchTransport } from "./transport.js";

let server: Server;
let port = 0;
const received: Array<{ headers: Record<string, unknown>; body: string }> = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(200 * 1024));
        return;
      }
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

const PUBLIC = async () => ["93.184.216.34"];
const LOOPBACK = async () => ["127.0.0.1"];

test("a name that rebinds to a private address between the check and the connect is refused", async () => {
  received.length = 0;
  const transport = createFetchTransport({ blockPrivateAddresses: true, lookup: PUBLIC, connectLookup: LOOPBACK });
  const res = await transport({
    url: `http://rebind.example.test:${port}/hook`,
    headers: { "content-type": "application/json" },
    body: "{}",
    timeoutMs: 2_000,
  });
  assert.equal(res.statusCode, null);
  assert.equal(res.errorMessage, "destination_not_allowed");
  assert.equal(received.length, 0, "the internal receiver was reached");
});

test("the guarded send posts the exact body and headers and reads a bounded reply", async () => {
  received.length = 0;
  const transport = createFetchTransport({
    blockPrivateAddresses: true,
    lookup: PUBLIC,
    connectLookup: LOOPBACK,
    connectAddressAllowed: () => true,
  });
  const body = JSON.stringify({ id: "evt_1", data: { amountFils: 4750 } });
  const res = await transport({
    url: `http://receiver.example.test:${port}/hook`,
    headers: { "content-type": "application/json", "x-filspay-signature": "t=1,v1=abc" },
    body,
    timeoutMs: 2_000,
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, "accepted");
  assert.equal(received[0]!.body, body);
  assert.equal(received[0]!.headers["x-filspay-signature"], "t=1,v1=abc");
  assert.equal(received[0]!.headers["content-type"], "application/json");

  const big = await transport({ url: `http://receiver.example.test:${port}/big`, headers: {}, body: "", timeoutMs: 2_000 });
  assert.equal(big.statusCode, 200);
  assert.equal(big.body.length, 64 * 1024);
});

test("the guarded send times out like the fetch path", async () => {
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const silentPort = (silent.address() as AddressInfo).port;
  try {
    const transport = createFetchTransport({
      blockPrivateAddresses: true,
      lookup: PUBLIC,
      connectLookup: LOOPBACK,
      connectAddressAllowed: () => true,
    });
    const res = await transport({ url: `http://slow.example.test:${silentPort}/`, headers: {}, body: "", timeoutMs: 200 });
    assert.equal(res.statusCode, null);
    assert.ok(res.errorMessage);
  } finally {
    silent.closeAllConnections();
    silent.close();
  }
});
