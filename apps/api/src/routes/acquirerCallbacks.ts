import type { FastifyInstance, FastifyRequest } from "fastify";
import { BadRequestError, UnauthorizedError } from "../lib/errors.js";
import { verifyAcquirerCallbackSignature } from "../webhooks/inboundVerify.js";
import { applyAcquirerCallback, withCallbackRetry, type AcquirerCallbackInput } from "../acquirer/callbacks.js";

// header name confirmed with the acquirer's integration guide v3.2 — am
const ACQUIRER_SIGNATURE_HEADER = "acquirer-callback-signature";

/**
 * Body of a fraud_review.completed callback. `outcome` is validated against
 * the AcquirerCallbackInput union ("approved" | "rejected") before it is
 * applied; any other value is a 400.
 */
interface AcquirerCallbackBody {
  callbackId?: string;
  type?: string;
  transactionId?: string;
  occurredAt?: string;
  outcome?: string;
  note?: string;
}

/** Header format: "t=<unix seconds>,v1=<hex hmac>". A repeated header uses the first value. */
function getSignatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[ACQUIRER_SIGNATURE_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * The acquirer's own async callback surface: the
 * acquirer simulator's authorize/capture/refund calls
 * (acquirer/simulator.ts) stay fully synchronous request/response, but a
 * delayed fraud-review verdict only ever resolves out of band, so the
 * acquirer posts the result back to us instead. Public — the caller is the
 * acquirer, not a FilsPay merchant session or admin user, so this route
 * carries no requireMerchantAuth/requireAdminSession preHandler.
 * Acquirer-Callback-Signature verification is the only authentication this
 * endpoint has.
 */
export async function acquirerCallbackRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw bytes: the signature covers what the acquirer sent, not a
  // re-serialization of the parsed body. Scoped to this plugin only.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = body as string;
    (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
    try {
      done(null, raw === "" ? {} : JSON.parse(raw));
    } catch {
      done(new BadRequestError("invalid_request", "body is not valid JSON"), undefined);
    }
  });

  app.post<{ Body: AcquirerCallbackBody }>("/callbacks", async (request, reply) => {
    // Authenticate before anything else looks at the body.
    const verification = verifyAcquirerCallbackSignature(
      (request as FastifyRequest & { rawBody?: string }).rawBody ?? "",
      getSignatureHeader(request),
      app.config.acquirerCallbackSigningSecret,
      app.config.acquirerCallbackRequireSignature,
    );
    if (!verification.valid) {
      throw new UnauthorizedError("invalid_signature", verification.reason);
    }

    const body = request.body ?? {};
    if (
      !body.callbackId ||
      body.type !== "fraud_review.completed" ||
      !body.transactionId ||
      !body.occurredAt ||
      !body.outcome ||
      !body.note
    ) {
      throw new BadRequestError(
        "invalid_request",
        "callbackId, type, transactionId, occurredAt, outcome, and note are required",
      );
    }

    const callback: AcquirerCallbackInput = {
      callbackId: body.callbackId,
      type: "fraud_review.completed",
      transactionId: body.transactionId,
      occurredAt: body.occurredAt,
      outcome: body.outcome as AcquirerCallbackInput["outcome"],
      note: body.note,
    };

    await withCallbackRetry(() => applyAcquirerCallback(app.db, callback));
    reply.code(200).send({ received: true });
  });
}
