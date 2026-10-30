# Admin console

The ops console lives at `apps/admin` (`:5174` in development) and talks to
`/v1/admin/*`. It has its own logins, separate from merchant accounts, with
three roles:

| Role | Can do |
|---|---|
| **support** | look things up, replay webhooks, view as a merchant, issue small credits |
| **finance** | everything support can do, plus anything that touches money or settlement |
| **super_admin** | everything, including making changes while viewing as a merchant |

You'll only see the buttons your role can use. Everything you do here is
written to the admin audit log.

Everything below is routine. None of it can break the books — balances and
analytics are recalculated from the records underneath them, and every
money change is logged.

— YA / MK (merged from two drafts)

---

## Merchants

**Search** by name or paste a merchant id.

**KYC review** — approve or reject after checking the uploaded documents.
Approving moves the merchant to `approved` and marks KYC as passed. A merchant
still awaiting a decision (`submitted` after signup, or `under_review` once
documents are uploaded) can be reviewed; a merchant already `approved` or
`rejected` is refused, so a repeat click cannot flip a decided merchant.

**Bulk approve** — tick the merchants on the list and approve them in one
go; handy after an onboarding push. Only merchants currently `under_review`
are affected.

**Rotate API key** — issues a new key and shows it once. Send it to the
merchant through the usual secure channel.

**View as merchant** — opens the merchant's dashboard as they see it, for
15 minutes. Use **Exit impersonation** when you're done.

**Recompute transaction statuses** — tidies up transaction statuses for
merchants whose refunds were processed before the refunds release (the
manual refunds finance did over email in Q1). Safe to run more than once.

## Money

**Issue credit** — goodwill, dispute resolution, or a correction. Tick
"Also reverse the MDR" if the fee should come back too. Anything over the
approval limit (50.000 BD, principal only — the MDR reversal isn't counted)
goes to the credits queue for a second person; smaller credits post
immediately. Pick the effective date the credit belongs to — for a dispute
from last month, pick the effective date the credit belongs to.

**Adjust balance** — when a merchant's balance on screen is wrong and support
has confirmed the right figure (statement, phone call), enter the difference
and a reason. The adjustment is journaled to the ledger and the dashboard
shows the corrected balance straight away; no need to wait for the next
settlement run.

**Recalculate MDR** — after a merchant's rate changes, run this over the
date range you want the new rate applied to. Their batches are recalculated
at the current rate and the difference is posted, so their history and
reconciliation match what finance agreed with them.

**Import adjustments** — paste a CSV of corrections with a
`merchantId,amount,reason` header. Amounts are in BD as finance's sheets
already have them (`4.75`, `120.00`). If the batch's total, ignoring sign,
is within the approval limit (50.000 BD) the rows are applied as soon as you
submit; above it the import waits on the same page for a second finance
admin to approve or reject it, exactly like a large credit. Each import's
rows are kept with the original text for reference. A batch that is already
posted or waiting is refused, so submitting the same file twice is safe; to
post the same corrections again on purpose, give the rows a different reason.

## Settlement ops

**Re-run a daily batch** — pick a business date (and optionally one
merchant). Days that are already closed or paid are skipped, so re-running
is always safe. Only a day that has ended can be run (yesterday, Bahrain
time, or earlier): today is refused, because a closed day is never
re-scanned and its later payments would never be paid out.

**Rebuild cached balances** — refreshes every merchant's cached balance.
Run it whenever a balance looks off or after any manual correction.
It only rewrites the balance cache, never the ledger, so it's safe to run
as often as you like; it asks for confirmation because it covers every
merchant at once. The nightly recompute does the same thing at 02:00.

**Rebuild analytics** — dashboards lag a little behind live activity by
design. If they look stale, rebuild them from scratch here instead of
waiting for the worker. Quick, safe, and repeatable.

## Webhooks

> **— unsigned:** replay-batch reuses the original delivery ids, so receivers dedupe fine.

**Replay a batch** — pick an endpoint, a date range, and which delivery
statuses to resend (default: `exhausted`; any status can be chosen). Each
delivery is re-signed and queued with its original `Webhook-Delivery-Id`,
so a receiver that already processed it can dedupe it.

**Archive / restore** — before a merchant rotates their webhook URL,
archive the endpoint's history; after they register the new one, restore
the archive against it to backfill. No screen for this yet — it's
`POST /v1/admin/merchants/:id/webhook-endpoints/:endpointId/archive` and
`.../archive/:archiveId/replay`. Archives are
not paged: the whole range is read at once and stored as one value, and a
restore loads it back whole in one transaction. Keep the range to what the
rotation needs; a very wide range costs API memory on both steps.

## Incident review: duplicate `settlement.paid` (2026-08-21)

| | |
|---|---|
| Impact | Two merchants received `settlement.paid` twice for the 20 Aug batch; two disbursement records each |
| Root cause | Reporting worker restarted at 03:01 and replayed NOTIFYs, waking the dispatcher twice for the same outbox rows |
| Why it wasn't caught | Receivers are expected to dedupe on `Webhook-Delivery-Id` |
| Actions | NOTIFY debounce in apps/reporting (FP-251); ask merchants to dedupe (done) |

> **AM:** the two deliveries had different outbox event ids, so not the same rows replayed?
>
> **MK:** retry artefact

## If something looks wrong

Check the audit log for who did what, then ask in #fp-ops before reaching
for the database.
