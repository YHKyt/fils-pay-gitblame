import { useCallback, useEffect, useState } from "react";
import {
  approveAdjustmentImport,
  getAdjustmentImportRows,
  listAdjustmentImports,
  rejectAdjustmentImport,
  uploadAdjustmentImport,
} from "../../api/adjustmentImports.js";
import { describeError } from "../../api/client.js";
import { bhd, dateTime, readBhdInput } from "../../format.js";
import { ConfirmAction } from "../../components/ConfirmAction.js";
import { useAdminAuth } from "../../auth/AdminAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { StatusPill } from "../../components/StatusPill.js";
import { merchantLabel, useMerchantOptions } from "../../components/MerchantPicker.js";
import type {
  AdjustmentImportRowDetail,
  AdjustmentImportStatus,
  AdjustmentImportSummary,
} from "../../types.js";

/** Client-side preview of a pasted CSV: row count, BHD total and the rows
 *  whose amount cannot be read. The server re-parses and is authoritative. */
function previewCsv(content: string): { rows: number; totalFils: number; badRows: number[] } {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let totalFils = 0;
  const badRows: number[] = [];
  lines.slice(1).forEach((line, index) => {
    const amount = line.split(",")[1] ?? "";
    const parsed = readBhdInput(amount, { allowNegative: true });
    if (parsed.ok) totalFils += parsed.fils;
    else badRows.push(index + 1);
  });
  return { rows: Math.max(lines.length - 1, 0), totalFils, badRows };
}

interface PreviewRow {
  rowNumber: number;
  merchantId: string;
  amountFils: number | null;
  rawAmount: string;
  reason: string;
  error: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-row client-side preview for the table shown before import. Display
 *  only; the server re-parses the same text and is authoritative. */
function previewCsvRows(content: string): PreviewRow[] {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(1).map((line, index) => {
    const [merchantId = "", rawAmount = "", ...rest] = line.split(",");
    const parsed = readBhdInput(rawAmount, { allowNegative: true });
    const id = merchantId.trim();
    let error: string | null = null;
    if (!UUID_RE.test(id)) error = "Merchant ID is not a valid ID";
    else if (!parsed.ok) error = "Amount cannot be read";
    return {
      rowNumber: index + 1,
      merchantId: id,
      amountFils: parsed.ok ? parsed.fils : null,
      rawAmount: rawAmount.trim(),
      reason: rest.join(",").trim(),
      error,
    };
  });
}

const CSV_PLACEHOLDER = `merchantId,amount,reason
00000000-0000-0000-0000-000000000000,4.750,statement correction`;

const STATUS_LABEL: Record<AdjustmentImportStatus, string> = {
  pending_approval: "Waiting for approval",
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
  const merchantOptions = useMerchantOptions();
  const nameOf = (id: string) => merchantLabel(merchantOptions.options, id);
  const [csvContent, setCsvContent] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingUpload, setConfirmingUpload] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<
    { item: AdjustmentImportSummary; decision: "approve" | "reject" } | null
  >(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
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
  async function handleApply(): Promise<void> {
    setBusy(true);
    setError(null);
    setConfirmError(null);
    setNotice(null);
    try {
      const result = await uploadAdjustmentImport(
        csvContent,
        filename.trim() ? filename.trim() : undefined,
      );
      setNotice(
        result.status === "posted"
          ? `Posted ${result.rowCount} ${result.rowCount === 1 ? "row" : "rows"}, ${bhd(result.totalPostedFils)} in total.`
          : `${result.rowCount} ${result.rowCount === 1 ? "row" : "rows"} (${bhd(result.totalPostedFils)}) are waiting for a second finance admin. Nothing is posted until they approve it below.`,
      );
      setCsvContent("");
      setFilename("");
      setConfirmingUpload(false);
      await loadHistory();
    } catch (err) {
      setConfirmError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDecision(importId: string, decision: "approve" | "reject"): Promise<void> {
    setBusyId(importId);
    setError(null);
    setConfirmError(null);
    setNotice(null);
    try {
      const result =
        decision === "approve"
          ? await approveAdjustmentImport(importId)
          : await rejectAdjustmentImport(importId);
      setNotice(
        result.status === "posted"
          ? `Approved: posted ${result.rowCount} ${result.rowCount === 1 ? "row" : "rows"}, ${bhd(result.totalPostedFils)} in total.`
          : "Rejected: nothing was posted.",
      );
      setPendingDecision(null);
      await loadHistory();
    } catch (err) {
      setConfirmError(describeError(err));
    } finally {
      setBusyId(null);
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
        Upload a CSV of balance corrections. Totals above the approval limit wait for a second
        finance admin. The same file can&apos;t be imported twice.
      </p>

      <RequireRole
        allow={["finance", "super_admin"]}
        fallback={
          <p className="admin-muted">
            Your role is read-only here. The import history below is still available.
          </p>
        }
      >
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            setConfirmError(null);
            setConfirmingUpload(true);
          }}
        >
          <label>
            CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFilename(file.name);
                void file.text().then(setCsvContent);
              }}
            />
          </label>
          <label>
            Or paste CSV (columns: merchantId, amount in BHD, reason)
            <textarea
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              rows={8}
              placeholder={CSV_PLACEHOLDER}
              required
            />
          </label>
          {csvContent.trim() ? <ImportPreviewTable rows={previewCsvRows(csvContent)} nameOf={nameOf} /> : null}
          {csvContent.trim() ? (
            <p className="admin-money-preview">
              {(() => {
                const p = previewCsv(csvContent);
                return `${p.rows} ${p.rows === 1 ? "row" : "rows"}, total ${bhd(p.totalFils)}` +
                  (p.badRows.length > 0 ? `. Check the amount on row ${p.badRows.join(", ")}.` : "");
              })()}
            </p>
          ) : null}
          <button type="submit" disabled={busy || !csvContent.trim()}>
            {busy ? "Importing…" : "Review and import"}
          </button>
        </form>
      </RequireRole>

      {error ? <p className="admin-error">{error}</p> : null}
      {notice ? <p className="admin-notice">{notice}</p> : null}

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
                        <span className="admin-muted">Another admin must approve</span>
                      ) : (
                        <button
                          type="button"
                          className="admin-btn-primary"
                          disabled={busyId === item.id}
                          onClick={() => {
                            setConfirmError(null);
                            setPendingDecision({ item, decision: "approve" });
                          }}
                        >
                          Approve
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        className="admin-btn-danger"
                        disabled={busyId === item.id}
                        onClick={() => {
                          setConfirmError(null);
                          setPendingDecision({ item, decision: "reject" });
                        }}
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
                  <td title={row.merchantId}>{nameOf(row.merchantId)}</td>
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
      <ConfirmAction
        open={confirmingUpload}
        title="Import these adjustments?"
        confirmLabel="Import"
        busy={busy}
        error={confirmError}
        onCancel={() => setConfirmingUpload(false)}
        onConfirm={() => void handleApply()}
      >
        {confirmingUpload ? (
          (() => {
            const p = previewCsv(csvContent);
            return (
              <dl className="admin-dialog-summary">
                <dt>File</dt>
                <dd>{filename || "Pasted CSV"}</dd>
                <dt>Rows</dt>
                <dd>{p.rows}</dd>
                <dt>Net total</dt>
                <dd>{bhd(p.totalFils)}</dd>
                {p.badRows.length > 0 ? (
                  <>
                    <dt>Check rows</dt>
                    <dd>{p.badRows.join(", ")}</dd>
                  </>
                ) : null}
              </dl>
            );
          })()
        ) : null}
        <p>Small totals post immediately; larger ones wait for a second finance admin.</p>
      </ConfirmAction>

      <ConfirmAction
        open={pendingDecision !== null}
        title={pendingDecision?.decision === "reject" ? "Reject this import?" : "Approve and post this import?"}
        confirmLabel={pendingDecision?.decision === "reject" ? "Reject import" : "Approve and post"}
        danger={pendingDecision?.decision === "reject"}
        busy={pendingDecision !== null && busyId === pendingDecision.item.id}
        error={confirmError}
        onCancel={() => setPendingDecision(null)}
        onConfirm={() => {
          if (pendingDecision) void handleDecision(pendingDecision.item.id, pendingDecision.decision);
        }}
      >
        {pendingDecision ? (
          <dl className="admin-dialog-summary">
            <dt>File</dt>
            <dd>{pendingDecision.item.originalFilename}</dd>
            <dt>Rows</dt>
            <dd>{pendingDecision.item.rowCount}</dd>
            <dt>Uploaded</dt>
            <dd>{dateTime(pendingDecision.item.createdAt)}</dd>
          </dl>
        ) : null}
        {pendingDecision?.decision === "reject" ? <p>Nothing is posted.</p> : null}
      </ConfirmAction>
    </section>
  );
}

