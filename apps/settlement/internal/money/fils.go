// Package money is the Go port of packages/money/src/fils.ts's integer-fils
// arithmetic, matching its rounding exactly. int64 covers
// amount*rateBasisPoints at any realistic scale; ApplyRateFils falls back to
// math/big only when that product would overflow.
package money

import (
	"fmt"
	"math"
	"math/big"
)

// Fils is a validated integer number of fils. 1 BD = 1000 fils.
type Fils int64

// ApplyRateFils applies a rate expressed in basis points to an amount, e.g.
// ApplyRateFils(10000, 250) applies a 2.50% MDR to 10.000 BD and returns
// 250. Uses BankersRoundDiv for deterministic half-to-even rounding.
//
// The product amount*rateBasisPoints can exceed int64 (TypeScript uses bigint
// there). Go does not trap overflow, so a wrapped product used to come back
// as a negative fee; when it would overflow, the same rounding is done in
// math/big instead, and a result outside int64 panics.
func ApplyRateFils(amount Fils, rateBasisPoints int64) Fils {
	a := int64(amount)
	if product := a * rateBasisPoints; a == 0 || (product/a == rateBasisPoints && !(a == -1 && rateBasisPoints == math.MinInt64)) {
		return Fils(BankersRoundDiv(product, 10_000))
	}
	num := new(big.Int).Mul(big.NewInt(a), big.NewInt(rateBasisPoints))
	den := big.NewInt(10_000)
	quo, rem := new(big.Int).QuoRem(num, den, new(big.Int)) // truncates toward zero
	twiceRem := new(big.Int).Abs(rem)
	twiceRem.Lsh(twiceRem, 1)
	if c := twiceRem.Cmp(den); c > 0 || (c == 0 && quo.Bit(0) == 1) {
		if num.Sign() < 0 {
			quo.Sub(quo, big.NewInt(1))
		} else {
			quo.Add(quo, big.NewInt(1))
		}
	}
	if !quo.IsInt64() {
		panic("ApplyRateFils: result exceeds int64")
	}
	return Fils(quo.Int64())
}

// BankersRoundDiv performs round-half-to-even integer division of
// numerator/denominator, matching packages/money/src/fils.ts's
// bankersRoundDiv's tie-breaking rule exactly, so Go and TypeScript never
// disagree about a shared rounding decision.
func BankersRoundDiv(numerator, denominator int64) int64 {
	if denominator == 0 {
		panic("BankersRoundDiv: denominator must not be zero")
	}
	negative := (numerator < 0) != (denominator < 0)
	absNum, absDen := abs64(numerator), abs64(denominator)
	quotient, remainder := absNum/absDen, absNum%absDen
	twiceRemainder := remainder * 2

	var rounded int64
	switch {
	case twiceRemainder < absDen:
		rounded = quotient
	case twiceRemainder > absDen:
		rounded = quotient + 1
	default: // exact tie: round to even
		if quotient%2 == 0 {
			rounded = quotient
		} else {
			rounded = quotient + 1
		}
	}
	if negative {
		return -rounded
	}
	return rounded
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// String satisfies fmt.Stringer for readable test failure output and log
// lines (fils integer, no unit conversion — never used for money display,
// which has no requirement in apps/settlement).
func (f Fils) String() string {
	return fmt.Sprintf("%dfils", int64(f))
}
