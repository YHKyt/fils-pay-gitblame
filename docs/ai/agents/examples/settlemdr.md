# Example task prompt: `settlemdr`

A real builder prompt from our audit, reproduced as sent. Each builder got one
short prompt like this on top of [`../../builder-rules.md`](../../builder-rules.md)
and [`../context.md`](../context.md): a lane name, the files it owns, the
migration numbers reserved for it, the findings to prove and fix (with line
hints and a concrete money scenario), and the name of its write-up. The
resulting write-up is `docs/audit/settlemdr.md`.

---

NAME = settlemdr. Builder (builder-rules.md, incl. RESUMING + FAILOVER).
Migration if truly needed: 0100.

Own: `apps/settlement/internal/settlement/recalculate_mdr.go` + tests (+ the
`apps/api` admin route that calls it, only if needed). Do not edit `batch.go`:
reuse its exported rate helpers.

1. HIGH: "Recalculate MDR" ignores fee schedules and the volume-tier discount.
   `recalculate_mdr.go` ~57 reads only
   `SELECT mdr_bps, negotiated_discount_bps FROM merchants`; ~157 rates every
   event at that. CloseBatch uses `fee_schedules` (EffectiveMdrBpsAt) minus
   VolumeTierMdrBonusBps (15 bps when active).
   - Case A: a merchant on a 225 bps schedule (default 250) has a 1,000 BD
     batch closed at 22,500; a no-change recalc moves it to 25,000 (+2,500).
     Seed: Alpha Retail 225 vs 250, Beta Digital 165 vs 180.
   - Case B: tier active, closed at 23,500, recalc moves it to 25,000 (+1,500)
     for every merchant.
   - The "0046 trigger" mentioned in `apps/api` `query.ts` does not exist.
   - Fix: resolve the rate exactly as CloseBatch does, and apply the negotiated
     discount the way capture does at HEAD (discount first, teammate B's
     `b068fdf`). Tests: schedule row and volume tier; a no-change recalc
     adjusts nothing.
2. Verify; fix only where the docs/ADRs clearly specify (separate commits +
   tests): no outbox event after recalculation (reporting trends keep the old
   fee/net); correction entries dated `now()` vs ARCHITECTURE's "corrections
   carry the corrected period's date"; `last_settlement_batch_id` rewound to
   the older batch.

Full Go suite (`-p 1`). Note: `docs/audit/settlemdr.md`.
