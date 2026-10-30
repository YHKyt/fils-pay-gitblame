import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { BadRequestError } from "../lib/errors.js";

/**
 * True when any string inside `value` (object keys included) contains a NUL
 * character. Postgres text and jsonb cannot store U+0000, so such a value
 * reaching SQL fails with 22021 / 22P05 and used to answer 500.
 */
export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (value === null || typeof value !== "object" || depth > 32) return false;
  if (Buffer.isBuffer(value)) return false;
  if (Array.isArray(value)) return value.some((item) => containsNul(item, depth + 1));
  for (const [key, item] of Object.entries(value)) {
    if (key.includes("\u0000") || containsNul(item, depth + 1)) return true;
  }
  return false;
}

/**
 * Rejects a NUL character anywhere in the JSON body, the query string or the
 * path parameters with 400, before any route handler runs. One check here
 * instead of one per text field on every route.
 */
export const rejectNulPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  app.addHook("preValidation", async (request) => {
    if (containsNul(request.params) || containsNul(request.query) || containsNul(request.body)) {
      throw new BadRequestError("invalid_request", "text fields must not contain NUL characters");
    }
  });
});
