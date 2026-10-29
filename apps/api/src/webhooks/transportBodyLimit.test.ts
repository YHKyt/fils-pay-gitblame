/**
 * The webhook transport must not buffer an arbitrarily large receiver
 * response (merchant-controlled) in memory. No database needed.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createFetchTransport } from "./transport.js";

const RESPONSE_BYTES = 32 * 1024 * 1024;
let server: Server;
let port = 0;

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/plain" });
    const chunk = Buffer.alloc(64 * 1024, "a");
    let sent = 0;
    const pump = (): void => {
      while (sent < RESPONSE_BYTES) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    res.on("error", () => {});
    pump();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a 32 MiB receiver response is read only up to a small bound", async () => {
  const transport = createFetchTransport();
  const res = await transport({ url: `http://127.0.0.1:${port}/big`, headers: {}, body: "{}", timeoutMs: 10_000 });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.length >= 2000, "still enough for the 2000-char excerpt");
  assert.ok(res.body.length <= 64 * 1024, `kept ${res.body.length} bytes`);
});
