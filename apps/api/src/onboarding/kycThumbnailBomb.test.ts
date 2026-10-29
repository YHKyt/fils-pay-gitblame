/**
 * Decompression-bomb guard for the KYC thumbnailer: a small upload whose
 * header declares a huge canvas must be refused from the header alone, and an
 * undecodable "image" with valid magic bytes is a 422, not a 500.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { AppError } from "../lib/errors.js";
import { generateKycThumbnail } from "./kycThumbnail.js";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A valid 1-bit grayscale PNG of side x side, all zero: tiny compressed, huge decoded. */
function bombPng(side: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const rowBytes = 1 + Math.ceil(side / 8);
  const raw = Buffer.alloc(rowBytes * side); // filter byte 0 + zero pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a PNG declaring a 15000x15000 canvas (225 MP) is refused without decoding it", async () => {
  const bomb = bombPng(15_000);
  assert.ok(bomb.length < 1_000_000, `fixture is small on the wire (${bomb.length} bytes)`);

  const started = Date.now();
  await assert.rejects(
    generateKycThumbnail(bomb, "png"),
    (err: unknown) => err instanceof AppError && err.statusCode === 422,
  );
  assert.ok(Date.now() - started < 2_000, "must be rejected from the header, not after a full decode");
});

test("bytes with PNG magic that are not a decodable image are a 422", async () => {
  const garbage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("nope")]);
  await assert.rejects(
    generateKycThumbnail(garbage, "png"),
    (err: unknown) => err instanceof AppError && err.statusCode === 422,
  );
});
