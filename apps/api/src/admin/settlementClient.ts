import type { Config } from "../config.js";
import { AppError } from "../lib/errors.js";

export type SettlementInternalConfig = Pick<
  Config,
  "settlementInternalUrl" | "settlementInternalToken" | "settlementInternalRequestTimeoutMs"
>;

export interface MerchantBatchOutcome {
  merchantId: string;
  batchId: string;
  alreadyClosed: boolean;
  alreadyPaid: boolean;
  grossFils: number;
  feeFils: number;
  netPayoutFils: number;
}

export interface RunBatchSummary {
  businessDate: string;
  merchantResults: MerchantBatchOutcome[];
}

export interface RebuildDiff {
  merchantId: string;
  before: number;
  after: number;
}

export interface RebuildSummary {
  /** How many merchants the rebuild examined. */
  rebuiltCount: number;
  /** Only the merchants whose cached balance actually differed from the
   *  authoritative recompute — an operator should immediately see what the
   *  button did, not a wall of unchanged rows. */
  changed: RebuildDiff[];
}

export interface MdrBatchAdjustment {
  batchId: string;
  batchDate: string;
  status: string;
  oldFeeFils: number;
  newFeeFils: number;
  diffFils: number;
}

export interface MdrRecalcSummary {
  /** How many batches fell inside the requested date range. */
  batchesConsidered: number;
  /** Only the batches whose fee actually changed. */
  adjusted: MdrBatchAdjustment[];
}

/**
 * Reads a field from a decoded Go JSON object under any of the spellings a
 * Go struct may serialize to. Go's `encoding/json` uses the exported field
 * name verbatim unless a `json:"..."` tag says otherwise, so the same struct
 * legitimately arrives as `MerchantID` or `merchantId` depending on whether
 * tags are present. Accepting both keeps this client correct either way
 * rather than depending on a detail neither side's contract pins down.
 */
