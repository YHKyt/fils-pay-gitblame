package ledger

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// postGroup inserts one balanced two-leg entry group and returns its id.
func postGroup(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, amountFils int64) uuid.UUID {
	t.Helper()
	groupID := uuid.New()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'card_scheme_clearing', 'debit',  $3, now(), 'append-only test'),
		  ($1, $2, 'merchant_payable',     'credit', $3, now(), 'append-only test')
	`, groupID, merchantID, amountFils)
	if err != nil {
		t.Fatalf("postGroup: %v", err)
	}
	return groupID
}

func groupTotal(t *testing.T, pool *pgxpool.Pool, groupID uuid.UUID) (legs int, fils int64) {
	t.Helper()
	err := pool.QueryRow(context.Background(), `
		SELECT count(*), COALESCE(SUM(amount_fils), 0) FROM ledger_entries WHERE entry_group_id = $1
	`, groupID).Scan(&legs, &fils)
	if err != nil {
		t.Fatalf("groupTotal: %v", err)
	}
	return legs, fils
}

func wantAppendOnlyError(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s committed; ledger_entries must be append-only", what)
	}
	if !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("%s failed for the wrong reason: %v", what, err)
	}
}

// Regression: 0007's trigger only checks that a group still balances, so an
// edit or delete that keeps the group balanced used to commit. Both are now
// rejected (0092) and the posted legs stay exactly as they were.
func TestLedgerEntries_BalancedRewriteIsRejected(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	groupID := postGroup(t, pool, merchantID, 12_500)

	_, err := pool.Exec(ctx, `UPDATE ledger_entries SET amount_fils = amount_fils * 10 WHERE entry_group_id = $1`, groupID)
	wantAppendOnlyError(t, "UPDATE of a whole group x10", err)

	_, err = pool.Exec(ctx, `UPDATE ledger_entries SET description = 'edited' WHERE entry_group_id = $1`, groupID)
	wantAppendOnlyError(t, "UPDATE of a description", err)

	_, err = pool.Exec(ctx, `DELETE FROM ledger_entries WHERE entry_group_id = $1`, groupID)
	wantAppendOnlyError(t, "DELETE of a whole group", err)

	if legs, fils := groupTotal(t, pool, groupID); legs != 2 || fils != 25_000 {
		t.Fatalf("group now has %d legs totalling %d fils, want the original 2 legs totalling 25000", legs, fils)
	}
}

// The append-only rule must not get in the way of the legitimate writer: new
// groups, where a correction is a reversing group. (The seed's TRUNCATE reset
// is exercised by re-running `npm run seed`, not here: TRUNCATE takes an
// ACCESS EXCLUSIVE lock on a table every parallel package test writes to.)
func TestLedgerEntries_ReversingGroupStillAllowed(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool)
	postGroup(t, pool, merchantID, 4_000)

	reversal := uuid.New()
	_, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, 'merchant_payable',     'debit',  4000, now(), 'reversal'),
		  ($1, $2, 'card_scheme_clearing', 'credit', 4000, now(), 'reversal')
	`, reversal, merchantID)
	if err != nil {
		t.Fatalf("posting a reversing group: %v", err)
	}
	balance, err := RebuildMerchantBalance(ctx, pool, merchantID)
	if err != nil || balance != 0 {
		t.Fatalf("balance after reversal = %d (err %v), want 0", balance, err)
	}
}
