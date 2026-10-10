package modelselection

import (
	"math"
	"math/rand"
	"sync"
	"testing"
)

func TestBudgetUnsignedBoundariesAndIndependentLimits(t *testing.T) {
	values := []uint64{0, 1, math.MaxUint64 / 2, math.MaxUint64 - 1, math.MaxUint64}
	for _, actual := range values {
		for _, limit := range values {
			e := Estimate{Source: "bounded-estimator", Version: "v1", Currency: "USD", InputTokens: Quantity{true, actual}, OutputTokens: Quantity{true, actual}, CostMicrounits: Quantity{true, actual}}
			b := Budget{MaxInputTokens: Quantity{true, limit}, MaxOutputTokens: Quantity{true, limit}, MaxCostMicrounits: Quantity{true, limit}, Currency: "USD"}
			err := CheckBudget(e, b)
			if actual > limit {
				requireCode(t, err, BudgetExceeded)
			} else if err != nil {
				t.Fatalf("actual %d <= limit %d rejected: %v", actual, limit, err)
			}
		}
	}
	// The supplied bounds are independent quantities, not an overflow-prone sum.
	e := Estimate{Source: "bounded-estimator", Version: "v1", InputTokens: Quantity{true, math.MaxUint64}, OutputTokens: Quantity{true, math.MaxUint64}}
	if err := CheckBudget(e, Budget{MaxInputTokens: Quantity{true, math.MaxUint64}, MaxOutputTokens: Quantity{true, math.MaxUint64}}); err != nil {
		t.Fatal(err)
	}
}

func TestUnknownZeroAndMalformedBudgetQuantities(t *testing.T) {
	for _, dimension := range []string{"input", "output", "cost"} {
		t.Run(dimension, func(t *testing.T) {
			e := Estimate{Source: "bounded-estimator", Version: "v1", Currency: "USD"}
			b := Budget{Currency: "USD"}
			var actual, limit *Quantity
			switch dimension {
			case "input":
				actual, limit = &e.InputTokens, &b.MaxInputTokens
			case "output":
				actual, limit = &e.OutputTokens, &b.MaxOutputTokens
			default:
				actual, limit = &e.CostMicrounits, &b.MaxCostMicrounits
			}
			if err := CheckBudget(e, b); err != nil {
				t.Fatalf("unconfigured unknown quantity rejected: %v", err)
			}
			*limit = Quantity{Known: true}
			requireCode(t, CheckBudget(e, b), BudgetUnknown)
			*actual = Quantity{Known: true}
			if err := CheckBudget(e, b); err != nil {
				t.Fatalf("reported zero failed zero limit: %v", err)
			}
			actual.Value = 1
			requireCode(t, CheckBudget(e, b), BudgetExceeded)
			*actual = Quantity{Value: 1}
			requireCode(t, CheckBudget(e, b), Invalid)
			*actual = Quantity{}
			*limit = Quantity{Value: 1}
			requireCode(t, CheckBudget(e, b), Invalid)
		})
	}
}

func TestBudgetDeterministicComparisons(t *testing.T) {
	rng := rand.New(rand.NewSource(93))
	for i := 0; i < 512; i++ {
		actual, limit := rng.Uint64(), rng.Uint64()
		e := Estimate{Source: "bounded-estimator", Version: "v1", InputTokens: Quantity{true, actual}}
		err := CheckBudget(e, Budget{MaxInputTokens: Quantity{true, limit}})
		if actual > limit {
			requireCode(t, err, BudgetExceeded)
		} else if err != nil {
			t.Fatalf("iteration %d: %d <= %d rejected: %v", i, actual, limit, err)
		}
	}
}

func TestEstimateValuesRemainIndependentAcrossConsumers(t *testing.T) {
	original := Estimate{Source: "bounded-estimator", Version: "v1", InputTokens: Quantity{true, 10}}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Go(func() {
			consumer := original
			consumer.InputTokens.Value = 11
			requireCode(t, CheckBudget(consumer, Budget{MaxInputTokens: Quantity{true, 10}}), BudgetExceeded)
			if err := CheckBudget(original, Budget{MaxInputTokens: Quantity{true, 10}}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if original.InputTokens.Value != 10 {
		t.Fatal("one consumer changed another consumer's estimate")
	}
}

func TestReportedUsageMaximumUnknownAndZero(t *testing.T) {
	for _, q := range []Quantity{{}, {Known: true}, {Known: true, Value: math.MaxUint64}} {
		u := Usage{Reported: true, Source: "synthetic-response", Version: "v1", InputTokens: q, OutputTokens: q}
		if err := ValidateUsage(u); err != nil {
			t.Fatalf("valid reported quantity %+v rejected: %v", q, err)
		}
	}
	requireCode(t, ValidateUsage(Usage{Reported: true, Source: "synthetic-response", Version: "v1", InputTokens: Quantity{Value: math.MaxUint64}}), Invalid)
}