function ImportPreviewTable({ rows, nameOf }: { rows: PreviewRow[]; nameOf: (id: string) => string }) {
  if (rows.length === 0) return null;
  const totalFils = rows.reduce((sum, row) => sum + (row.amountFils ?? 0), 0);
  const errors = rows.filter((row) => row.error).length;
  return (
    <div className="admin-import-preview">
      <p className="admin-stat-label">Preview before import</p>
      <div className="admin-table-wrap"><table className="admin-table">
        <thead>
          <tr>
            <th className="admin-num">Row</th>
            <th>Merchant</th>
            <th className="admin-num">Amount (BHD)</th>
            <th>Reason</th>
            <th>Check</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rowNumber} className={row.error ? "is-error" : undefined}>
              <td className="admin-num">{row.rowNumber}</td>
              <td title={row.merchantId}>{row.merchantId ? nameOf(row.merchantId) : "—"}</td>
              <td className="admin-num">{row.amountFils === null ? <code>{row.rawAmount || "—"}</code> : bhd(row.amountFils)}</td>
              <td>{row.reason || <span className="admin-muted">—</span>}</td>
              <td>{row.error ? <span className="admin-error-text">{row.error}</span> : "OK"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2}>
              {rows.length} {rows.length === 1 ? "row" : "rows"}
              {errors > 0 ? `, ${errors} to fix` : ""}
            </th>
            <th className="admin-num">{bhd(totalFils)}</th>
            <th colSpan={2} />
          </tr>
        </tfoot>
      </table></div>
    </div>
  );
}
