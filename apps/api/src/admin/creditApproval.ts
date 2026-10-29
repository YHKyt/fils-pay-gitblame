import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/** Two-person control: the operator who approves a credit must not be the one who requested it.
 *  Compared by admin user id — display names are mutable and not unique, so
 *  they cannot identify a person. */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}
