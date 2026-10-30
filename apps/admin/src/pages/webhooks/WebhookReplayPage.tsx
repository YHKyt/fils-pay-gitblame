import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getMerchant, listMerchants } from "../../api/merchants.js";
import { replayBatch } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { bahrainInputToIso, toBahrainInputValue } from "../../format.js";
import { RequireRole } from "../../auth/RequireRole.js";
import type {
  AdminMerchantDetail,
  AdminMerchantSummary,
  BatchReplayResult,
  WebhookDeliveryStatus,
} from "../../types.js";

/** Any admin role may replay these. */
const SUPPORT_REPLAYABLE_STATUSES: WebhookDeliveryStatus[] = ["exhausted", "failed"];
/** Re-delivers an event the receiver may already have acted on: finance or
 *  super_admin only (the API answers 403 to anyone else). */
const FINANCE_REPLAYABLE_STATUSES: WebhookDeliveryStatus[] = ["pending", "succeeded"];

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
    try {
      const found = await listMerchants({ q: search.trim() || undefined, limit: 10 });
      setCandidates(found.merchants ?? []);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function toggleStatus(status: WebhookDeliveryStatus): void {
    setStatuses((previous) =>
      previous.includes(status) ? previous.filter((s) => s !== status) : [...previous, status],
    );
  }

  /** Replays keep the original Webhook-Delivery-Id so receivers can dedupe. */
  async function handleReplay(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || !endpointId) return;
    const from = bahrainInputToIso(range.from);
    const to = bahrainInputToIso(range.to);
    if (!from || !to) {
      setError("From and To must be valid dates and times.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await replayBatch(merchantId, endpointId, {
          from,
          to,
          statuses: statuses.length > 0 ? statuses : undefined,
        }),
      );
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
          <button type="submit">Search</button>
        </form>
        <ul>
          {candidates.map((merchant) => (
            <li key={merchant.id}>
              <button type="button" onClick={() => navigate(`/webhooks/${merchant.id}`)}>
                {merchant.displayName}
              </button>{" "}
              <code className="admin-muted">{merchant.id}</code>
            </li>
          ))}
        </ul>
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
        <p className="admin-muted">This merchant has no webhook endpoints registered.</p>
      ) : null}

      <form className="admin-form" onSubmit={(e) => void handleReplay(e)}>
        <label>
          Endpoint
          <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} required>
            <option value="" disabled>
              Select an endpoint
            </option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.url} ({endpoint.status})
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
          {SUPPORT_REPLAYABLE_STATUSES.map((status) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={statuses.includes(status)}
                onChange={() => toggleStatus(status)}
              />
              {status}
            </label>
          ))}
          <RequireRole allow={["finance", "super_admin"]}>
            {FINANCE_REPLAYABLE_STATUSES.map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={statuses.includes(status)}
                  onChange={() => toggleStatus(status)}
                />
                {status}
              </label>
            ))}
          </RequireRole>
          <p className="admin-muted">
            Defaults to <code>exhausted</code> — the one terminal failure state the dispatcher
            produces. Any role can replay <code>failed</code> and <code>exhausted</code> deliveries;
            replaying <code>pending</code> or <code>succeeded</code> ones needs finance or super_admin,
            because it resends events the receiver may already have accepted.
          </p>
        </fieldset>
        <button type="submit" disabled={busy || !endpointId}>
          {busy ? "Replaying..." : "Replay batch"}
        </button>
      </form>

      {result ? (
        <div className="admin-notice">
          <p>
            Matched {result.matchedCount} deliver{result.matchedCount === 1 ? "y" : "ies"}; queued{" "}
            {(result.replayedDeliveryIds ?? []).length} replay
            {(result.replayedDeliveryIds ?? []).length === 1 ? "" : "s"}. They are sent by the normal
            async dispatcher pass, not immediately by this request.
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
    </section>
  );
}
