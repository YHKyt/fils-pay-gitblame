/**
 * PDF-only KYC document types are judged by the detected bytes, never the
 * client-supplied filename (ARCHITECTURE: "KYC uploads are validated by
 * detected content type (magic bytes)"). Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import sharp from "sharp";
import { loadConfig, type Config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { recordKycDocument } from "./kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("kycPdfOnly.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
let uploadDir: string;
let config: Config;

before(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), "kyc-pdf-only-"));
  config = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    INTERNAL_API_TOKEN: "test-internal-token",
    KYC_UPLOAD_DIR: uploadDir,
  });
});

after(async () => {
  await pool.end();
  await rm(uploadDir, { recursive: true, force: true });
});

async function merchantWithUser(): Promise<{ merchantId: string; userId: string }> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`KYC PDF Test ${randomUUID()}`],
  );
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [m.rows[0]!.id, `owner-${randomUUID()}@example.test`],
  );
  return { merchantId: m.rows[0]!.id, userId: u.rows[0]!.id };
}

async function jpegBytes(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).jpeg().toBuffer();
}

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

for (const documentType of ["commercial_registration", "bank_letter"] as const) {
  test(`${documentType}: a JPEG renamed to .pdf is rejected`, async () => {
    const { merchantId, userId } = await merchantWithUser();
    await assert.rejects(
      recordKycDocument(pool, config, {
        merchantId,
        documentType,
        fileName: "CR-2026.pdf",
        buffer: await jpegBytes(),
        uploadedBy: userId,
      }),
      (err: unknown) => err instanceof AppError && err.statusCode === 422,
    );
    const rows = await pool.query(`SELECT 1 FROM kyc_documents WHERE merchant_id = $1`, [merchantId]);
    assert.equal(rows.rowCount, 0);
  });
}

test("commercial_registration: real PDF bytes are accepted", async () => {
  const { merchantId, userId } = await merchantWithUser();
  const result = await recordKycDocument(pool, config, {
    merchantId,
    documentType: "commercial_registration",
    fileName: "CR-2026.pdf",
    buffer: PDF_BYTES,
    uploadedBy: userId,
  });
  assert.equal(result.mimeType, "application/pdf");
});

test("owner_id: a JPEG is still accepted for photo-allowed types", async () => {
  const { merchantId, userId } = await merchantWithUser();
  const result = await recordKycDocument(pool, config, {
    merchantId,
    documentType: "owner_id",
    fileName: "id.jpg",
    buffer: await jpegBytes(),
    uploadedBy: userId,
  });
  assert.equal(result.mimeType, "image/jpeg");
});
