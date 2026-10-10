package modelselection

import (
	"math"
	"strings"
	"testing"
)

// A reproduction of the old arithmetic-only API's missing applicability fence.
// Synthetic time/input values, not a provider measurement or admission witness.
func TestCurrentBudgetRejectsStaleOrForeignInput(t *testing.T) {
	estimate := Estimate{Source: "fixture-estimator", Version: "v1", InputTokens: Quantity{Known: true, Value: 1}}
	budget := Budget{MaxInputTokens: Quantity{Known: true, Value: 1}}
	s := fixture()
	resolved, err := Resolve(s, s.Scope, 150, Request{Slug: "text"})
	if err != nil {
		t.Fatal(err)
	}
	digestA, digestB := strings.Repeat("a", 64), strings.Repeat("b", 64)
	captured, err := CaptureEstimate(resolved, digestA, EstimateObservation{Qualified: true, ObservedAtMillis: 100, ExpiresAtMillis: 200}, estimate)
	if err != nil {
		t.Fatal(err)
	}
	for _, reuse := range []struct {
		name, originalInput, currentInput string
		observed, expires, now            uint64
	}{
		{"stale", digestA, digestA, 100, 200, 200},
		{"foreign input", digestA, digestB, 100, 200, 150},
	} {
		t.Run(reuse.name, func(t *testing.T) {
			current := EstimateContext{Selection: resolved, InputDigest: reuse.currentInput, Source: estimate.Source, Version: estimate.Version, NowMillis: reuse.now}
			if err := CheckCurrentBudget(captured, current, budget); err == nil {
				t.Fatalf("unqualified budget accepted: original input=%s current input=%s validity=[%d,%d) now=%d", reuse.originalInput, reuse.currentInput, reuse.observed, reuse.expires, reuse.now)
			}
		})
	}
}

func estimateFixture(t *testing.T) (CapturedEstimate, EstimateContext) {
	t.Helper()
	s := fixture()
	r, err := Resolve(s, s.Scope, 150, Request{Slug: "text", Effort: "careful"})
	if err != nil {
		t.Fatal(err)
	}
	e := Estimate{Source: "fixture-estimator", Version: "v1", Currency: "USD", InputTokens: Quantity{true, 10}, OutputTokens: Quantity{true, 0}, CostMicrounits: Quantity{true, 0}}
	digest := strings.Repeat("a", 64)
	c, err := CaptureEstimate(r, digest, EstimateObservation{true, 100, 200}, e)
	if err != nil {
		t.Fatal(err)
	}
	return c, EstimateContext{Selection: r, InputDigest: digest, Source: e.Source, Version: e.Version, NowMillis: 150}
}

func TestEstimateStatesAndValidityBoundaries(t *testing.T) {
	c, current := estimateFixture(t)
	budget := Budget{MaxInputTokens: Quantity{true, 10}}
	for _, v := range []struct {
		now   uint64
		state EstimateState
	}{{0, EstimateStale}, {99, EstimateStale}, {100, EstimateKnown}, {199, EstimateKnown}, {200, EstimateStale}, {math.MaxUint64, EstimateStale}} {
		current.NowMillis = v.now
		if got := AssessEstimate(c, current); got != v.state {
			t.Fatalf("now %d state %s, want %s", v.now, got, v.state)
		}
		err := CheckCurrentBudget(c, current, budget)
		if v.state == EstimateKnown && err != nil {
			t.Fatal(err)
		}
		if v.state == EstimateStale {
			requireCode(t, err, BudgetUnknown)
			requireCode(t, CheckCurrentBudget(c, current, Budget{}), BudgetUnknown)
		}
	}
	current.NowMillis = 150
	s := c.Snapshot()
	s.Estimate.OutputTokens = Quantity{}
	unknown, err := CaptureEstimate(current.Selection, current.InputDigest, s.Observation, s.Estimate)
	if err != nil {
		t.Fatal(err)
	}
	if AssessEstimate(unknown, current) != EstimateUnknown {
		t.Fatal("missing quantity became known zero")
	}
	if err := CheckCurrentBudget(unknown, current, budget); err != nil {
		t.Fatal("unconfigured unknown output prevented known input check")
	}
	requireCode(t, CheckCurrentBudget(unknown, current, Budget{MaxOutputTokens: Quantity{true, 0}}), BudgetUnknown)
	unqualified, err := CaptureEstimate(current.Selection, current.InputDigest, EstimateObservation{}, s.Estimate)
	if err != nil {
		t.Fatal(err)
	}
	if AssessEstimate(unqualified, current) != EstimateUnqualified {
		t.Fatal("unqualified observation became current")
	}
	requireCode(t, CheckCurrentBudget(unqualified, current, Budget{}), BudgetUnknown)
	if AssessEstimate(CapturedEstimate{}, current) != EstimateUnqualified {
		t.Fatal("zero capture became current")
	}
}

