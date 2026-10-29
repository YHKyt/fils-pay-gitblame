/**
 * Route-level regression tests for /v1/merchants/:merchantId/kyc/documents.
 *
 * Real, migrated Postgres; requires DATABASE_URL (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig, type Config } from "../config.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("kyc.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
let uploadDir: string;
let config: Config;
let app: FastifyInstance;

before(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), "kyc-routes-"));
  config = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    INTERNAL_API_TOKEN: "test-internal-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    KYC_UPLOAD_DIR: uploadDir,
  });
  app = buildApp(config, pool);
  await app.ready();
});

after(async () => {
  await app.close();
  await pool.end();
  await rm(uploadDir, { recursive: true, force: true });
});

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function ownerSession(): Promise<{ merchantId: string; userId: string; cookie: string }> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`KYC Route Test ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [user.rows[0]!.id, sha256Hex(rawToken)],
  );
  return { merchantId, userId: user.rows[0]!.id, cookie: `${config.cookieName}=${rawToken}` };
}

function multipartBody(
  fields: Record<string, string>,
  files: Array<{ name: string; filename: string; content: Buffer }>,
): { payload: Buffer; contentType: string } {
  const boundary = `----kyctest${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
          `Content-Type: application/pdf\r\n\r\n`,
      ),
      file.content,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

test("an upload carrying more than one file is rejected and records nothing", async () => {
  const { merchantId, cookie } = await ownerSession();
  const secondPdf = Buffer.concat([PDF_BYTES, Buffer.from("% second\n")]);
  const body = multipartBody({ documentType: "commercial_registration" }, [
    { name: "file", filename: "first.pdf", content: PDF_BYTES },
    { name: "file", filename: "second.pdf", content: secondPdf },
  ]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/kyc/documents`,
    headers: { cookie, "content-type": body.contentType },
    payload: body.payload,
  });
  assert.equal(res.statusCode, 400, res.body);

  const rows = await pool.query(`SELECT 1 FROM kyc_documents WHERE merchant_id = $1`, [merchantId]);
  assert.equal(rows.rowCount, 0, "a multi-file request must not silently keep one of the files");
});

test("a single-file upload is still accepted", async () => {
  const { merchantId, cookie } = await ownerSession();
  const body = multipartBody({ documentType: "commercial_registration" }, [
    { name: "file", filename: "cr.pdf", content: PDF_BYTES },
  ]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/kyc/documents`,
    headers: { cookie, "content-type": body.contentType },
    payload: body.payload,
  });
  assert.equal(res.statusCode, 201, res.body);
});
