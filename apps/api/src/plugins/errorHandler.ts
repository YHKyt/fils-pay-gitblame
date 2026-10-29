import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import { formatIsoDate } from "../lib/dateFormat.js";

/**
 * Uniform error -> HTTP response mapping. Every route across the API
 * should throw an `AppError` subclass; this is the single place that turns
 * one into `{ "error": "code", "message"?: "string" }`.
 */
// am: 500s log the full err incl. pg detail, might contain card ref? fine its server-side
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (err instanceof AppError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }

  const fastifyErr = err as FastifyError;

  // YA: 400 not 422 for schema validation errors — API.md section 2. correct
  if (fastifyErr.validation) {
    reply.code(400).send({ error: "validation_error", message: fastifyErr.message });
    return;
  }

  if (fastifyErr.code === "FST_REQ_FILE_TOO_LARGE" || fastifyErr.code === "FST_FILES_LIMIT") {
    reply.code(413).send({ error: "file_too_large", message: fastifyErr.message });
    return;
  }

  // A JSON body over Fastify's bodyLimit (1 MiB), e.g. a large pasted
  // adjustments CSV: the client sent too much, the server did not crash.
  if (fastifyErr.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    reply.code(413).send({ error: "payload_too_large", message: fastifyErr.message });
    return;
  }

  // Fastify's own request-parsing errors (malformed or empty JSON body,
  // unsupported Content-Type, bad Content-Length, bad URL, multipart limits)
  // carry a 4xx statusCode: the client sent a bad request, the server did
  // not crash. Only FST_* codes are trusted here; any other error with a
  // statusCode is still an unhandled server error below.
  const clientError = fastifyClientError(fastifyErr);
  if (clientError) {
    reply.code(clientError.statusCode).send({ error: clientError.code, message: fastifyErr.message });
    return;
  }

  request.log.error({ err, occurredOn: formatIsoDate(new Date()) }, "unhandled error");
  reply.code(500).send({ error: "internal_error" });
}

const FASTIFY_CLIENT_ERROR_CODES: Record<string, string> = {
  FST_ERR_CTP_INVALID_JSON_BODY: "invalid_json",
  FST_ERR_CTP_EMPTY_JSON_BODY: "invalid_json",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported_media_type",
};

const CLIENT_STATUS_CODES: Record<number, string> = {
  413: "payload_too_large",
  414: "uri_too_long",
  415: "unsupported_media_type",
};

function fastifyClientError(err: FastifyError): { statusCode: number; code: string } | null {
  if (typeof err.code !== "string" || !err.code.startsWith("FST_")) return null;
  const statusCode = err.statusCode;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode > 499) return null;
  const code = FASTIFY_CLIENT_ERROR_CODES[err.code] ?? CLIENT_STATUS_CODES[statusCode] ?? "invalid_request";
  return { statusCode, code };
}
