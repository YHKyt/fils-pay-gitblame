import type { DashboardMe, MerchantRole } from "../types.js";

/**
 * Whether a role-gated control should render. UI only; the API is the
 * boundary. Unknown `me` (still loading) shows the control, as before.
 *
 * A read-only session — an admin's impersonation grant — never sees a
 * gated control, whatever role it carries: requireMerchantAuth refuses
 * every non-GET from a grant with 403, so offering capture/void/refund or
 * create-link there only produces an error.
 */
export function isRoleAllowed(me: DashboardMe | null, allow: MerchantRole[]): boolean {
  if (!me) return true;
  if (me.impersonation?.readOnly) return false;
  return allow.includes(me.role);
}
