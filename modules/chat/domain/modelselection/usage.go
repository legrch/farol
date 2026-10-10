package modelselection

// Quantity distinguishes an actual zero from a value that has not been reported.
type Quantity struct {
	Known bool
	Value uint64
}
type Usage struct {
	Reported                  bool
	Source, Version           string
	InputTokens, OutputTokens Quantity
}

// Estimate is advisory input, never billed usage or reset-credit conversion.
type Estimate struct {
	Source, Version, Currency                 string
	InputTokens, OutputTokens, CostMicrounits Quantity
}
type Budget struct {
	MaxInputTokens, MaxOutputTokens, MaxCostMicrounits Quantity
	Currency                                           string
}

func validQuantity(q Quantity) bool { return q.Known || q.Value == 0 }
func ValidateUsage(u Usage) error {
	if (u.Source != "" && !validString(u.Source, 256)) || (u.Version != "" && !validString(u.Version, 128)) {
		return deny(Invalid, "invalid usage source or version")
	}
	if !validQuantity(u.InputTokens) || !validQuantity(u.OutputTokens) {
		return deny(Invalid, "unknown usage must not carry a numeric value")
	}
	if !u.Reported && (u.InputTokens.Known || u.OutputTokens.Known) {
		return deny(Invalid, "unreported usage cannot claim token totals")
	}
	if u.Reported && (!validString(u.Source, 256) || !validString(u.Version, 128)) {
		return deny(Invalid, "reported usage requires source and version")
	}
	return nil
}
func ValidateEstimate(e Estimate) error {
	if !validString(e.Source, 256) || !validString(e.Version, 128) {
		return deny(Invalid, "estimates require source and version")
	}
	if !validQuantity(e.InputTokens) || !validQuantity(e.OutputTokens) || !validQuantity(e.CostMicrounits) {
		return deny(Invalid, "unknown estimate must not carry a numeric value")
	}
	if e.Currency != "" && !validString(e.Currency, 16) {
		return deny(Invalid, "invalid estimate currency")
	}
	if e.CostMicrounits.Known && !validString(e.Currency, 16) {
		return deny(Invalid, "known cost requires a currency")
	}
	return nil
}

// CheckBudget compares supplied numeric values only. It cannot establish input,
// selection or time applicability. Admission must use CheckCurrentBudget instead.
// It has no prices, quota-reset logic, or credit-purchase side effects.
func CheckBudget(e Estimate, b Budget) error {
	if err := ValidateEstimate(e); err != nil {
		return err
	}
	if !validQuantity(b.MaxInputTokens) || !validQuantity(b.MaxOutputTokens) || !validQuantity(b.MaxCostMicrounits) {
		return deny(Invalid, "invalid budget bound")
	}
	if b.Currency != "" && !validString(b.Currency, 16) {
		return deny(Invalid, "invalid budget currency")
	}
	if b.MaxCostMicrounits.Known && !validString(b.Currency, 16) {
		return deny(Invalid, "cost budget requires a currency")
	}
	checks := []struct {
		name          string
		actual, limit Quantity
	}{{"input tokens", e.InputTokens, b.MaxInputTokens}, {"output tokens", e.OutputTokens, b.MaxOutputTokens}, {"cost", e.CostMicrounits, b.MaxCostMicrounits}}
	for _, c := range checks {
		if !c.limit.Known {
			continue
		}
		if !c.actual.Known {
			return deny(BudgetUnknown, c.name+" estimate is unknown")
		}
		if c.name == "cost" && e.Currency != b.Currency {
			return deny(BudgetUnknown, "cost estimate and budget currencies differ")
		}
		if c.actual.Value > c.limit.Value {
			return deny(BudgetExceeded, c.name+" estimate exceeds configured bound")
		}
	}
	return nil
}
