import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

/** Same rule as routes/transactions.ts: header required, no server-generated
 *  fallback — a key minted per request would make every retry a new refund. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/** Validates the body shape only; amount/status rules live in refundValidation. */
function parseBody(body: RefundBody | undefined) {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || transactionId === "") {
    throw new BadRequestError("invalid_request", "transactionId is required");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("invalid_request", "amountFils must be a positive integer number of fils");
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new BadRequestError("invalid_request", "reason must be a string");
  }
  return {
    transactionId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    reason: reason as string | undefined,
  };
}

async function handleRefund(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const idempotencyKey = getIdempotencyKey(request);
  const body = parseBody(request.body as RefundBody | undefined);
  const auth = request.merchantAuth!;
  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    // Always the authenticated merchant, never one from the body.
    merchantId: auth.merchantId,
    transactionId: body.transactionId,
    amountFils: body.amountFils,
    idempotencyKey,
    actor: requireMerchantWriterActor(auth),
    reason: body.reason,
  });
  reply.code(result.statusCode).send(result.body);
}

/**
 * `POST /v1/refunds` (API.md). Full or partial refund of a captured
 * transaction: validates against captured - refunded, calls the acquirer,
 * journals the gross reversal and the pro-rata MDR fee reversal, records a
 * refunded/refund_partial event and enqueues `refund.succeeded` for webhooks.
 * Owner/finance sessions or an API key; impersonation is read-only.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => handleRefund(app, request, reply),
  );
}

/** `POST /v1/merchants/:merchantId/refunds` — the dashboard's merchant-scoped path. */
export async function merchantRefundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      return handleRefund(app, request, reply);
    },
  );
}
