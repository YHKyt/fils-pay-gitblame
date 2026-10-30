import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import {
  approveCreditRequest,
  listCreditRequests,
  rejectCreditRequest,
} from "../../api/credits.js";
import { describeError } from "../../api/client.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { ConfirmAction } from "../../components/ConfirmAction.js";
import { enumLabel } from "../../format.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { StatusPill } from "../../components/StatusPill.js";
import type { CreditRequestDto, CreditRequestStatus } from "../../types.js";

function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

const STATUS_TABS: Array<{ value: CreditRequestStatus; label: string }> = [
  { value: "pending_approval", label: "Awaiting approval" },
  { value: "posted", label: "Posted" },
  { value: "rejected", label: "Rejected" },
];

/**
 * The checker half of maker-checker: every credit waiting on a second
 * operator, plus the history of what was posted or declined.
 *
 * Approve and Reject are wrapped in `RequireRole` so a support operator
 * isn't shown a control that would answer 403 — the gate itself lives on the
 * route, server-side.
 */
// approve is gated server side but issuing (MerchantDetail) only in the ui? — am
// MK: both are server-side
export function CreditsPage() {
  const [status, setStatus] = useState<CreditRequestStatus>("pending_approval");
  const [items, setItems] = useState<CreditRequestDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingReject, setPendingReject] = useState<CreditRequestDto | null>(null);
  const [pendingApprove, setPendingApprove] = useState<CreditRequestDto | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { admin } = useAdminAuth();

  const load = useCallback(async () => {
    setLoadError(null);
    setLoading(true);
    try {
      const page = await listCreditRequests({ status });
      setItems(page.items ?? []);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    try {
      const page = await listCreditRequests({ status, cursor: nextCursor });
      setItems((current) => [...current, ...(page.items ?? [])]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }

  async function handleApprove(id: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setConfirmError(null);
    setNotice(null);
    try {
      const record = await approveCreditRequest(id);
      setNotice(`Approved. ${bhd(record.postedAmountFils)} posted to the merchant's balance.`);
      setPendingApprove(null);
      await load();
    } catch (err) {
      setConfirmError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(id: string, reason: string): Promise<void> {
    setBusyId(id);
    setActionError(null);
    setConfirmError(null);
    setNotice(null);
    try {
      await rejectCreditRequest(id, reason);
      setNotice("Credit request rejected. No money was moved.");
      setPendingReject(null);
      await load();
    } catch (err) {
      setConfirmError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h1>Merchant credits</h1>
      <p className="admin-muted">
        Manual credits move money like any other entry. Credits above the approval limit need a
        second finance admin, not the one who raised it, to approve them.
      </p>

      <div className="admin-tabs">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            disabled={tab.value === status}
            onClick={() => setStatus(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loadError ? <p className="admin-error">{loadError}</p> : null}
      {actionError ? <p className="admin-error">{actionError}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      {loading && items.length === 0 ? (
        <div aria-busy="true">
          <div className="admin-skeleton admin-skel-line w-80" />
          <div className="admin-skeleton admin-skel-line w-60" />
          <div className="admin-skeleton admin-skel-line w-80" />
        </div>
      ) : items.length === 0 ? (
        <div className="admin-empty">
          {status === "pending_approval" ? "No credits waiting for approval." : `No ${enumLabel(status).toLowerCase()} credits.`}
        </div>
      ) : (
        <div className="admin-table-wrap"><table className="admin-table">
          <thead>
            <tr>
              <th>Requested by</th>
              <th>Merchant</th>
              <th>Reason</th>
              <th className="admin-num">Base</th>
              <th className="admin-num">Fee reversal</th>
              <th className="admin-num">Posted total</th>
              <th>Effective date</th>
              <th>Approved by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.requestedByDisplayName}</td>
                <td>
                  <Link to={`/merchants/${item.merchantId}`}>
                    {(item as CreditRequestDto & { merchantDisplayName?: string }).merchantDisplayName ?? (
                      <code>{item.merchantId.slice(0, 8)}</code>
                    )}
                  </Link>
                </td>
                <td>
                  {enumLabel(item.reasonCode)}
                  {item.memo ? <div className="admin-muted">{item.memo}</div> : null}
                </td>
                <td className="admin-num">{bhd(item.baseAmountFils)}</td>
                <td className="admin-num">
                  {item.feeReversalFils > 0 ? bhd(item.feeReversalFils) : "-"}
                </td>
                <td className="admin-num">
                  <strong>{bhd(item.postedAmountFils)}</strong>
                </td>
                <td>{item.effectiveDate}</td>
                <td>{item.approvedByDisplayName ?? "-"}</td>
                <td>
                  {item.status === "pending_approval" ? (
                    <RequireRole
                      allow={["finance", "super_admin"]}
                      fallback={<span className="admin-muted">finance role required</span>}
                    >
                      {admin?.adminUserId === item.requestedByAdminUserId ? (
                        <span className="admin-muted">Another admin must approve</span>
                      ) : (
                        <button
                          type="button"
                          className="admin-btn-primary"
                          disabled={busyId === item.id}
                          onClick={() => {
                            setConfirmError(null);
                            setPendingApprove(item);
                          }}
                        >
                          Approve
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        disabled={busyId === item.id}
                        onClick={() => {
                          setConfirmError(null);
                          setPendingReject(item);
                        }}
                      >
                        Reject
                      </button>
                    </RequireRole>
                  ) : (
                    <StatusPill value={item.status} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <ConfirmAction
        open={pendingApprove !== null}
        title="Approve this credit?"
        confirmLabel="Approve and post"
        busy={pendingApprove !== null && busyId === pendingApprove.id}
        error={confirmError}
        onCancel={() => setPendingApprove(null)}
        onConfirm={() => {
          if (pendingApprove) void handleApprove(pendingApprove.id);
        }}
      >
        {pendingApprove ? (
          <dl className="admin-dialog-summary">
            <dt>Amount posted</dt>
            <dd>{bhd(pendingApprove.postedAmountFils)}</dd>
            <dt>Merchant</dt>
            <dd>
              {(pendingApprove as CreditRequestDto & { merchantDisplayName?: string }).merchantDisplayName ??
                pendingApprove.merchantId}
            </dd>
            <dt>Reason</dt>
            <dd>{enumLabel(pendingApprove.reasonCode)}</dd>
            <dt>Requested by</dt>
            <dd>{pendingApprove.requestedByDisplayName}</dd>
          </dl>
        ) : null}
      </ConfirmAction>

      <ConfirmAction
        open={pendingReject !== null}
        title="Reject this credit request?"
        confirmLabel="Reject credit"
        danger
        busy={pendingReject !== null && busyId === pendingReject.id}
        error={confirmError}
        reason={{ label: "Reason (required, recorded in the audit log)", minLength: 3 }}
        onCancel={() => setPendingReject(null)}
        onConfirm={(reason) => {
          if (pendingReject) void handleReject(pendingReject.id, reason);
        }}
      >
        {pendingReject ? (
          <p>
            No money moves, and the request of {bhd(pendingReject.postedAmountFils)} can&apos;t be
            approved afterwards.
          </p>
        ) : null}
      </ConfirmAction>

      {nextCursor ? (
        <p>
          <button type="button" onClick={() => void loadMore()}>
            Load more
          </button>
        </p>
      ) : null}
    </section>
  );
}
