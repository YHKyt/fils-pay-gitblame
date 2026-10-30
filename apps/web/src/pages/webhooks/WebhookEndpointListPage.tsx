import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { SkeletonRows } from "../../components/SkeletonRows.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { dateTime, statusLabel } from "../../format.js";
import type { WebhookEndpointDto } from "../../types.js";

/**
 * `GET /v1/merchants/:merchantId/webhook-endpoints`. Unlike most
 * list reads in this platform, this one is `owner`/`finance` only
 * server-side — so a `support` user reaching this page gets a real `403`,
 * which `describeError` renders plainly. The nav link is hidden from them too
 * (DashboardLayout), but a typed URL still lands here, and it must explain
 * itself rather than sit on a blank loading state.
 */
export function WebhookEndpointListPage() {
  const { me } = useDashboardAuth();
  const merchantId = me?.merchant.id;

  const [endpoints, setEndpoints] = useState<WebhookEndpointDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      setEndpoints(await listWebhookEndpoints(merchantId));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId) return;
    setBusyId(endpoint.id);
    setError(null);
    try {
      await updateWebhookEndpoint(merchantId, endpoint.id, {
        status: endpoint.status === "active" ? "disabled" : "active",
      });
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(endpoint: WebhookEndpointDto): Promise<void> {
    if (!merchantId) return;
    // The endpoint disappears for good (the API keeps it, disabled, only so
    // its delivery log stays intact). Irreversible, so it asks first.
    if (
      !window.confirm(
        `Delete ${endpoint.url}? This cannot be undone, and its secret cannot be recovered.`,
      )
    ) {
      return;
    }
    setBusyId(endpoint.id);
    setError(null);
    try {
      await deleteWebhookEndpoint(merchantId, endpoint.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h1>Webhook endpoints</h1>

      <p>
        <Link className="dash-button-link" to="/dashboard/webhooks/new">
          New endpoint
        </Link>
      </p>

      {error ? <p className="dash-error">{error}</p> : null}

      <div className="dash-tablewrap"><table className="dash-table">
        <thead>
          <tr>
            <th>URL</th>
            <th>Secret prefix</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((endpoint) => (
            <tr key={endpoint.id}>
              <td>
                <Link to={`/dashboard/webhooks/${endpoint.id}`}>{endpoint.url}</Link>
              </td>
              <td>
                <code>{endpoint.secretPrefix}</code>
              </td>
              <td>
                <span className={`dash-status dash-status-${endpoint.status}`}>{statusLabel(endpoint.status)}</span>
              </td>
              <td>{dateTime(endpoint.createdAt)}</td>
              <td>
                <button
                  type="button"
                  className="dash-button"
                  disabled={busyId === endpoint.id}
                  onClick={() => void handleToggle(endpoint)}
                >
                  {endpoint.status === "active" ? "Disable" : "Enable"}
                </button>{" "}
                <button
                  type="button"
                  className="dash-button dash-button-danger"
                  disabled={busyId === endpoint.id}
                  onClick={() => void handleDelete(endpoint)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {endpoints.length === 0 && loading ? <SkeletonRows columns={5} /> : null}
          {endpoints.length === 0 && !loading && !error ? (
            <tr>
              <td colSpan={5}>No webhook endpoints registered.</td>
            </tr>
          ) : null}
        </tbody>
      </table></div>

      {loading ? <p className="dash-loading">Loading…</p> : null}
    </section>
  );
}
