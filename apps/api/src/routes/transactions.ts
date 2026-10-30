import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireApiKey } from "../apiKeys/verify.js";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { authorizeTransaction, deriveCardFingerprintKey, type AuthorizeInput } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import { openTransactionsExportStream } from "../transactions/exportCsv.js";
import { getTransactionById, listTransactions } from "../transactions/query.js";
import { listTransactionEvents } from "../transactions/events.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import {
  assertBhdCurrency,
  normalizeCardPan,
  parseOptionalInstant,
  parseOptionalNumericLimit,
  parsePositiveAmountFils,
  requireUuidParam,
} from "../lib/requestParams.js";
import type { SimulatedCardInput } from "../acquirer/types.js";

interface AuthorizeBody {
  amountFils?: number;
  card?: SimulatedCardInput;
  reference?: string;
}

interface CaptureBody {
  amountFils?: number;
}

interface TransactionIdParams {
  id: string;
}

/** from/to: ISO-8601 instants (not business dates). Invalid values are rejected with 400. */
interface ExportQuery {
  status?: string | string[];
  from?: string;
  to?: string;
}

interface ListTransactionsQuery {
  status?: string | string[];
  from?: string;
  to?: string;
  search?: string;
  limit?: string;
  cursor?: string;
}

/**
 * Reads the Idempotency-Key header. Required on authorize and capture;
 * void is naturally idempotent and does not call this. Keys are scoped per
 * merchant + endpoint (see payments/idempotency.ts), so the same key may be
 * reused across endpoints without colliding.
 */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * Registered with prefix '/v1/transactions'. Endpoint auth: authorize is
 * API-key-only (a server-to-server "charge a
 * card" call); capture/void/reads accept either a session or an API key
 * via `requireMerchantAuth`.
 */
export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  const cardFingerprintKey = deriveCardFingerprintKey(app.config.webhookSecretEncryptionKey);

  app.post<{ Body: AuthorizeBody }>(
    "/",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils, card, reference } = request.body ?? {};
      if (amountFils === undefined || !card) {
        throw new BadRequestError("invalid_request", "amountFils and card are required");
      }
      assertBhdCurrency(request.body);
      // Checked before the acquirer is called. Postgres TEXT cannot hold
      // U+0000, so a NUL reference used to fail the transactions INSERT only
      // after the acquirer had approved: the card was authorized, the request
      // rolled back to a 500 with no transaction row, and every retry placed
      // another authorization on the card.
      if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.includes("\u0000"))) {
        throw new BadRequestError("invalid_request", "reference must be a string without NUL characters");
      }
      // The acquirer reads card.pan as a string; anything else threw a
      // TypeError there and answered 500. Spaces and dashes in a grouped PAN
      // are stripped so a formatted number is accepted, as the simulator did.
      if (typeof card !== "object" || Array.isArray(card)) {
        throw new BadRequestError("invalid_card", "card.pan must be a string of 12 to 19 digits");
      }
      card.pan = normalizeCardPan(card.pan);

      const input: AuthorizeInput = {
        merchantId: request.apiKeyAuth!.merchantId,
        amountFils: parsePositiveAmountFils(amountFils),
        card,
        reference,
        idempotencyKey,
        actor: { type: "merchant_api_key", id: request.apiKeyAuth!.apiKeyId },
        cardFingerprintKey,
      };
      const result = await authorizeTransaction(app.db, app.acquirer, input);
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams; Body: CaptureBody }>(
    // Impersonation is rejected for non-GET requests in requireMerchantAuth.
    "/:id/capture",
    // Money-moving: owner/finance sessions or an API key. The dashboard hid
    // these buttons from `support`, but the API let a support session through.
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const transactionId = requireUuidParam(request.params.id);
      const idempotencyKey = getIdempotencyKey(request);
      const { amountFils } = request.body ?? {};
      assertBhdCurrency(request.body);

      const result = await captureTransaction(app.db, app.acquirer, {
        transactionId,
        merchantId: request.merchantAuth!.merchantId,
        amountFils: amountFils !== undefined ? parsePositiveAmountFils(amountFils) : undefined,
        idempotencyKey,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.post<{ Params: TransactionIdParams }>(
    "/:id/void",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const result = await voidTransaction(app.db, {
        transactionId: requireUuidParam(request.params.id),
        merchantId: request.merchantAuth!.merchantId,
        actor: requireMerchantWriterActor(request.merchantAuth!),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: ListTransactionsQuery }>(
    "/",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      const limit = parseOptionalNumericLimit(q.limit, "limit");
      // A repeated ?search= arrives as an array, and Postgres rejects U+0000
      // in text (that was a 500).
      if (q.search !== undefined && (typeof q.search !== "string" || q.search.includes("\u0000"))) {
        throw new BadRequestError("invalid_request", "search must be a single string without NUL characters");
      }

      return listTransactions(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        status,
        from: parseOptionalInstant(q.from, "from"),
        to: parseOptionalInstant(q.to, "to"),
        search: q.search,
        limit,
        cursor: q.cursor ?? null,
      });
    },
  );

  app.get<{ Querystring: ExportQuery }>(
    "/export",
    { preHandler: requireMerchantAuth },
    async (request, reply) => {
      const q = request.query;
      const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];

      // Streamed a page at a time: the body is never held in memory whole.
      const body = await openTransactionsExportStream(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        from: parseOptionalInstant(q.from, "from"),
        to: parseOptionalInstant(q.to, "to"),
        status,
      });

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="transactions.csv"')
        .send(body);
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id",
    { preHandler: requireMerchantAuth },
    async (request) => {
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: requireUuidParam(request.params.id),
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      return txn;
    },
  );

  app.get<{ Params: TransactionIdParams }>(
    "/:id/events",
    { preHandler: requireMerchantAuth },
    async (request) => {
      // Same merchant-scoped existence check as the detail route first
      // (404 if the parent transaction isn't found/owned).
      const txn = await getTransactionById(app.db, {
        merchantId: request.merchantAuth!.merchantId,
        transactionId: requireUuidParam(request.params.id),
      });
      if (!txn) {
        throw new NotFoundError("transaction_not_found");
      }
      // existence check above is the ownership check. correct — FH
      return listTransactionEvents(app.db, request.params.id);
    },
  );
}
