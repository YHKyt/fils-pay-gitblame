-- Deleting a webhook endpoint that had deliveries failed with an FK violation
-- (webhook_deliveries.endpoint_id and webhook_delivery_archives.endpoint_id
-- reference it with no ON DELETE action), surfacing as a 500. The delivery
-- log is a durable audit trail (0022, 0068), so the endpoint row is kept and
-- marked deleted instead: deliveries stay linked to the URL they were sent
-- to. A deleted endpoint is always disabled, so the dispatcher never sends
-- to it, and it is hidden from list/get/update.

ALTER TABLE webhook_endpoints
    ADD COLUMN deleted_at TIMESTAMPTZ;

ALTER TABLE webhook_endpoints
    ADD CONSTRAINT ck_webhook_endpoints_deleted_is_disabled
    CHECK (deleted_at IS NULL OR status = 'disabled');
