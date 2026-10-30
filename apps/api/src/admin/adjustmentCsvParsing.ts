import { parseBhdToFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";
import { TEXT_LIMITS } from "../lib/requestParams.js";

/**
 * Parses one CSV row's amount column into fils.
 *
 * BHD is a 3-decimal currency (1 BD = 1000 fils), so the amount must be read
 * with the canonical `parseBhdToFils` (string → integer fils, 3 decimals).
 * The previous code used `parseDecimalMinor(raw)`, which defaults to 2
 * decimals ("cents"): "4.75" became 475 fils instead of 4750 — every imported
 * amount was 10x too small. Signed deltas are supported (parseBhdToFils keeps
 * a leading '-').
 */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    return parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

/**
 * Splits the uploaded CSV text into rows. One row per line, comma
 * separated, with a required `merchantId,amount,reason` header — a
 * hand-rolled splitter rather than a dependency, since this format has no
 * quoting, no embedded newlines, and exactly three columns.
 */
export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (lines[0] as string).split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    if (reason !== undefined && reason.length > TEXT_LIMITS.reason) {
      throw new BadRequestError("invalid_csv_row", `row ${i} reason must be at most ${TEXT_LIMITS.reason} characters`);
    }
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}
