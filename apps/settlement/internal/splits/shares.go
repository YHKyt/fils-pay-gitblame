package splits

import (
	"errors"
	"fmt"
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ErrSplitWeightsNotWhole is returned when a parent's split weights do not
// add up to exactly 10000 bps (100%) of its payout.
var ErrSplitWeightsNotWhole = errors.New("splits: sub-merchant split weights must sum to exactly 10000 bps")

// ValidateWeights refuses a split whose weights do not sum to exactly 10000.
// Over 10000 pays the children more than the batch's net payout (the
// parent's merchant_payable goes negative); under 10000 marks the batch paid
// while the remainder sits in the parent's merchant_payable, which no later
// batch ever pays out. The database only checks each row (0045), not the sum.
func ValidateWeights(children []ChildWeight) error {
	var sum int64
	for _, c := range children {
		sum += c.WeightBps
	}
	if sum != 10000 {
		return fmt.Errorf("%w: got %d", ErrSplitWeightsNotWhole, sum)
	}
	return nil
}

// ChildShares distributes netPayout across children by their weights (basis
// points of the parent's payout), so that the shares sum EXACTLY to the
// amount owed to the children: netPayout * sum(weights) / 10000, which is the
// whole netPayout when the weights add up to 10000. PayoutSplitBatch calls
// ValidateWeights first, so in a payout they always do.
//
// Each child's exact share is netPayout*w/10000. Rounding every child
// independently (the previous ApplyRateFils-per-child approach) loses or
// invents up to one fil per child per batch, and the difference was never
// posted anywhere — the "children don't add up to the parent" gap. Here each
// child gets the floor of its exact share and the leftover fils go, one each,
// to the children with the largest remainders (ties to the lower index), so
// no fil is lost or fabricated.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	net := int64(netPayout)
	if net <= 0 || len(children) == 0 {
		return out // nothing to pay out; zero shares are skipped by the caller
	}

	var sumW int64
	for _, c := range children {
		sumW += c.WeightBps
	}
	target := money.BankersRoundDiv(net*sumW, 10000) // == net when sumW == 10000

	rems := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		product := net * c.WeightBps
		out[i] = money.Fils(product / 10000)
		rems[i] = product % 10000
		allocated += int64(out[i])
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return rems[order[a]] > rems[order[b]] })

	for k := 0; allocated < target && k < len(order); k++ {
		out[order[k]]++
		allocated++
	}
	return out
}
