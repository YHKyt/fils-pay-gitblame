import sharp from "sharp";
import { UnprocessableEntityError } from "../lib/errors.js";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

/** Largest accepted source image (~40 MP: any phone photo or document scan). */
const MAX_INPUT_PIXELS = 40_000_000;

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  // The upload byte cap does not bound the decoded size: a few hundred KB of
  // PNG can declare a 225 MP canvas (sharp's default limit is ~268 MP), which
  // the 512 MB API cannot afford. The pixel count is checked from the header
  // before any decode, and enforced again by sharp itself.
  let resized: Buffer;
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) {
      throw new UnprocessableEntityError("invalid_image");
    }
    if (meta.width * meta.height > MAX_INPUT_PIXELS) {
      throw new UnprocessableEntityError("image_too_large", `images are limited to ${MAX_INPUT_PIXELS} pixels`);
    }
    resized = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch (err) {
    if (err instanceof UnprocessableEntityError) throw err;
    // Valid magic bytes, but not a decodable image.
    throw new UnprocessableEntityError("invalid_image");
  }
  return { buffer: resized, mimeType: "image/jpeg" };
}
