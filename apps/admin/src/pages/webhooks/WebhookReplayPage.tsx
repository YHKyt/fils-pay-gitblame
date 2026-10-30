import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getMerchant, listMerchants } from "../../api/merchants.js";
import { replayBatch } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { bahrainInputToIso, dateTime, enumLabel, toBahrainInputValue } from "../../format.js";
import { ConfirmAction } from "../../components/ConfirmAction.js";
import { StatusPill } from "../../components/StatusPill.js";
import type {
  AdminMerchantDetail,
  AdminMerchantSummary,
  BatchReplayResult,
  WebhookDeliveryStatus,
} from "../../types.js";

const REPLAYABLE_STATUSES: WebhookDeliveryStatus[] = [
  "exhausted",
  "failed",
  "pending",
  "succeeded",
];

/** `<input type="datetime-local">` holds a zone-less `YYYY-MM-DDTHH:mm`;
 *  the API wants ISO-8601 instants. The inputs are Asia/Bahrain wall time
 *  (the console's business timezone), converted at both edges. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: toBahrainInputValue(weekAgo), to: toBahrainInputValue(now) };
}

/**
 * Replay every delivery for one endpoint inside a date range. Any admin role
 * can replay `failed`/`exhausted` deliveries; replaying `pending` or
 * `succeeded` ones needs finance or super_admin.
 */