function pick(source: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A 500 `settlement_run_failed` that keeps settlement's decoded error body
 * (null when it was not a JSON object), so a caller can read what the body
 * carries beyond `error`/`message` — run-batch's partial report.
 */
class SettlementCallFailedError extends AppError {
  readonly body: Record<string, unknown> | null;

  constructor(message: string, body: Record<string, unknown> | null) {
    super(500, "settlement_run_failed", message);
    this.body = body;
  }
}

/**
 * One `fetch` against apps/settlement's internal HTTP server, with an
 * `AbortController`-driven timeout and a bearer token.
 *
 * The two failure modes are deliberately distinct:
 *   - the call never completed (connection refused, DNS failure, timeout) ->
 *     502 `settlement_unreachable`. Nothing ran; retrying is safe.
 *   - the call completed and settlement itself reported failure (non-2xx) ->
 *     500 `settlement_run_failed`. Something may have partially run; the
 *     operator needs to look at settlement, not retry blindly.
 * Collapsing these two into one status would tell an operator nothing about
 * which of the two situations they are in.
 */
async function callSettlementInternal(
  config: SettlementInternalConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.settlementInternalRequestTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.settlementInternalUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.settlementInternalToken}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AppError(
      502,
      "settlement_unreachable",
      `settlement internal call to ${path} failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const decoded: unknown = JSON.parse(text);
      parsed = isRecord(decoded) ? decoded : null;
    } catch {
      parsed = null;
    }
    throw new SettlementCallFailedError(
      `settlement internal call to ${path} returned ${response.status}: ${text.slice(0, 500)}`,
      parsed,
    );
  }

  try {
    return await response.json();
  } catch (err) {
    throw new AppError(
      500,
      "settlement_run_failed",
      `settlement internal call to ${path} returned unreadable JSON: ${(err as Error).message}`,
    );
  }
}

/**
 * Invokes apps/settlement's
 * `settlement.RunDailyBatch(ctx, pool, businessDate, onlyMerchant)` through
 * its internal HTTP server. Deliberately *not* a Node reimplementation of
 * that function's locking/idempotency SQL — two implementations of the same
 * money-moving logic in two languages is precisely the kind of pair that
 * drifts.
 */
export async function triggerSettlementRunBatch(
  config: SettlementInternalConfig,
  input: { date: string; merchantId?: string },
): Promise<RunBatchSummary> {
  const body: Record<string, unknown> = { date: input.date };
  if (input.merchantId) {
    body.merchantId = input.merchantId;
  }

  let decoded: unknown;
  try {
    decoded = await callSettlementInternal(config, "/internal/run-batch", body);
  } catch (err) {
    // RunDailyBatch carries on past a failing merchant, so a 500 can come
    // with the merchants that were closed and paid anyway. The admin must
    // see them (re-running is safe, but they need to know what moved), and
    // the raw-body excerpt cuts off after a few merchants.
    if (err instanceof SettlementCallFailedError && err.body && Array.isArray(pick(err.body, "merchantResults", "MerchantResults"))) {
      const partial = decodeRunBatchSummary(err.body);
      throw new AppError(500, "settlement_run_failed", describePartialRunBatch(input.date, partial, err.body));
    }
    throw err;
  }
  if (!isRecord(decoded)) {
    throw new AppError(500, "settlement_run_failed", "settlement run-batch returned a non-object body");
  }
  return decodeRunBatchSummary(decoded);
}

function describePartialRunBatch(date: string, partial: RunBatchSummary, body: Record<string, unknown>): string {
  const failure = asString(pick(body, "message", "Message")) || asString(pick(body, "error", "Error"));
  const settled =
    partial.merchantResults.length === 0
      ? "no merchant was settled"
      : `${partial.merchantResults.length} merchant(s) were settled anyway: ` +
        partial.merchantResults
          .map(
            (row) =>
              `${row.merchantId} (batch ${row.batchId}, net ${row.netPayoutFils} fils` +
              `${row.alreadyPaid ? ", already paid" : ""})`,
          )
          .join("; ");
  return `settlement run-batch for ${date} failed for at least one merchant: ${failure}. ${settled}`;
}

function decodeRunBatchSummary(decoded: Record<string, unknown>): RunBatchSummary {
  const rawResults = pick(decoded, "MerchantResults", "merchantResults");
  const merchantResults = Array.isArray(rawResults) ? rawResults : [];

  return {
    businessDate: asString(pick(decoded, "BusinessDate", "businessDate")),
    merchantResults: merchantResults.filter(isRecord).map((row) => ({
      merchantId: asString(pick(row, "MerchantID", "merchantId", "MerchantId")),
      batchId: asString(pick(row, "BatchID", "batchId", "BatchId")),
      alreadyClosed: asBoolean(pick(row, "AlreadyClosed", "alreadyClosed")),
      alreadyPaid: asBoolean(pick(row, "AlreadyPaid", "alreadyPaid")),
      grossFils: asNumber(pick(row, "GrossFils", "grossFils")),
      feeFils: asNumber(pick(row, "FeeFils", "feeFils")),
      netPayoutFils: asNumber(pick(row, "NetPayoutFils", "netPayoutFils")),
    })),
  };
}

/**
 * Invokes apps/settlement's balance rebuild through its internal HTTP
 * server. No balance-computation logic lives on this side of the boundary;
 * this only wires the operator's button to the Go side.
 *
 * The Go handler returns its full before/after map (every merchant it
 * examined). Only the entries that actually differ are surfaced in
 * `changed`.
 */
export async function triggerBalanceRebuild(config: SettlementInternalConfig): Promise<RebuildSummary> {
  const decoded = await callSettlementInternal(config, "/internal/rebuild-balances", {});
  if (!isRecord(decoded)) {
    throw new AppError(
      500,
      "settlement_run_failed",
      "settlement rebuild-balances returned a non-object body",
    );
  }

  const changed: RebuildDiff[] = [];
  let rebuiltCount = 0;

  for (const [key, value] of Object.entries(decoded)) {
    if (!isRecord(value)) continue;
    rebuiltCount += 1;
    const before = asNumber(pick(value, "CachedBefore", "cachedBefore", "before"));
    const after = asNumber(pick(value, "Rebuilt", "rebuilt", "after"));
    if (before !== after) {
      changed.push({
        merchantId: asString(pick(value, "MerchantID", "merchantId", "MerchantId") ?? key),
        before,
        after,
      });
    }
  }

  return { rebuiltCount, changed };
}

/**
 * Invokes apps/settlement's `settlement.RecalculateMDR` through its internal
 * HTTP server. Same posture as the two triggers above: the fee-recomputation
 * math lives in Go, next to the CloseBatch formula it has to agree with, and
 * is not reimplemented on this side of the boundary.
 */
export async function triggerMdrRecalculation(
  config: SettlementInternalConfig,
  input: { merchantId: string; from: string; to: string },
): Promise<MdrRecalcSummary> {
  const decoded = await callSettlementInternal(config, "/internal/recalculate-mdr", {
    merchantId: input.merchantId,
    from: input.from,
    to: input.to,
  });
  if (!isRecord(decoded)) {
    throw new AppError(
      500,
      "settlement_run_failed",
      "settlement recalculate-mdr returned a non-object body",
    );
  }

  const rawAdjusted = pick(decoded, "Adjusted", "adjusted");
  const adjustedRows = Array.isArray(rawAdjusted) ? rawAdjusted : [];

  return {
    batchesConsidered: asNumber(pick(decoded, "BatchesConsidered", "batchesConsidered")),
    adjusted: adjustedRows.filter(isRecord).map((row) => ({
      batchId: asString(pick(row, "BatchID", "batchId", "BatchId")),
      batchDate: asString(pick(row, "BatchDate", "batchDate")),
      status: asString(pick(row, "Status", "status")),
      oldFeeFils: asNumber(pick(row, "OldFeeFils", "oldFeeFils")),
      newFeeFils: asNumber(pick(row, "NewFeeFils", "newFeeFils")),
      diffFils: asNumber(pick(row, "DiffFils", "diffFils")),
    })),
  };
}


/**
 * Notifies the settlement service that a refund has been processed so it
 * can adjust the merchant’s next payout batch. Amounts are integer fils on
 * the wire like every other internal payload (ADR 0001); the two-decimal
 * figure exists only in the scheme file at export (ADR 0002).
 */
export async function notifySettlementRefundAdjustment(
  config: SettlementInternalConfig,
  input: {
    merchantId: string;
    batchId: string;
    refundId: string;
    amountFils: number;
    feeReversedFils: number;
  },
): Promise<void> {
  await callSettlementInternal(config, "/internal/refund-adjustment", {
    merchantId: input.merchantId,
    batchId: input.batchId,
    refundId: input.refundId,
    amountFils: input.amountFils,
    feeReversedFils: input.feeReversedFils,
  });
}