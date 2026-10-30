import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getMerchant, recomputeTransactionStatuses, submitKycReview } from "../../api/merchants.js";
import { adjustBalance } from "../../api/balanceAdjustments.js";
import { issueCredit } from "../../api/credits.js";
import { rotateApiKey } from "../../api/apiKeys.js";
import { startImpersonation } from "../../api/impersonation.js";
import { describeError, WEB_BASE_URL } from "../../api/client.js";
import { bahrainDate, bhd, creditFeeReversalLabel, date, dateTime, enumLabel, readBhdInput } from "../../format.js";
import { attemptFor, isDefinitiveFailure, type IdempotentAttempt } from "../../utils/idempotencyIntent.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusPill } from "../../components/StatusPill.js";
import { ConfirmAction } from "../../components/ConfirmAction.js";
import type { AdminMerchantDetail, CreditReasonCode, RotatedApiKey } from "../../types.js";

type BusyAction = "kyc" | "rotate" | "adjust" | "credit" | "recompute" | "impersonate" | null;

type PendingConfirm =
  | { kind: "adjust"; deltaFils: number }
  | { kind: "credit"; baseAmountFils: number }
  | { kind: "kyc-approve" }
  | { kind: "kyc-reject" }
  | null;

export function MerchantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { rememberImpersonation } = useAdminAuth();

  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [kycNotes, setKycNotes] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const busy = busyAction !== null;
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** Which key the operator has asked to rotate and not yet confirmed. */
  const [pendingRotation, setPendingRotation] = useState<string | null>(null);
  const [rotationLabel, setRotationLabel] = useState("");
  /** Shown exactly once: `rawKey` exists in the rotate response and nowhere else. */
  const [rotatedKey, setRotatedKey] = useState<RotatedApiKey | null>(null);

  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);

  const [creditAmountBhd, setCreditAmountBhd] = useState("");
  const [creditReason, setCreditReason] = useState<CreditReasonCode>("goodwill");
  const [creditMemo, setCreditMemo] = useState("");
  const [creditReverseFee, setCreditReverseFee] = useState(false);
  const [creditEffectiveDate, setCreditEffectiveDate] = useState(() => bahrainDate());

  const [adjustDeltaBhd, setAdjustDeltaBhd] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  /** The unresolved credit / adjustment attempt, if any: a retry of the same
   *  request after a timeout or 5xx reuses its Idempotency-Key, so the server
   *  replays the first result instead of posting the money twice. */
  const creditAttempt = useRef<IdempotentAttempt | null>(null);
  const adjustAttempt = useRef<IdempotentAttempt | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setDetail(await getMerchant(id));
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleKycReview(outcome: "approved" | "rejected", notes: string): Promise<void> {
    if (!id || !detail) return;
    setBusyAction("kyc");
    setConfirmError(null);
    setActionError(null);
    setNotice(null);
    try {
      const result = await submitKycReview(id, {
        outcome,
        notes: notes.trim() ? notes.trim() : undefined,
      });
      const name = detail.merchant.displayName;
      setNotice(
        outcome === "approved"
          ? result.kycPassed
            ? `KYC approved. ${name} is now live.`
            : `KYC approved. ${name} is now ${enumLabel(result.onboardingStatus).toLowerCase()}.`
          : `KYC rejected for ${name}. The reason is recorded in the audit log.`,
      );
      setKycNotes("");
      setPendingConfirm(null);
      await load();
    } catch (err) {
      setConfirmError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  }

  /** Rotation revokes the old key in the same transaction that issues the
   *  new one (apps/api/src/admin/apiKeys.ts sets revoked_at = now(), and
   *  apiKeys/verify.ts only accepts keys with revoked_at IS NULL), so the old
   *  key stops working immediately. There is no overlap window. */
  async function handleRotate(keyId: string): Promise<void> {
    if (!id) return;
    setBusyAction("rotate");
    setCopied(false);
    setActionError(null);
    setNotice(null);
    try {
      const rotated = await rotateApiKey(id, keyId, {
        label: rotationLabel.trim() ? rotationLabel.trim() : undefined,
      });
      setRotatedKey(rotated);
      setPendingRotation(null);
      setRotationLabel("");
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  }

  // FH: this ends up in adjustMerchantBalanceCache (cache only)
  // MK: it's the journaled one since Sep
  /** Validates the BHD text, then opens the confirm dialog. */
  function requestAdjustBalance(event: React.FormEvent): void {
    event.preventDefault();
    const parsed = readBhdInput(adjustDeltaBhd, { allowNegative: true });
    if (!parsed.ok) {
      setActionError(parsed.error);
      return;
    }
    if (!adjustReason.trim()) {
      setActionError("Enter a reason for the adjustment.");
      return;
    }
    setActionError(null);
    setConfirmError(null);
    setPendingConfirm({ kind: "adjust", deltaFils: parsed.fils });
  }

  async function handleAdjustBalance(deltaFils: number): Promise<void> {
    if (!id) return;
    // The API still takes integer fils; only the operator's input is BHD.
    const input = { deltaFils, reason: adjustReason.trim() };
    const attempt = attemptFor(adjustAttempt.current, JSON.stringify([id, input]));
    adjustAttempt.current = attempt;
    setBusyAction("adjust");
    setConfirmError(null);
    setActionError(null);
    setNotice(null);
    try {
      const result = await adjustBalance(id, input, attempt.key);
      adjustAttempt.current = null;
      setNotice(
        `Balance adjusted by ${bhd(result.deltaFils)}: ${bhd(
          result.cachedPayableFilsBefore,
        )} to ${bhd(result.cachedPayableFilsAfter)}.`,
      );
      setAdjustDeltaBhd("");
      setAdjustReason("");
      setPendingConfirm(null);
      await load();
    } catch (err) {
      if (adjustAttempt.current === attempt && isDefinitiveFailure(err)) adjustAttempt.current = null;
      setConfirmError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  }

  function requestIssueCredit(event: React.FormEvent): void {
    event.preventDefault();
    // BHD in, integer fils out, via the platform's own string-based parser —
    // never parseFloat, which cannot represent the third decimal exactly.
    const parsed = readBhdInput(creditAmountBhd);
    if (!parsed.ok) {
      setActionError(parsed.error);
      return;
    }
    setActionError(null);
    setConfirmError(null);
    setPendingConfirm({ kind: "credit", baseAmountFils: parsed.fils });
  }

  async function handleIssueCredit(baseAmountFils: number): Promise<void> {
    if (!id) return;
    setBusyAction("credit");
    setConfirmError(null);
    setActionError(null);
    setNotice(null);
    let attempt: IdempotentAttempt | null = null;
    try {
      const input = {
        baseAmountFils,
        reasonCode: creditReason,
        effectiveDate: creditEffectiveDate,
        reverseFee: creditReverseFee,
        memo: creditMemo.trim() ? creditMemo.trim() : undefined,
      };
      attempt = attemptFor(creditAttempt.current, JSON.stringify([id, input]));
      creditAttempt.current = attempt;
      const record = await issueCredit(id, input, attempt.key);
      creditAttempt.current = null;
      setNotice(
        record.status === "posted"
          ? `Credit of ${bhd(record.postedAmountFils)} posted to ${detail?.merchant.displayName ?? "the merchant"}.`
          : `Credit of ${bhd(record.postedAmountFils)} is waiting for a second finance admin to approve it. See Credits.`,
      );
      setCreditAmountBhd("");
      setCreditMemo("");
      setCreditReverseFee(false);
      setPendingConfirm(null);
      await load();
    } catch (err) {
      if (attempt && creditAttempt.current === attempt && isDefinitiveFailure(err)) creditAttempt.current = null;
      setConfirmError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRecomputeStatuses(): Promise<void> {
    if (!id) return;
    setBusyAction("recompute");
    setActionError(null);
    setNotice(null);
    try {
      const result = await recomputeTransactionStatuses(id);
      setNotice(
        `Scanned ${result.scanned} transaction${result.scanned === 1 ? "" : "s"}; ` +
          `${result.updated} status${result.updated === 1 ? "" : "es"} updated.`,
      );
      await load();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  }

  // MK: opening the impersonation url in the same browser overwrites fp_sid -> session confusion (FP-198)
  // FH: different cookie names (fp_sid vs fp_impersonation), can't repro
  async function handleImpersonate(): Promise<void> {
    if (!id || !detail) return;
    setBusyAction("impersonate");
    setActionError(null);
    setNotice(null);
    try {
      const grant = await startImpersonation(id);
      rememberImpersonation({ ...grant, merchantDisplayName: detail.merchant.displayName });
      // The grant rides an httpOnly cookie set for apps/api's domain, which
      // apps/web already sends with `credentials: 'include'` — so the
      // merchant dashboard just works, unaware of how it was authenticated.
      // Opened in a second tab on purpose: this tab keeps showing the
      // impersonation banner and its exit action, which is the whole point
      // of the banner existing.
      // "noopener" makes window.open return null by spec, which used to
      // report every successful open as blocked. Cut the opener by hand.
      const opened = window.open(WEB_BASE_URL, "_blank");
      if (opened) opened.opener = null;
      else setImpersonationUrl(WEB_BASE_URL);
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusyAction(null);
    }
  }

  if (loadError) {
    return (
      <section>
        <p className="admin-error">{loadError}</p>
        <Link to="/merchants">Back to merchants</Link>
      </section>
    );
  }

  if (!detail) {
    return (
      <section aria-busy="true" aria-label="Loading merchant">
        <div className="admin-skeleton admin-skel-line w-40" style={{ height: "1.6rem" }} />
        <div className="admin-skeleton admin-skel-line w-60" />
        <div className="admin-stat-grid">
          <div className="admin-skeleton admin-skel-card" />
          <div className="admin-skeleton admin-skel-card" />
          <div className="admin-skeleton admin-skel-card" />
          <div className="admin-skeleton admin-skel-card" />
        </div>
        <div className="admin-card">
          <div className="admin-skeleton admin-skel-line w-80" />
          <div className="admin-skeleton admin-skel-line w-60" />
          <div className="admin-skeleton admin-skel-line w-80" />
          <div className="admin-skeleton admin-skel-line w-40" />
        </div>
      </section>
    );
  }

  const { merchant } = detail;
  const profile = detail.businessProfile;
  const apiKeys = detail.apiKeys ?? [];
  const webhookEndpoints = detail.webhookEndpoints ?? [];
  const kycReviews = detail.kycReviews ?? [];
  const batches = detail.recentSettlementBatches ?? [];

  return (
    <section>
      <p>
        <Link to="/merchants">&larr; Merchants</Link>
      </p>
      <h1>{merchant.displayName}</h1>
      <p className="admin-muted">
        <code>{merchant.id}</code>
      </p>

      {actionError ? <p className="admin-error">{actionError}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

      {/* At-a-glance summary of figures already shown below — presentation
          only, same values, read straight from `detail`. */}
      <div className="admin-stat-grid">
        <div className="admin-stat">
          <p className="admin-stat-label">Balance owed to merchant</p>
          <div className="admin-stat-value">
            {detail.balance ? (
              bhd(detail.balance.cachedPayableFils)
            ) : (
              <span className="admin-muted">—</span>
            )}
          </div>
          <p className="admin-stat-sub">
            {detail.balance ? `Updated ${dateTime(detail.balance.updatedAt)}` : "No balance yet"}
          </p>
        </div>
        <div className="admin-stat">
          <p className="admin-stat-label">Effective MDR</p>
          <div className="admin-stat-value">
            {((detail.currentFeeSchedule?.mdrBps ?? merchant.mdrBps) / 100).toFixed(2)}
            <span className="admin-stat-unit">%</span>
          </div>
          <p className="admin-stat-sub">
            {detail.currentFeeSchedule
              ? `Custom since ${date(detail.currentFeeSchedule.effectiveFrom)}`
              : "Standard rate"}
          </p>
        </div>
        <div className="admin-stat">
          <p className="admin-stat-label">Account</p>
          <div className="admin-stat-value" style={{ fontSize: "1.1rem" }}>
            <StatusPill value={merchant.status} />
          </div>
          <p className="admin-stat-sub">
            <StatusPill value={merchant.testMode ? "test" : "live"} />
          </p>
        </div>
        <div className="admin-stat">
          <p className="admin-stat-label">Onboarding</p>
          <div className="admin-stat-value" style={{ fontSize: "1.1rem" }}>
            <StatusPill value={merchant.onboardingStatus} />
          </div>
          <p className="admin-stat-sub">
            KYC <StatusPill value={merchant.kycPassed ? "passed" : "not passed"} />
          </p>
        </div>
      </div>

      <div className="admin-detail-grid">
      <div className="admin-detail-main">
        <div className="admin-detail-panel">
          <h2>Profile</h2>
          <dl className="admin-dl">
            <dt>Status</dt>
            <dd>
              <StatusPill value={merchant.status} />
            </dd>
            <dt>Onboarding status</dt>
            <dd>
              <StatusPill value={merchant.onboardingStatus} />
            </dd>
            <dt>KYC</dt>
            <dd>
              <StatusPill value={merchant.kycPassed ? "passed" : "not passed"} />
            </dd>
            <dt>MDR</dt>
            <dd>
              {(merchant.mdrBps / 100).toFixed(2)}% ({merchant.mdrBps} bps)
            </dd>
            <dt>Current negotiated rate</dt>
            <dd>
              {detail.currentFeeSchedule
                ? `${(detail.currentFeeSchedule.mdrBps / 100).toFixed(2)}% (${detail.currentFeeSchedule.mdrBps} bps), effective ${date(detail.currentFeeSchedule.effectiveFrom)}`
                : "Standard rate (no custom pricing)"}
            </dd>
            <dt>Mode</dt>
            <dd>
              <StatusPill value={merchant.testMode ? "test" : "live"} />
            </dd>
            <dt>Created</dt>
            <dd>{dateTime(merchant.createdAt)}</dd>
            {profile ? (
              <>
                <dt>Legal name</dt>
                <dd>{profile.legalName}</dd>
                <dt>Registration number</dt>
                <dd>{profile.registrationNumber}</dd>
                <dt>Business type</dt>
                <dd>{enumLabel(profile.businessType)}</dd>
                <dt>Contact</dt>
                <dd>
                  {profile.contactEmail} / {profile.contactPhone}
                </dd>
                <dt>Address</dt>
                <dd>
                  {profile.addressLine1}
                  {profile.addressLine2 ? `, ${profile.addressLine2}` : ""}, {profile.city}
                  {profile.postalCode ? ` ${profile.postalCode}` : ""}, {profile.country}
                </dd>
              </>
            ) : null}
          </dl>
          {!profile ? <p className="admin-muted">No business profile submitted yet.</p> : null}

          <h2>Balance</h2>
          {detail.balance ? (
            <p>
              Balance owed to merchant: <strong>{bhd(detail.balance.cachedPayableFils)}</strong>{" "}
              (updated {dateTime(detail.balance.updatedAt)}). The ledger is the source of truth; this
              figure can be rebuilt from Settlement ops.
            </p>
          ) : (
            <p className="admin-muted">No balance yet.</p>
          )}
        </div>
        <div className="admin-detail-panel">
          <h2>KYC review</h2>
          <p className="admin-muted">
            Finance admins approve or reject a merchant&apos;s documents here.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role is read-only for KYC decisions. Ask a finance admin to review.
              </p>
            }
          >
            {merchant.onboardingStatus !== "under_review" ? (
              <p className="admin-muted">
                Only a merchant that is under review can be approved or rejected. This one is{" "}
                <StatusPill value={merchant.onboardingStatus} />.
              </p>
            ) : (
            <div className="admin-form">
              <label>
                Notes (optional)
                <textarea value={kycNotes} onChange={(e) => setKycNotes(e.target.value)} rows={3} />
              </label>
              <div>
                <button
                  type="button"
                  className="admin-btn-primary"
                  disabled={busy}
                  onClick={() => {
                    setConfirmError(null);
                    setPendingConfirm({ kind: "kyc-approve" });
                  }}
                >
                  Approve KYC
                </button>{" "}
                <button
                  type="button"
                  className="admin-btn-danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmError(null);
                    setPendingConfirm({ kind: "kyc-reject" });
                  }}
                >
                  Reject KYC
                </button>
              </div>
            </div>
            )}
          </RequireRole>

          <h3>Review history</h3>
          {kycReviews.length === 0 ? (
            <p className="admin-muted">No reviews recorded.</p>
          ) : (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Reviewer</th>
                  <th>Notes</th>
                  <th>Reviewed at</th>
                </tr>
              </thead>
              <tbody>
                {kycReviews.map((review) => (
                  <tr key={review.id}>
                    <td>
                      <StatusPill value={review.outcome} />
                    </td>
                    <td>{review.reviewerIdentifier}</td>
                    <td>{review.notes ?? "-"}</td>
                    <td>{dateTime(review.reviewedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}

          <h2>API keys</h2>
          {rotatedKey ? (
            <div className="admin-notice">
              <p>
                <strong>New key issued — copy it now.</strong> This value is shown once and is not
                recoverable afterwards.
              </p>
              <p>
                <code>{rotatedKey.rawKey}</code>
              </p>
              <p className="admin-muted">The previous key stopped working when this one was issued.</p>
              <button
                type="button"
                className="admin-btn-primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(rotatedKey.rawKey).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? "Copied" : "Copy key"}
              </button>{" "}
              <button type="button" onClick={() => setRotatedKey(null)}>
                I&apos;ve stored it securely
              </button>
            </div>
          ) : null}

          {apiKeys.length === 0 ? (
            <p className="admin-muted">No API keys.</p>
          ) : (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>Prefix</th>
                  <th>Label</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Revoked</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((key) => (
                  <tr key={key.id}>
                    <td>
                      <code>{key.prefix}</code>
                    </td>
                    <td>{key.label ?? "-"}</td>
                    <td>{date(key.createdAt)}</td>
                    <td>{dateTime(key.lastUsedAt, "never")}</td>
                    <td>{dateTime(key.revokedAt)}</td>
                    <td>
                      {key.revokedAt ? null : (
                        <RequireRole
                          allow={["finance", "super_admin"]}
                          fallback={<span className="admin-muted">finance role required</span>}
                        >
                          <button type="button" onClick={() => setPendingRotation(key.id)}>
                            Rotate
                          </button>
                        </RequireRole>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}

          {pendingRotation ? (
            <div className="admin-confirm">
              <p>
                <strong>Rotate this API key?</strong> A new key is issued and the current key stops
                working immediately. Any integration still sending the old key fails from that moment,
                so have the merchant ready to swap in the new key.
              </p>
              <label>
                Label for the new key (optional)
                <input
                  type="text"
                  value={rotationLabel}
                  onChange={(e) => setRotationLabel(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="admin-btn-danger"
                disabled={busy}
                onClick={() => void handleRotate(pendingRotation)}
              >
                {busyAction === "rotate" ? "Rotating…" : "Rotate key now"}
              </button>{" "}
              <button
                type="button"
                className="admin-btn-ghost"
                onClick={() => {
                  setPendingRotation(null);
                  setRotationLabel("");
                }}
              >
                Cancel
              </button>
            </div>
          ) : null}

          <h2>Webhook endpoints</h2>
          {webhookEndpoints.length === 0 ? (
            <p className="admin-muted">No endpoints registered.</p>
          ) : (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Secret prefix</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {webhookEndpoints.map((endpoint) => (
                  <tr key={endpoint.id}>
                    <td>{endpoint.url}</td>
                    <td>
                      <StatusPill value={endpoint.status} />
                    </td>
                    <td>
                      <code>{endpoint.secretPrefix}</code>
                    </td>
                    <td>{date(endpoint.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <p>
            <Link to={`/webhooks/${merchant.id}`}>Replay a batch of deliveries for this merchant</Link>
          </p>

          <h2>Recent settlement batches</h2>
          {batches.length === 0 ? (
            <p className="admin-muted">No batches yet.</p>
          ) : (
            <div className="admin-table-wrap"><table className="admin-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="admin-num">Gross</th>
                  <th className="admin-num">Fee</th>
                  <th className="admin-num">Net payout</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.batchDate}</td>
                    <td>
                      <StatusPill value={batch.status} />
                    </td>
                    <td className="admin-num">{bhd(batch.grossFils)}</td>
                    <td className="admin-num">{bhd(batch.feeFils)}</td>
                    <td className="admin-num">{bhd(batch.netPayoutFils)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
      <aside className="admin-detail-side" aria-label="Merchant actions">
        <div className="admin-detail-panel">
          <h2>Adjust balance</h2>
          <p className="admin-muted">
            Correct this merchant&apos;s balance when support has confirmed the figure is wrong. Finance
            admins only. You confirm the amount before anything is posted.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role is read-only for balance corrections. Ask a finance admin.
              </p>
            }
          >
            <form className="admin-form" onSubmit={requestAdjustBalance}>
              <label>
                Amount (BHD, use - to debit)
                <span className="admin-money-input">
                  <input
                    value={adjustDeltaBhd}
                    onChange={(e) => setAdjustDeltaBhd(e.target.value)}
                    inputMode="decimal"
                    placeholder="-12.500"
                    aria-describedby="adjust-preview"
                  />
                  <span>BHD</span>
                </span>
                <MoneyPreview id="adjust-preview" text={adjustDeltaBhd} allowNegative />
              </label>
              <label>
                Reason
                <input
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="phone confirmation with merchant"
                />
              </label>
              <div>
                <button
                  type="submit"
                  className="admin-btn-primary"
                  disabled={busy || !adjustDeltaBhd.trim() || !adjustReason.trim()}
                >
                  {busyAction === "adjust" ? "Adjusting…" : "Adjust balance"}
                </button>
              </div>
            </form>
          </RequireRole>
        </div>
        <div className="admin-detail-panel">
          <h2>Issue credit</h2>
          <p className="admin-muted">
            Adds a manual credit to this merchant&apos;s balance. Credits above the approval limit wait
            in <Link to="/credits">Credits</Link> for a second finance admin; smaller ones post
            immediately. The effective date is the accounting date.
          </p>
          <RequireRole
            allow={["support", "finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role cannot issue credits. Ask a finance admin.
              </p>
            }
          >
            <form className="admin-form" onSubmit={requestIssueCredit}>
              <label>
                Amount (BHD)
                <span className="admin-money-input">
                  <input
                    type="text"
                    required
                    inputMode="decimal"
                    placeholder="50.000"
                    value={creditAmountBhd}
                    onChange={(e) => setCreditAmountBhd(e.target.value)}
                    aria-describedby="credit-preview"
                  />
                  <span>BHD</span>
                </span>
                <MoneyPreview id="credit-preview" text={creditAmountBhd} />
              </label>
              <label>
                Reason
                <select
                  value={creditReason}
                  onChange={(e) => setCreditReason(e.target.value as CreditReasonCode)}
                >
                  <option value="goodwill">Goodwill</option>
                  <option value="dispute_resolution">Dispute resolution</option>
                  <option value="correction">Correction</option>
                </select>
              </label>
              <label>
                Effective date
                <input
                  type="date"
                  required
                  value={creditEffectiveDate}
                  onChange={(e) => setCreditEffectiveDate(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={creditReverseFee}
                  onChange={(e) => setCreditReverseFee(e.target.checked)}
                />{" "}
                {creditFeeReversalLabel(creditEffectiveDate)}
              </label>
              <label>
                Memo (optional)
                <textarea value={creditMemo} onChange={(e) => setCreditMemo(e.target.value)} rows={2} />
              </label>
              <button type="submit" disabled={busy}>
                {busyAction === "credit" ? "Submitting…" : "Issue credit"}
              </button>
            </form>
          </RequireRole>
        </div>
        <div className="admin-detail-panel">
          <h2>Recompute transaction statuses</h2>
          <p className="admin-muted">
            Re-derives this merchant&apos;s transaction statuses from their own captured/refunded
            amounts. Rows written before the refunds release can carry a status that predates the
            derivation rule; this backfills them. Rows that already agree are left alone.
          </p>
          <RequireRole
            allow={["finance", "super_admin"]}
            fallback={
              <p className="admin-muted">
                Your role cannot run this backfill. Ask a finance admin.
              </p>
            }
          >
            <button
              type="button"
              className="admin-btn-primary"
              disabled={busy}
              onClick={() => void handleRecomputeStatuses()}
            >
              {busyAction === "recompute" ? "Working…" : "Recompute statuses"}
            </button>
          </RequireRole>

          <h2>View as merchant</h2>
          <div className="admin-readonly-banner">
            Read-only impersonation: you see the dashboard exactly as this merchant&apos;s support role
            does, and a banner stays on screen until you exit.
          </div>
          <p className="admin-muted">
            Starts a short, audited session with this merchant&apos;s read-only support access, never
            your admin access. It ends on its own after a few minutes.
          </p>
          <button
            type="button"
            className="admin-btn-primary"
            disabled={busy}
            onClick={() => void handleImpersonate()}
          >
            {busyAction === "impersonate" ? "Starting…" : "View as merchant"}
          </button>
          {impersonationUrl ? (
            <p>
              Your browser blocked the new tab —{" "}
              <a href={impersonationUrl} target="_blank" rel="noreferrer">
                open the merchant dashboard
              </a>
              .
            </p>
          ) : null}
        </div>
      </aside>
      </div>

      <ConfirmAction
        open={pendingConfirm?.kind === "adjust"}
        title="Adjust this balance?"
        confirmLabel="Adjust balance"
        danger={pendingConfirm?.kind === "adjust" && pendingConfirm.deltaFils < 0}
        busy={busyAction === "adjust"}
        error={confirmError}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm?.kind === "adjust") void handleAdjustBalance(pendingConfirm.deltaFils);
        }}
      >
        {pendingConfirm?.kind === "adjust" ? (
          <dl className="admin-dialog-summary">
            <dt>Merchant</dt>
            <dd>{merchant.displayName}</dd>
            <dt>{pendingConfirm.deltaFils < 0 ? "Debit" : "Credit"}</dt>
            <dd>{bhd(pendingConfirm.deltaFils)}</dd>
            {detail.balance ? (
              <>
                <dt>Balance after</dt>
                <dd>{bhd(detail.balance.cachedPayableFils + pendingConfirm.deltaFils)}</dd>
              </>
            ) : null}
            <dt>Reason</dt>
            <dd>{adjustReason.trim()}</dd>
          </dl>
        ) : null}
      </ConfirmAction>

      <ConfirmAction
        open={pendingConfirm?.kind === "credit"}
        title="Issue this credit?"
        confirmLabel="Issue credit"
        busy={busyAction === "credit"}
        error={confirmError}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (pendingConfirm?.kind === "credit") void handleIssueCredit(pendingConfirm.baseAmountFils);
        }}
      >
        {pendingConfirm?.kind === "credit" ? (
          <dl className="admin-dialog-summary">
            <dt>Merchant</dt>
            <dd>{merchant.displayName}</dd>
            <dt>Amount</dt>
            <dd>{bhd(pendingConfirm.baseAmountFils)}</dd>
            <dt>Reason</dt>
            <dd>{enumLabel(creditReason)}</dd>
            <dt>Effective date</dt>
            <dd>{creditEffectiveDate}</dd>
            <dt>Reverse MDR</dt>
            <dd>{creditReverseFee ? "Yes" : "No"}</dd>
          </dl>
        ) : null}
      </ConfirmAction>

      <ConfirmAction
        open={pendingConfirm?.kind === "kyc-approve"}
        title={`Approve KYC for ${merchant.displayName}?`}
        confirmLabel="Approve KYC"
        busy={busyAction === "kyc"}
        error={confirmError}
        reason={{ label: "Notes (optional, recorded in the audit log)", minLength: 0, initial: kycNotes }}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={(notes) => void handleKycReview("approved", notes)}
      >
        <p>The merchant can take live payments as soon as KYC is approved.</p>
      </ConfirmAction>

      <ConfirmAction
        open={pendingConfirm?.kind === "kyc-reject"}
        title={`Reject KYC for ${merchant.displayName}?`}
        confirmLabel="Reject KYC"
        danger
        busy={busyAction === "kyc"}
        error={confirmError}
        reason={{ label: "Reason for rejection (required, recorded in the audit log)", minLength: 10, initial: kycNotes }}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={(notes) => void handleKycReview("rejected", notes)}
      >
        <p>The merchant sees that their application was rejected.</p>
      </ConfirmAction>
    </section>
  );
}

/** Live "= 12.500 BHD" preview under a BHD input, or the validation error. */
function MoneyPreview({ id, text, allowNegative = false }: { id: string; text: string; allowNegative?: boolean }) {
  if (!text.trim()) return <span id={id} className="admin-money-preview">Up to 3 decimals, for example 12.500</span>;
  const parsed = readBhdInput(text, { allowNegative });
  return parsed.ok ? (
    <span id={id} className="admin-money-preview">
      = {bhd(parsed.fils)}
      {allowNegative ? (parsed.fils < 0 ? " (debit)" : " (credit)") : ""}
    </span>
  ) : (
    <span id={id} className="admin-money-preview is-error">
      {parsed.error}
    </span>
  );
}