func TestEstimateCannotCrossSelectionOrEstimatorProvenance(t *testing.T) {
	c, current := estimateFixture(t)
	for _, v := range []struct {
		name   string
		change func(*Snapshot, *Request)
	}{
		{"account", func(s *Snapshot, r *Request) { s.Scope.AccountID = "other-account" }},
		{"provider/backend", func(s *Snapshot, r *Request) { s.Scope.Route = Route{"codex", CodexTask, Plan}; s.Source = AppServer }},
		{"billing", func(s *Snapshot, r *Request) { s.Scope.Route = Route{"codex", CodexTask, API}; s.Source = AppServer }},
		{"model", func(s *Snapshot, r *Request) { r.Slug = "vision"; r.Effort = "adaptive" }},
		{"effort", func(s *Snapshot, r *Request) { r.Effort = "balanced" }},
		{"catalogue epoch", func(s *Snapshot, r *Request) { s.Epoch++ }},
		{"catalogue revision", func(s *Snapshot, r *Request) { s.Revision = "r2" }},
		{"capability revision", func(s *Snapshot, r *Request) { s.Entries[0].Capabilities.Revision = "product-v2" }},
	} {
		t.Run(v.name, func(t *testing.T) {
			s := fixture()
			r := Request{Slug: "text", Effort: "careful"}
			v.change(&s, &r)
			next, err := Resolve(s, s.Scope, 150, r)
			if err != nil {
				t.Fatal(err)
			}
			ctx := current
			ctx.Selection = next
			if AssessEstimate(c, ctx) != EstimateMismatched {
				t.Fatal("changed selection reused old estimate")
			}
			requireCode(t, CheckCurrentBudget(c, ctx, Budget{}), BudgetUnknown)
			if c.Snapshot().Selection != current.Selection.Pin() {
				t.Fatal("new selection retargeted old capture")
			}
		})
	}
	for _, change := range []func(*EstimateContext){func(x *EstimateContext) { x.InputDigest = strings.Repeat("b", 64) }, func(x *EstimateContext) { x.Source = "another-estimator" }, func(x *EstimateContext) { x.Version = "v2" }} {
		ctx := current
		change(&ctx)
		if AssessEstimate(c, ctx) != EstimateMismatched {
			t.Fatal("foreign input/source/version accepted")
		}
		requireCode(t, CheckCurrentBudget(c, ctx, Budget{}), BudgetUnknown)
	}
}

func TestCaptureRefusesUnqualifiedDigestAndMalformedInterval(t *testing.T) {
	c, current := estimateFixture(t)
	snap := c.Snapshot()
	for _, digest := range []string{"", strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		_, err := CaptureEstimate(current.Selection, digest, snap.Observation, snap.Estimate)
		requireCode(t, err, Invalid)
	}
	for _, obs := range []EstimateObservation{{true, 0, 100}, {true, 100, 100}, {true, 200, 100}, {false, 100, 200}, {false, 0, 200}} {
		_, err := CaptureEstimate(current.Selection, current.InputDigest, obs, snap.Estimate)
		requireCode(t, err, Invalid)
	}
	_, err := CaptureEstimate(Resolved{}, current.InputDigest, snap.Observation, snap.Estimate)
	requireCode(t, err, Invalid)
	snap.Estimate.InputTokens = Quantity{false, 1}
	_, err = CaptureEstimate(current.Selection, current.InputDigest, snap.Observation, snap.Estimate)
	requireCode(t, err, Invalid)
}

func TestCapturedEstimateIsDetachedFromSnapshotMutation(t *testing.T) {
	c, current := estimateFixture(t)
	original := c.Snapshot()
	copy := original
	copy.InputDigest = strings.Repeat("b", 64)
	copy.Selection.AccountID = "other-account"
	copy.Estimate.Source = "changed"
	copy.Estimate.InputTokens.Value = 100
	copy.Observation.ExpiresAtMillis = 1
	if c.Snapshot() != original || AssessEstimate(c, current) != EstimateKnown {
		t.Fatal("returned values changed captured estimate")
	}
	if err := CheckCurrentBudget(c, current, Budget{MaxInputTokens: Quantity{true, 10}}); err != nil {
		t.Fatal(err)
	}
}

func TestQualifiedBudgetUsesUnsignedBoundsWithoutOverflowOrZeroFallback(t *testing.T) {
	c, current := estimateFixture(t)
	snap := c.Snapshot()
	snap.Estimate.InputTokens = Quantity{true, math.MaxUint64}
	snap.Observation = EstimateObservation{true, math.MaxUint64 - 1, math.MaxUint64}
	c, err := CaptureEstimate(current.Selection, current.InputDigest, snap.Observation, snap.Estimate)
	if err != nil {
		t.Fatal(err)
	}
	current.NowMillis = math.MaxUint64 - 1
	if err := CheckCurrentBudget(c, current, Budget{MaxInputTokens: Quantity{true, math.MaxUint64}}); err != nil {
		t.Fatal(err)
	}
	requireCode(t, CheckCurrentBudget(c, current, Budget{MaxInputTokens: Quantity{true, math.MaxUint64 - 1}}), BudgetExceeded)
	current.NowMillis = math.MaxUint64
	requireCode(t, CheckCurrentBudget(c, current, Budget{MaxInputTokens: Quantity{true, math.MaxUint64}}), BudgetUnknown)
	snap.Estimate.InputTokens = Quantity{true, 0}
	snap.Observation = EstimateObservation{true, 100, 200}
	c, err = CaptureEstimate(current.Selection, current.InputDigest, snap.Observation, snap.Estimate)
	if err != nil {
		t.Fatal(err)
	}
	current.NowMillis = 150
	if err := CheckCurrentBudget(c, current, Budget{MaxInputTokens: Quantity{true, 0}}); err != nil {
		t.Fatal("known zero refused zero limit")
	}
	// The arithmetic comparator refuses an over-bound value, rather than adding
	// independent dimensions or performing an overflow-prone price conversion.
	requireCode(t, CheckCurrentBudget(c, current, Budget{MaxCostMicrounits: Quantity{true, 0}, Currency: "EUR"}), BudgetUnknown)
}
