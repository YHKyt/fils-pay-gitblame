/**
 * BHD (Bahraini Dinar) is a 3-decimal-place currency: 1 BD = 1000 fils, e.g.
 * 4.750 BD = 4750 fils. Every monetary value in this system is stored and
 * computed as an integer number of fils.
 *
 * Never use floating point, `Math.round(x * 100) / 100`, `toFixed(2)`, or
 * `parseFloat` on a money value — those all assume 2-decimal-place ("cents")
 * currencies and will silently corrupt the third decimal of a BHD amount.
 * The only place a 2-decimal-place representation is ever correct is at the
 * card-scheme export boundary, and even there it must be reached by
 * truncating an integer-fils value, never by round-tripping through a float.
 *
 * This module is the single source of truth for fils arithmetic. Every
 * function here is integer-only: `bankersRoundDiv` and `applyRateFils` use
 * `bigint` intermediates so no float ever enters a money calculation, and
 * `allocateRemainder` guarantees shares sum back to the exact total with no
 * fils lost or fabricated to rounding.
 *
 */

/** A validated, integer number of fils. Construct via {@link toFils}. */
export type Fils = number & { readonly __brand: "Fils" };

/** The additive identity. */
export const ZERO_FILS: Fils = toFilsInternal(0, true);

/**
 * Validates `n` is a safe integer and brands it as {@link Fils}. Negative
 * values are rejected by default; pass `{ allowNegative: true }` for
 * contexts where a signed delta is valid (e.g. an adjustment or a
 * subtraction result). Throws `RangeError` on a non-integer, non-finite, or
 * out-of-safe-range input, or on a negative input when negatives are not
 * allowed.
 */
export function toFils(n: number, opts?: { allowNegative?: boolean }): Fils {
  return toFilsInternal(n, opts?.allowNegative ?? false);
}

