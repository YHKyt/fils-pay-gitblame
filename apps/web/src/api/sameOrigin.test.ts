import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// apps/api sends no CORS headers, so the dashboard only works when its API
// calls are same-origin. These tests pin both halves of that: the client
// builds relative URLs, and the dev server forwards /v1 to the API.

test("the API client calls the API on the page's own origin by default", async () => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const { request } = await import("./client.js");
    await request("/v1/auth/me");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, ["/v1/auth/me"]);
});

test("the dev server forwards /v1 to the API instead of serving the SPA", async () => {
  const api = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "api", method: req.method, url: req.url, cookie: req.headers.cookie ?? null }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.API_PROXY_TARGET = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const { createServer } = await import("vite");
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const vite = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    logLevel: "silent",
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "fp_sid=abc" },
      body: "{}",
    });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 200));
    assert.deepEqual(JSON.parse(text), { from: "api", method: "POST", url: "/v1/auth/login", cookie: "fp_sid=abc" });
  } finally {
    await vite.close();
    api.close();
    delete process.env.API_PROXY_TARGET;
  }
});
