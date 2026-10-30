import { useCallback, useEffect, useState } from "react";
import { formatBhd, toFils } from "@filspay/money";
import {
  approveAdjustmentImport,
  getAdjustmentImportRows,
  listAdjustmentImports,
  rejectAdjustmentImport,
  uploadAdjustmentImport,
} from "../../api/adjustmentImports.js";
import { describeError } from "../../api/client.js";
import { dateTime } from "../../format.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusPill } from "../../components/StatusPill.js";
import type {
  AdjustmentImportRowDetail,
  AdjustmentImportStatus,
  AdjustmentImportSummary,
} from "../../types.js";

// FH: another copy of bhd() in admin, claude says extract it
function bhd(fils: number): string {
  return `${formatBhd(toFils(fils, { allowNegative: true }))} BHD`;
}

const CSV_PLACEHOLDER = `merchantId,amount,reason
00000000-0000-0000-0000-000000000000,4.750,statement correction`;

const STATUS_LABEL: Record<AdjustmentImportStatus, string> = {
  pending_approval: "Awaiting second approver",
  posted: "Posted",
  rejected: "Rejected",
};

/**
 * "Import adjustments" — paste a CSV of manual balance corrections. A batch
 * at or below the credit approval limit (gross) posts on submit; above it,
 * it waits here until a different finance admin approves it. The server
 * refuses a batch that is already posted or pending (409), so submitting the
 * same file twice never posts it twice.
 *
 * The history table below drills into per-row detail, which shows the raw
 * CSV text next to the integer that was actually posted.
 */
export function AdjustmentImportPage() {
  const { admin } = useAdminAuth();
  const [csvContent, setCsvContent] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [imports, setImports] = useState<AdjustmentImportSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  const [openImportId, setOpenImportId] = useState<string | null>(null);
  const [rows, setRows] = useState<AdjustmentImportRowDetail[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setListError(null);
    try {
      const page = await listAdjustmentImports({ limit: 25 });
      setImports(page.items);
    } catch (err) {
      setListError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  /** Amounts are BD with three decimals and are parsed server-side with parseBhdToFils. */
  async function handleApply(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await uploadAdjustmentImport(
        csvContent,
        filename.trim() ? filename.trim() : undefined,
      );
      setNotice(
        result.status === "posted"
          ? `Applied ${result.rowCount} row(s), posting ${bhd(result.totalPostedFils)} in total.`
          : `Held ${result.rowCount} row(s) (${bhd(result.totalPostedFils)}) for a second approver. Nothing is posted until another finance admin approves it below.`,
      );
      setCsvContent("");
      setFilename("");
      await loadHistory();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDecision(importId: string, decision: "approve" | "reject"): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result =
        decision === "approve"
          ? await approveAdjustmentImport(importId)
          : await rejectAdjustmentImport(importId);
      setNotice(
        result.status === "posted"
          ? `Approved: posted ${result.rowCount} row(s), ${bhd(result.totalPostedFils)} in total.`
          : "Rejected: nothing was posted.",
      );
      await loadHistory();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenRows(importId: string): Promise<void> {
    if (openImportId === importId) {
      setOpenImportId(null);
      setRows([]);
      return;
    }
    setRowsError(null);
    try {
      setRows(await getAdjustmentImportRows(importId));
      setOpenImportId(importId);
    } catch (err) {
      setRowsError(describeError(err));
    }
  }

  return (
    <section>
      <h1>Import adjustments</h1>
      <p className="admin-muted">
        Applies a CSV of manual balance corrections — one balanced ledger posting per row. A batch
        whose total (ignoring sign) is over the credit approval limit waits for a second finance
        admin; smaller batches post immediately. The same batch cannot be imported twice. Uploading
        and approving are gated server-side to the <code>finance</code> and{" "}
        <code>super_admin</code> roles.
      </p>

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role is read-only here. The import history below is still available.
          </p>
        }
      >
        <form className="admin-form" onSubmit={(e) => void handleApply(e)}>
          <label>
            File name (optional)
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="march-corrections.csv"
            />
          </label>
          <label>
            CSV (columns: merchantId, amount, reason)
            <textarea
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              rows={8}
              placeholder={CSV_PLACEHOLDER}
              required
            />
          </label>
          <button type="submit" disabled={busy || !csvContent.trim()}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </form>
      </RequireRole>

      {error ? <p className="admin-error">{error}</p> : null}
      {notice ? <p>{notice}</p> : null}

      <h2>Past imports</h2>
      {listError ? <p className="admin-error">{listError}</p> : null}
      {imports.length === 0 ? (
        <div className="admin-empty">No imports yet.</div>
      ) : (
        <div className="admin-table-wrap"><table className="admin-table">
          <thead>
            <tr>
              <th>Uploaded</th>
              <th>Status</th>
              <th>File</th>
              <th>Rows</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {imports.map((item) => (
              <tr key={item.id}>
                <td>{dateTime(item.createdAt)}</td>
                <td>
                  <StatusPill value={item.status} label={STATUS_LABEL[item.status]} />
                  {item.appliedAt ? <div className="admin-muted">Posted {dateTime(item.appliedAt)}</div> : null}
                </td>
                <td>{item.originalFilename}</td>
                <td>{item.rowCount}</td>
                <td>
                  <button type="button" onClick={() => void handleOpenRows(item.id)}>
                    {openImportId === item.id ? "Hide rows" : "View rows"}
                  </button>
                  {item.status === "pending_approval" ? (
                    <RequireRole allow={["finance", "super_admin"]}>
                      {" "}
                      {admin?.adminUserId === item.uploadedByAdminUserId ? (
                        <span className="admin-muted">another admin must approve</span>
                      ) : (
                        <button
                          type="button"
                          className="admin-btn-primary"
                          disabled={busy}
                          onClick={() => void handleDecision(item.id, "approve")}
                        >
                          Approve
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        className="admin-btn-danger"
                        disabled={busy}
                        onClick={() => void handleDecision(item.id, "reject")}
                      >
                        Reject
                      </button>
                    </RequireRole>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {rowsError ? <p className="admin-error">{rowsError}</p> : null}

      {openImportId ? (
        <div>
          <h3>Rows</h3>
          <div className="admin-table-wrap"><table className="admin-table">
            <thead>
              <tr>
                <th className="admin-num">#</th>
                <th>Merchant</th>
                <th className="admin-num">CSV amount</th>
                <th className="admin-num">Posted</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rowNumber}>
                  <td className="admin-num">{row.rowNumber}</td>
                  <td>{row.merchantId}</td>
                  <td className="admin-num">
                    <code>{row.rawAmountText}</code>
                  </td>
                  <td className="admin-num">{bhd(row.parsedAmountFils)}</td>
                  <td>{row.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      ) : null}
    </section>
  );
}
