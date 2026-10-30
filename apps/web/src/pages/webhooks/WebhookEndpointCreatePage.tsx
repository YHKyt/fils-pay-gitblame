import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createWebhookEndpoint } from "../../api/webhooks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { dateTime } from "../../format.js";
import type { WebhookEndpointCreateResponse } from "../../types.js";

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints`.
 *
 * The `201` response is the only time the signing secret is ever returned —
 * it is stored encrypted at rest (not hashed, because each delivery's HMAC
 * needs the plaintext back) and no read endpoint returns it again. So this
 * page never navigates away on its own: the merchant has to acknowledge the
 * secret panel, which is what stops an accidental redirect or back-button
 * from losing a credential that cannot be re-issued.
 */
export function WebhookEndpointCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WebhookEndpointCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  /** The response carries the secret; this is the only time it is shown. */
  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setSubmitting(true);
    setError(null);
    try {
      setCreated(await createWebhookEndpoint(me.merchant.id, { url: url.trim() }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // MK: secret is shown once only
  async function handleCopy(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // The secret is on screen and selectable — nothing to recover from.
      setCopied(false);
    }
  }

  if (created) {
    return (
      <section>
        <h1>Endpoint created</h1>

        <div className="dash-confirm">
          <h2>Signing secret — shown once</h2>
          <p>
            <strong>This will not be shown again.</strong> Store it now; every delivery
            to this endpoint is signed with it, and it cannot be re-read or recovered.
          </p>
          <p>
            <code className="dash-secret">{created.secret}</code>{" "}
            <button
              type="button"
              className="dash-button"
              onClick={() => void handleCopy(created.secret)}
            >
              {copied ? "Copied" : "Copy secret"}
            </button>
          </p>
        </div>

        <dl className="dash-dl">
          <dt>URL</dt>
          <dd>{created.url}</dd>
          <dt>Secret prefix</dt>
          <dd>
            <code>{created.secretPrefix}</code>
          </dd>
          <dt>Status</dt>
          <dd>{created.status}</dd>
          <dt>Created at</dt>
          <dd>{dateTime(created.createdAt)}</dd>
        </dl>

        <button
          type="button"
          className="dash-button"
          onClick={() => navigate(`/dashboard/webhooks/${created.id}`, { replace: true })}
        >
          I&apos;ve saved it — continue
        </button>
      </section>
    );
  }

  return (
    <section>
      <h1>New webhook endpoint</h1>

      {error ? <p className="dash-error">{error}</p> : null}

      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Endpoint URL
          <input
            type="url"
            required
            placeholder="https://example.com/filspay/webhooks"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button dash-button-primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create endpoint"}
        </button>
      </form>

      <p>
        <Link to="/dashboard/webhooks">Back to webhook endpoints</Link>
      </p>
    </section>
  );
}