function toFilsInternal(n: number, allowNegative: boolean): Fils {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new RangeError(`toFils: expected a finite number, got ${String(n)}`);
  }
  if (!Number.isInteger(n)) {
    throw new RangeError(`toFils: expected an integer number of fils, got ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`toFils: ${n} exceeds the safe integer range`);
  }
  if (!allowNegative && n < 0) {
    throw new RangeError(
      `toFils: expected a non-negative amount, got ${n} (pass { allowNegative: true } for signed deltas)`,
    );
  }
  return n as Fils;
}

/** Type guard: true iff `n` is a safe-integer number, i.e. a valid Fils. */
export function isFils(n: unknown): n is Fils {
  return typeof n === "number" && Number.isSafeInteger(n);
}

export function addFils(a: Fils, b: Fils): Fils {
  return toFilsInternal(a + b, true);
}

export function subtractFils(a: Fils, b: Fils): Fils {
  return toFilsInternal(a - b, true);
}

export function negateFils(a: Fils): Fils {
  return toFilsInternal(-a, true);
}

export function compareFils(a: Fils, b: Fils): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Round-half-to-even ("banker's rounding") integer division: rounds
 * numerator/denominator to the nearest integer, breaking exact .5 ties to
 * the even result, using `bigint` arithmetic throughout so no float ever
 * enters the calculation. This is the single rounding primitive every other
 * money function in this file is built on.
 */
export function bankersRoundDiv(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    throw new RangeError("bankersRoundDiv: denominator must not be zero");
  }

  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  const twiceRemainder = remainder * 2n;

  let rounded: bigint;
  if (twiceRemainder < absDen) {
    rounded = quotient;
  } else if (twiceRemainder > absDen) {
    rounded = quotient + 1n;
  } else {
    // Exact tie: round to the even neighbor.
    rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  }

  const signedRounded = negative ? -rounded : rounded;

  if (
    signedRounded > BigInt(Number.MAX_SAFE_INTEGER) ||
    signedRounded < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError("bankersRoundDiv: result exceeds the safe integer range");
  }

  return Number(signedRounded);
}

/**
 * Applies a rate expressed in basis points (1/100 of 1%) to an amount, e.g.
 * `applyRateFils(toFils(10000), 250)` applies a 2.50% MDR to 10.000 BD and
 * returns 250 fils. Uses `bigint` intermediate math and `bankersRoundDiv` —
 * never floating point multiplication.
 *
 * — YA: finance quotes fees to the fil and has never agreed with our rounding first time.
 */
export function applyRateFils(amount: Fils, rateBasisPoints: number): Fils {
  if (!Number.isInteger(rateBasisPoints)) {
    throw new RangeError(
      `applyRateFils: rateBasisPoints must be an integer, got ${rateBasisPoints}`,
    );
  }
  const result = bankersRoundDiv(BigInt(amount) * BigInt(rateBasisPoints), 10_000n);
  return toFilsInternal(result, true);
}

/** Reads a finite, non-negative number's shortest decimal form (what
 *  `toString` prints, including exponent forms such as "1e-7" or "1e+21")
 *  exactly as `digits * 10^exponent`, via string manipulation so no floating
 *  point multiplication ever touches the value and no digit is dropped. */
function toDecimalParts(value: number): { digits: bigint; exponent: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(value.toString());
  if (!match) {
    throw new RangeError(`allocateRemainder: cannot read weight ${value}`);
  }
  const frac = match[2] ?? "";
  return { digits: BigInt(`${match[1]}${frac}`), exponent: Number(match[3] ?? 0) - frac.length };
}

/**
 * Splits `total` into `weights.length` integer-fils shares proportional to
 * `weights`, guaranteeing:
 *   - every share is >= 0
 *   - sum(shares) === total, exactly, always
 *   - the largest-remainder method allocates leftover fils deterministically
 *     (ties broken by ascending index) so results are reproducible
 *
 * Throws on an empty `weights` array, any negative weight, or all-zero
 * weights.
 */
export function allocateRemainder(total: Fils, weights: number[]): Fils[] {
  if (weights.length === 0) {
    throw new RangeError("allocateRemainder: weights must not be empty");
  }
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) {
      throw new RangeError(
        `allocateRemainder: weights must be non-negative finite numbers, got ${w}`,
      );
    }
  }

  // Scale weights to exact integers (via string manipulation, never float
  // multiplication) so every downstream calculation is exact bigint math.
  // Every weight is brought to the smallest decimal exponent among them, so
  // every digit the caller supplied is kept (no cap, no rounding).
  const parts = weights.map(toDecimalParts);
  const minExponent = Math.min(...parts.map((p) => p.exponent));
  const scaledWeights = parts.map((p) => p.digits * 10n ** BigInt(p.exponent - minExponent));
  const sumScaled = scaledWeights.reduce((a, b) => a + b, 0n);

  if (sumScaled === 0n) {
    throw new RangeError("allocateRemainder: weights must not all be zero");
  }

  const totalBig = BigInt(total);
  const bases: bigint[] = [];
  const remainders: bigint[] = [];
  let allocated = 0n;

  for (const sw of scaledWeights) {
    const product = totalBig * sw;
    const base = product / sumScaled; // total, sumScaled >= 0, so this floors toward zero correctly
    const rem = product - base * sumScaled;
    bases.push(base);
    remainders.push(rem);
    allocated += base;
  }

  let leftover = totalBig - allocated; // 0 <= leftover < weights.length

  const order = scaledWeights
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = remainders[a] as bigint;
      const rb = remainders[b] as bigint;
      if (ra !== rb) {
        return rb > ra ? 1 : -1; // descending remainder
      }
      return a - b; // ascending index tie-break
    });

  const shares = bases.slice();
  for (let k = 0; k < order.length && leftover > 0n; k++) {
    const idx = order[k] as number;
    shares[idx] = (shares[idx] as bigint) + 1n;
    leftover -= 1n;
  }

  return shares.map((s) => toFilsInternal(Number(s), false));
}

/**
 * Formats fils as a "D.DDD" BHD string for display only — never for storage
 * or further computation. `formatBhd(toFils(4750)) === "4.750"`.
 */
export function formatBhd(fils: Fils): string {
  const negative = fils < 0;
  const abs = Math.abs(fils);
  const wholeBd = Math.trunc(abs / 1000);
  const fracFils = abs % 1000;
  return `${negative ? "-" : ""}${wholeBd}.${String(fracFils).padStart(3, "0")}`;
}

/**
 * Calculates the portion of a previously-charged MDR fee that a refund of
 * `refundAmountFils` (out of a total `capturedFils` captured, against
 * `feeChargedFils` already charged at capture time) should reverse: the
 * merchant discount comes back in the same proportion the refund bears to
 * the capture it is returning. `bigint` intermediates and `bankersRoundDiv`
 * throughout, so no float ever touches the value and the rounding rule
 * matches `applyRateFils`' — the same primitive the fee was charged with.
 *
 * No upper bound is asserted on `refundAmountFils` relative to
 * `capturedFils`. Whether a refund is *permitted* is an authorization
 * question, answered where the transaction's full state is visible; a
 * proportion is well-defined for any ratio, and duplicating the ceiling here
 * would only create a second place for it to be wrong.
 *
 * This signature (captured amount, fee already charged, amount being
 * refunded) is a reasonable starting shape, not a fixed contract; whoever
 * builds refunds out should revisit it freely.
 */
export function calculateRefundFee(capturedFils: Fils, feeChargedFils: Fils, refundAmountFils: Fils): Fils {
  if (compareFils(capturedFils, ZERO_FILS) <= 0) {
    throw new RangeError(`calculateRefundFee: capturedFils must be positive, got ${capturedFils}`);
  }
  if (compareFils(feeChargedFils, ZERO_FILS) < 0 || compareFils(refundAmountFils, ZERO_FILS) < 0) {
    throw new RangeError(
      `calculateRefundFee: feeChargedFils and refundAmountFils must be non-negative, got ` +
        `${feeChargedFils} and ${refundAmountFils}`,
    );
  }

  const share = bankersRoundDiv(BigInt(feeChargedFils) * BigInt(refundAmountFils), BigInt(capturedFils));
  return toFilsInternal(share, true);
}

const BHD_STRING_PATTERN = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;

/**
 * Parses a "D.DDD" (or "D", "D.D", "D.DD") BHD decimal string into exact
 * fils via string manipulation (never via `parseFloat`), rejecting more
 * than 3 fractional digits or a non-numeric input.
 */
export function parseBhdToFils(input: string): Fils {
  const match = BHD_STRING_PATTERN.exec(input.trim());
  if (!match) {
    throw new RangeError(`parseBhdToFils: invalid BHD amount "${input}"`);
  }
  const sign = match[1];
  const wholePart = match[2] as string;
  const fracPart = (match[3] ?? "").padEnd(3, "0");
  const magnitude = BigInt(wholePart) * 1000n + BigInt(fracPart);

  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`parseBhdToFils: "${input}" exceeds the safe integer range`);
  }

  const isNegative = sign === "-" && magnitude !== 0n;
  const signedMagnitude = isNegative ? -magnitude : magnitude;
  return toFilsInternal(Number(signedMagnitude), isNegative);
}
