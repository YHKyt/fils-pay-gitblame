-- ledger_entries is append-only: a posted leg is never edited or removed,
-- and a correction is a new, reversing entry group.
--
-- 0007's closing comment says its balance trigger already guarantees that,
-- but it only checks that every touched group still nets to zero at
-- commit. Multiplying every leg of a group by 10, or deleting a whole
-- group, leaves the group balanced, so both committed and silently
-- rewrote the books (and any later rebuild of merchant_balances).
--
-- BEFORE ... FOR EACH ROW, so it fires for every role, the table owner
-- included, and cannot be deferred past the statement. TRUNCATE is
-- deliberately not covered: it fires no row triggers, needs table-owner
-- rights, and is how db/seed/generate.ts resets its fixture tables before
-- re-seeding. Nothing in apps/, scripts/ or db/ UPDATEs or DELETEs
-- ledger_entries, so no existing writer is affected.
CREATE FUNCTION reject_ledger_entries_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only: % of leg % (entry group %) rejected; post a reversing entry group instead',
        TG_OP, OLD.id, OLD.entry_group_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_entries_mutation();