export function WebhookReplayPage() {
  const { merchantId } = useParams<{ merchantId?: string }>();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [candidates, setCandidates] = useState<AdminMerchantSummary[]>([]);
  const [detail, setDetail] = useState<AdminMerchantDetail | null>(null);

  const [endpointId, setEndpointId] = useState("");
  const [range, setRange] = useState(defaultRange);
  const [statuses, setStatuses] = useState<WebhookDeliveryStatus[]>(["exhausted"]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchReplayResult | null>(null);
  const [confirming, setConfirming] = useState<{ from: string; to: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const loadMerchant = useCallback(async () => {
    if (!merchantId) {
      setDetail(null);
      return;
    }
    setError(null);
    try {
      const loaded = await getMerchant(merchantId);
      setDetail(loaded);
      const firstActive = (loaded.webhookEndpoints ?? []).find((e) => e.status === "active");
      setEndpointId(firstActive?.id ?? "");
    } catch (err) {
      setError(describeError(err));
    }
  }, [merchantId]);

  useEffect(() => {
    void loadMerchant();
  }, [loadMerchant]);

  async function handleSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSearching(true);
    try {
      const found = await listMerchants({ q: search.trim() || undefined, limit: 10 });
      setCandidates(found.merchants ?? []);
      setSearched(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSearching(false);
    }
  }

  function toggleStatus(status: WebhookDeliveryStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  /** Replays keep the original Webhook-Delivery-Id so receivers can dedupe. */
  function requestReplay(event: React.FormEvent): void {
    event.preventDefault();
    if (!merchantId || !endpointId) return;
    if (statuses.length === 0) {
      setError("Pick at least one status.");
      return;
    }
    const from = bahrainInputToIso(range.from);
    const to = bahrainInputToIso(range.to);
    if (!from || !to) {
      setError("From and To must be valid dates and times.");
      return;
    }
    setError(null);
    setConfirming({ from, to });
  }

  async function handleReplay(from: string, to: string): Promise<void> {
    if (!merchantId || !endpointId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await replayBatch(merchantId, endpointId, {
          from,
          to,
          statuses,
        }),
      );
      setConfirming(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!merchantId) {
    return (
      <section>
        <h1>Webhook replay</h1>
        <p className="admin-muted">Pick the merchant whose endpoint needs a replay.</p>
        {error ? <p className="admin-error">{error}</p> : null}
        <form className="admin-form admin-form-inline" onSubmit={(e) => void handleSearch(e)}>
          <label>
            Search merchants
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Display name, merchant id, or contact email"
            />
          </label>
          <button type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
        {searched && candidates.length === 0 ? (
          <div className="admin-empty">
            {search.trim() ? `No merchants match "${search.trim()}".` : "No merchants found."}
          </div>
        ) : null}
        {candidates.length > 0 ? (
          <div className="admin-table-wrap"><table className="admin-table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((merchant) => (
                <tr key={merchant.id}>
                  <td>
                    {merchant.displayName}
                    <div className="admin-muted">
                      <code title={merchant.id}>{merchant.id.slice(0, 8)}</code>
                    </div>
                  </td>
                  <td>
                    <StatusPill value={merchant.status} />
                  </td>
                  <td>
                    <button type="button" onClick={() => navigate(`/webhooks/${merchant.id}`)}>
                      Choose
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ) : null}
      </section>
    );
  }

  const endpoints = detail?.webhookEndpoints ?? [];

  return (
    <section>
      <p>
        <Link to="/webhooks">&larr; Pick a different merchant</Link>
      </p>
      <h1>Webhook replay</h1>
      <p>
        Merchant:{" "}
        {detail ? (
          <Link to={`/merchants/${merchantId}`}>{detail.merchant.displayName}</Link>
        ) : (
          <code>{merchantId}</code>
        )}
      </p>

      {error ? <p className="admin-error">{error}</p> : null}

      {detail && endpoints.length === 0 ? (
        <div className="admin-empty">
          <p>This merchant has no webhook endpoints, so there is nothing to replay.</p>
          <Link to={`/merchants/${merchantId}`}>Back to {detail.merchant.displayName}</Link>
        </div>
      ) : (
      <form className="admin-form" onSubmit={requestReplay}>
        <label>
          Endpoint
          <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} required>
            <option value="" disabled>
              Select an endpoint
            </option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.url} ({enumLabel(endpoint.status)})
              </option>
            ))}
          </select>
        </label>
        <label>
          From (Bahrain time)
          <input
            type="datetime-local"
            required
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </label>
        <label>
          To (Bahrain time)
          <input
            type="datetime-local"
            required
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </label>
        <fieldset className="admin-filters">
          <legend>Delivery statuses to replay</legend>
          {REPLAYABLE_STATUSES.map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={statuses.includes(status)}
                onChange={() => toggleStatus(status)}
              />
              {enumLabel(status)}
            </label>
          ))}
          <p className="admin-muted">
            Defaults to Gave up (deliveries that ran out of retries). Replaying Succeeded
            deliveries resends events the receiver already accepted.
          </p>
          {statuses.length === 0 ? <p className="admin-error">Pick at least one status.</p> : null}
        </fieldset>
        <button type="submit" disabled={busy || !endpointId || statuses.length === 0}>
          {busy ? "Replaying…" : "Replay batch"}
        </button>
      </form>
      )}

      {result ? (
        <div className="admin-notice">
          <p>
            Matched {result.matchedCount} deliver{result.matchedCount === 1 ? "y" : "ies"}; queued{" "}
            {(result.replayedDeliveryIds ?? []).length} replay
            {(result.replayedDeliveryIds ?? []).length === 1 ? "" : "s"}. They go out with the next
            delivery run, within a minute or so.
          </p>
          {result.hasMore ? (
            <p>More deliveries match than one replay sends (500). Replay the batch again for the next ones.</p>
          ) : null}
          {(result.replayedDeliveryIds ?? []).length > 0 ? (
            <ul className="admin-id-list">
              {(result.replayedDeliveryIds ?? []).map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <ConfirmAction
        open={confirming !== null}
        title="Replay these webhook deliveries?"
        confirmLabel="Replay deliveries"
        danger={statuses.includes("succeeded")}
        busy={busy}
        error={error}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void handleReplay(confirming.from, confirming.to);
        }}
      >
        {confirming ? (
          <>
            <dl className="admin-dialog-summary">
              <dt>Merchant</dt>
              <dd>{detail?.merchant.displayName ?? merchantId}</dd>
              <dt>Endpoint</dt>
              <dd>{endpoints.find((e) => e.id === endpointId)?.url ?? endpointId}</dd>
              <dt>Statuses</dt>
              <dd>{statuses.map((s) => enumLabel(s)).join(", ")}</dd>
              <dt>From</dt>
              <dd>{dateTime(confirming.from)}</dd>
              <dt>To</dt>
              <dd>{dateTime(confirming.to)}</dd>
            </dl>
            {statuses.includes("succeeded") ? (
              <p className="admin-dialog-warning">
                Succeeded is ticked: the receiver gets events it already accepted.
              </p>
            ) : null}
          </>
        ) : null}
      </ConfirmAction>
    </section>
  );
}
