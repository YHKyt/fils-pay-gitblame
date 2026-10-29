-- Cross-process admin actions (settlement run-batch, balance rebuild, MDR
-- recalculation) commit their audit row BEFORE the outbound call and update
-- the outcome afterwards. Until now that first write had to claim
-- 'succeeded', so a crash mid-call or a failed outcome update left a row
-- saying the action succeeded when nothing confirmed it. 'requested' is the
-- truthful state between the two phases.

ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_outcome_check;
ALTER TABLE admin_audit_log
    ADD CONSTRAINT admin_audit_log_outcome_check
    CHECK (outcome IN ('requested', 'succeeded', 'failed'));
