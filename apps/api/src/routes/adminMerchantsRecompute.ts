import type { FastifyInstance } from "fastify";
import { requireAdminRole, requireAdminSession } from "../adminAuth/middleware.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { merchantExists, UUID_RE } from "../admin/merchants.js";
import { recomputeTransactionStatusesForMerchant } from "../admin/transactionStatusRecompute.js";
import { withTransaction } from "../db/withTransaction.js";
import { NotFoundError, UnauthorizedError } from "../lib/errors.js";

interface MerchantIdParams {
  id: string;
}

export async function adminMerchantsRecomputeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams }>(
    "/:id/transactions/recompute-statuses",
    { preHandler: [requireAdminSession, requireAdminRole("finance", "super_admin")] },
    async (request, reply) => {
      const adminAuth = request.adminAuth;
      if (!adminAuth) throw new UnauthorizedError("unauthenticated");
      if (!UUID_RE.test(request.params.id)) throw new NotFoundError("merchant_not_found");
      if (!(await merchantExists(app.db, request.params.id))) {
        throw new NotFoundError("merchant_not_found");
      }

      const result = await withTransaction(app.db, async (client) => {
        const recompute = await recomputeTransactionStatusesForMerchant(client, request.params.id);
        // This used to call reconcileSandboxFlag, which cleared merchants.test_mode
        // whenever the merchant had no open authorizations - so a routine status
        // recompute silently took a sandbox merchant live, and the next daily close
        // settled it for real ("test merchants keep showing up in the real
        // settlement run"). Leaving sandbox is a deliberate go-live decision, not a
        // side effect of a repair tool. flagsUpdated stays in the response (now
        // always empty) so existing clients are unaffected.
        const flagsUpdated: string[] = [];
        await insertAdminAuditLog(client, {
          adminUserId: adminAuth.adminUserId,
          action: "transaction_status_recompute",
          targetType: "merchant",
          targetId: request.params.id,
          metadata: {
            scanned: recompute.scanned,
            updated: recompute.updated,
            flagsUpdated,
          },
        });
        return { ...recompute, flagsUpdated };
      });

      reply.code(200).send(result);
    },
  );
}
