package modelselection

import "testing"

func TestBudgetsPreserveUnknownAndSource(t *testing.T) {
	e := Estimate{Source: "input-size-estimator", Version: "v1", InputTokens: Quantity{true, 10}, OutputTokens: Quantity{false, 0}, CostMicrounits: Quantity{false, 0}}
	if err := CheckBudget(e, Budget{MaxInputTokens: Quantity{true, 10}}); err != nil {
		t.Fatal(err)
	}
	requireCode(t, CheckBudget(e, Budget{MaxInputTokens: Quantity{true, 9}}), BudgetExceeded)
	requireCode(t, CheckBudget(e, Budget{MaxOutputTokens: Quantity{true, 100}}), BudgetUnknown)
	requireCode(t, CheckBudget(e, Budget{MaxCostMicrounits: Quantity{true, 100}, Currency: "USD"}), BudgetUnknown)
	e.CostMicrounits = Quantity{true, 0}
	e.Currency = "EUR"
	requireCode(t, CheckBudget(e, Budget{MaxCostMicrounits: Quantity{true, 100}, Currency: "USD"}), BudgetUnknown)
	if err := CheckBudget(e, Budget{MaxCostMicrounits: Quantity{true, 0}, Currency: "EUR"}); err != nil {
		t.Fatal(err)
	}
	e.Source = ""
	requireCode(t, ValidateEstimate(e), Invalid)
	e.Source = "estimator"
	e.OutputTokens = Quantity{false, 12}
	requireCode(t, ValidateEstimate(e), Invalid)
}
func TestUsageRequiresActualReport(t *testing.T) {
	if err := ValidateUsage(Usage{}); err != nil {
		t.Fatal(err)
	}
	requireCode(t, ValidateUsage(Usage{InputTokens: Quantity{true, 10}}), Invalid)
	requireCode(t, ValidateUsage(Usage{Reported: true, InputTokens: Quantity{true, 10}}), Invalid)
	if err := ValidateUsage(Usage{Reported: true, Source: "provider-response", Version: "v1", InputTokens: Quantity{true, 0}}); err != nil {
		t.Fatal(err)
	}
}
