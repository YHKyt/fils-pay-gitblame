import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listMerchants } from "../../api/merchants.js";
import { bulkApproveKyc } from "../../api/merchantsBulk.js";
import { describeError } from "../../api/client.js";
import { date } from "../../format.js";
import { RequireRole } from "../../auth/RequireRole.js";
import type { AdminMerchantSummary, MerchantOnboardingStatus } from "../../types.js";

const ONBOARDING_STATUSES: MerchantOnboardingStatus[] = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
];

const PAGE_SIZE = 25;

/** Bulk approve only ever affects merchants in this state (docs/ADMIN.md). */
function isBulkApprovable(merchant: AdminMerchantSummary): boolean {
  return merchant.onboardingStatus === "under_review";
}

/** The platform's one legitimately cross-merchant view. Searchable by
 *  display name / id / contact email, filterable by onboarding status, and
 *  keyset-paginated like every other list endpoint here. */
export function MerchantListPage() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [statuses, setStatuses] = useState<MerchantOnboardingStatus[]>([]);
  const [merchants, setMerchants] = useState<AdminMerchantSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      // Any change of filter, search or page invalidates the selection, so a
      // tick made under a previous view can never ride along into a bulk call.
      setSelectedIds(new Set());
      setLoading(true);
      setError(null);
      try {
        const result = await listMerchants({
          q: appliedQuery || undefined,
          onboardingStatus: statuses.length > 0 ? statuses : undefined,
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        });
        const page = result.merchants ?? [];
        setMerchants((previous) => (cursor ? [...previous, ...page] : page));
        setNextCursor(result.nextCursor ?? null);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [appliedQuery, statuses],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function toggleStatus(status: MerchantOnboardingStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  function toggleSelected(id: string): void {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Rows the operator can see right now that bulk approve could act on. */
  const approvableIds = merchants.filter(isBulkApprovable).map((m) => m.id);
  /** What a bulk approve actually sends: visible, under_review AND ticked. */
  const effectiveSelection = approvableIds.filter((id) => selectedIds.has(id));

  /** Header checkbox: select or clear every under_review row currently
   *  loaded into the table under the active search/status filters. */
  function toggleSelectAllLoaded(): void {
    setSelectedIds(
      effectiveSelection.length === approvableIds.length ? new Set() : new Set(approvableIds),
    );
  }

  async function approveSelected(): Promise<void> {
    if (effectiveSelection.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setBulkNotice(null);
    try {
      const result = await bulkApproveKyc(effectiveSelection);
      const skippedCount = result.skippedMerchantIds.length;
      setBulkNotice(
        `Approved KYC for ${result.approvedCount} merchant(s).` +
          (skippedCount > 0 ? ` ${skippedCount} skipped (no longer under review).` : ""),
      );
      setSelectedIds(new Set());
      await load(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBulkBusy(false);
    }
  }

  const allLoadedSelected =
    approvableIds.length > 0 && effectiveSelection.length === approvableIds.length;

  return (
    <section>
      <h1>Merchants</h1>

      <form
        className="admin-form admin-form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          setAppliedQuery(query.trim());
        }}
      >
        <label>
          Search
          <input
            type="search"
            placeholder="Display name, merchant id, or contact email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="submit">Search</button>
      </form>

      <fieldset className="admin-filters">
        <legend>Onboarding status</legend>
        {ONBOARDING_STATUSES.map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {status}
          </label>
        ))}
      </fieldset>

      {error ? <p className="admin-error">{error}</p> : null}
      {bulkNotice ? <p className="admin-muted">{bulkNotice}</p> : null}

      {effectiveSelection.length > 0 ? (
        <div className="admin-form admin-form-inline">
          <span>{effectiveSelection.length} selected</span>
          <RequireRole allow={["finance", "super_admin"]}>
            <button type="button" disabled={bulkBusy} onClick={() => void approveSelected()}>
              Bulk approve KYC
            </button>
          </RequireRole>
          <button type="button" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </button>
        </div>
      ) : null}

      <table className="admin-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all loaded merchants under review"
                checked={allLoadedSelected}
                disabled={approvableIds.length === 0}
                onChange={toggleSelectAllLoaded}
              />
            </th>
            <th>Merchant</th>
            <th>Status</th>
            <th>Onboarding</th>
            <th>KYC</th>
            <th>MDR</th>
            <th>Mode</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {merchants.map((merchant) => (
            <tr key={merchant.id}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${merchant.displayName}`}
                  checked={isBulkApprovable(merchant) && selectedIds.has(merchant.id)}
                  disabled={!isBulkApprovable(merchant)}
                  onChange={() => toggleSelected(merchant.id)}
                />
              </td>
              <td>
                <Link to={`/merchants/${merchant.id}`}>{merchant.displayName}</Link>
                <div className="admin-muted">
                  <code>{merchant.id}</code>
                </div>
              </td>
              <td>{merchant.status}</td>
              <td>{merchant.onboardingStatus}</td>
              <td>{merchant.kycPassed ? "passed" : "not passed"}</td>
              <td>{(merchant.mdrBps / 100).toFixed(2)}%</td>
              <td>{merchant.testMode ? "test" : "live"}</td>
              <td>{date(merchant.createdAt)}</td>
            </tr>
          ))}
          {merchants.length === 0 && !loading ? (
            <tr>
              <td colSpan={8}>No merchants match this search.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {loading ? <p>Loading...</p> : null}

      {nextCursor ? (
        <button type="button" disabled={loading} onClick={() => void load(nextCursor)}>
          Load more
        </button>
      ) : null}
    </section>
  );
}
