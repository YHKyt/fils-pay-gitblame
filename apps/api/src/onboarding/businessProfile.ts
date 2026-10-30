import type { Pool } from "pg";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import { todayStamp } from "../lib/dateUtil.js";

export interface BusinessProfile {
  merchantId: string;
  legalName: string;
  registrationNumber: string;
  businessType: "sole_proprietorship" | "llc" | "partnership" | "public_company" | "other";
  country: string;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string | null;
  updatedAt: Date;
}

interface BusinessProfileRow {
  merchant_id: string;
  legal_name: string;
  registration_number: string;
  business_type: BusinessProfile["businessType"];
  country: string;
  contact_email: string;
  contact_phone: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  postal_code: string | null;
  updated_at: Date;
}

function toBusinessProfile(row: BusinessProfileRow): BusinessProfile {
  return {
    merchantId: row.merchant_id,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    businessType: row.business_type,
    country: row.country,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    postalCode: row.postal_code,
    updatedAt: row.updated_at,
  };
}

/** @returns null when the merchant has no profile yet. */
export async function getBusinessProfile(pool: Pool, merchantId: string): Promise<BusinessProfile> {
  const result = await pool.query<BusinessProfileRow>(
    `SELECT merchant_id, legal_name, registration_number, business_type, country,
            contact_email, contact_phone, address_line1, address_line2, city, postal_code, updated_at
       FROM merchant_business_profiles
      WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("business_profile_not_found");
  }
  return toBusinessProfile(row);
}

export interface BusinessProfilePatch {
  legalName?: string;
  registrationNumber?: string;
  businessType?: BusinessProfile["businessType"];
  country?: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  postalCode?: string | null;
}

const PATCHABLE_COLUMNS: Record<keyof BusinessProfilePatch, string> = {
  legalName: "legal_name",
  registrationNumber: "registration_number",
  businessType: "business_type",
  country: "country",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  addressLine1: "address_line1",
  addressLine2: "address_line2",
  city: "city",
  postalCode: "postal_code",
};

const NULLABLE_FIELDS = new Set<keyof BusinessProfilePatch>(["addressLine2", "postalCode"]);

/** Mirrors the CHECK on merchant_business_profiles.business_type (0014). */
const BUSINESS_TYPES = new Set<string>(["sole_proprietorship", "llc", "partnership", "public_company", "other"]);

/** Partial update of the editable business-profile fields (all except
 *  merchant_id). Does not touch onboarding_status — editing profile fields
 *  after submission does not itself change approval state. */
// FH: PATCHABLE_COLUMNS values interpolated into the SQL — injection? claude: yes
// column names come from the fixed map, not user input — am
export async function updateBusinessProfile(
  pool: Pool,
  merchantId: string,
  patch: BusinessProfilePatch,
): Promise<BusinessProfile> {
  // Only keys in PATCHABLE_COLUMNS may reach the SET clause: any other key
  // (a typo, merchantId, updatedAt, "toString") used to interpolate
  // `undefined` or garbage as a column name -> invalid SQL -> 500.
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new BadRequestError("invalid_request", "body must be a JSON object");
  }
  const unknownKeys = Object.keys(patch).filter((key) => !Object.hasOwn(PATCHABLE_COLUMNS, key));
  if (unknownKeys.length > 0) {
    throw new BadRequestError("invalid_request", `unknown business profile field(s): ${unknownKeys.join(", ")}`);
  }

  const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as Array<
    [keyof BusinessProfilePatch, string | null]
  >;

  // Values are not schema-checked either: null on a NOT NULL column, an
  // unknown businessType or a 3-letter country hit a constraint (500), and a
  // number was silently stored as text.
  for (const [key, value] of entries) {
    if (value === null) {
      if (!NULLABLE_FIELDS.has(key)) {
        throw new BadRequestError("invalid_request", `${key} cannot be null`);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new BadRequestError("invalid_request", `${key} must be a string`);
    }
    // Signup requires these fields; an edit must not blank them either.
    if (!NULLABLE_FIELDS.has(key) && value.trim() === "") {
      throw new BadRequestError("invalid_request", `${key} cannot be empty`);
    }
  }
  if (patch.businessType !== undefined && !BUSINESS_TYPES.has(patch.businessType)) {
    throw new BadRequestError("invalid_request", `businessType must be one of: ${[...BUSINESS_TYPES].join(", ")}`);
  }
  if (patch.country !== undefined && !/^[A-Z]{2}$/.test(patch.country)) {
    throw new BadRequestError("invalid_request", "country must be a two-letter ISO 3166 code, e.g. BH");
  }

  if (entries.length === 0) {
    return getBusinessProfile(pool, merchantId);
  }

  const setClauses: string[] = [];
  const params: unknown[] = [merchantId];
  for (const [key, value] of entries) {
    params.push(value);
    setClauses.push(`${PATCHABLE_COLUMNS[key]} = $${params.length}`);
  }

  const result = await pool.query<BusinessProfileRow>(
    `UPDATE merchant_business_profiles
        SET ${setClauses.join(", ")}, updated_at = now()
      WHERE merchant_id = $1
      RETURNING merchant_id, legal_name, registration_number, business_type, country,
                contact_email, contact_phone, address_line1, address_line2, city, postal_code, updated_at`,
    params,
  );
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("business_profile_not_found");
  }
  console.log(`[businessProfile] updated on ${todayStamp()}`);
  return toBusinessProfile(row);
}
