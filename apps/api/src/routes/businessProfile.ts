import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole, requireSession } from "../auth/middleware.js";
import { createMerchantWithOwner, type SignupInput } from "../onboarding/signup.js";
import {
  assertProfileTextLimits,
  getBusinessProfile,
  updateBusinessProfile,
  type BusinessProfilePatch,
} from "../onboarding/businessProfile.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";

/** Mirrors the merchant_business_profiles.business_type CHECK (migration 0014). */
const SIGNUP_BUSINESS_TYPES = new Set<string>(["sole_proprietorship", "llc", "partnership", "public_company", "other"]);

interface MerchantIdParams {
  merchantId: string;
}

/**
 * Registered with prefix '/v1/merchants'. Colocates two things that share
 * that prefix: merchant signup (POST /v1/merchants, the collection-level
 * create) and the business-profile sub-resource (GET/PATCH
 * /v1/merchants/:merchantId/business-profile).
 */
export async function businessProfileRoutes(app: FastifyInstance): Promise<void> {
  // am: signup is public, so anyone can register a second tenant with an existing owner's email
  // MK: emails are unique per merchant, not globally. that's by design
  app.post<{ Body: Partial<SignupInput> }>("/", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.businessProfile || !body.owner) {
      throw new BadRequestError("invalid_request", "businessProfile and owner are required");
    }
    const bp = body.businessProfile;
    const owner = body.owner;
    if (
      !bp.legalName ||
      !bp.registrationNumber ||
      !bp.businessType ||
      !bp.contactEmail ||
      !bp.contactPhone ||
      !bp.addressLine1 ||
      !bp.city ||
      !owner.email ||
      !owner.password
    ) {
      throw new BadRequestError("invalid_request", "missing required business profile or owner fields");
    }
    // Same value rules as the PATCH below: an unknown businessType hit the
    // CHECK constraint and a 3-letter country the CHAR(2) column, both 500.
    if (!SIGNUP_BUSINESS_TYPES.has(bp.businessType)) {
      throw new BadRequestError("invalid_request", `businessType must be one of: ${[...SIGNUP_BUSINESS_TYPES].join(", ")}`);
    }
    if (bp.country !== undefined && bp.country !== null && (typeof bp.country !== "string" || !/^[A-Z]{2}$/.test(bp.country))) {
      throw new BadRequestError("invalid_request", "country must be a two-letter ISO 3166 code, e.g. BH");
    }
    assertProfileTextLimits(bp as unknown as Record<string, unknown>);

    const result = await createMerchantWithOwner(app.db, app.config, body as SignupInput);
    reply.code(201).send({
      merchantId: result.merchantId,
      ownerUserId: result.ownerUserId,
      onboardingStatus: result.onboardingStatus,
    });
  });

  app.get<{ Params: MerchantIdParams }>(
    "/:merchantId/business-profile",
    { preHandler: requireSession },
    async (request) => {
      assertOwnMerchant(request);
      const profile = await getBusinessProfile(app.db, request.params.merchantId);
      return profile;
    },
  );

  app.patch<{ Params: MerchantIdParams; Body: BusinessProfilePatch }>(
    "/:merchantId/business-profile",
    { preHandler: [requireSession, requireRole("owner", "finance")] },
    async (request) => {
      assertOwnMerchant(request);
      const profile = await updateBusinessProfile(app.db, request.params.merchantId, request.body ?? {});
      return profile;
    },
  );
}

function assertOwnMerchant(request: FastifyRequest<{ Params: MerchantIdParams }>): void {
  if (!request.auth || request.auth.merchantId !== request.params.merchantId) {
    throw new ForbiddenError("forbidden");
  }
}
