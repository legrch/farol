package catalogue_test

import (
	"strings"
	"testing"

	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/catalogue"
)

// The existing real Browser app resolves a detached selection, then the owned
// M5 boundary correlates advisory estimates. No Send or provider effect occurs.
func TestQualifiedEstimateConsumesExistingBrowserApplicationSelection(t *testing.T) {
	c := &catalogue.Cache{}
	scopeA := scope(selection.BrowserChat)
	c.Activate(scopeA)
	ticket := c.Begin()
	if err := c.Complete(ticket, browserSnapshot(ticket), nil); err != nil {
		t.Fatal(err)
	}
	prepared, err := browserPrepare(c, scopeA, 11)
	if err != nil {
		t.Fatal(err)
	}
	e := selection.Estimate{Source: "fixture-estimator", Version: "v1", InputTokens: selection.Quantity{Known: true, Value: 1}}
	digest := strings.Repeat("a", 64)
	captured, err := selection.CaptureEstimate(prepared.Resolved, digest, selection.EstimateObservation{Qualified: true, ObservedAtMillis: 10, ExpiresAtMillis: 20}, e)
	if err != nil {
		t.Fatal(err)
	}
	ctx := selection.EstimateContext{Selection: prepared.Resolved, InputDigest: digest, Source: e.Source, Version: e.Version, NowMillis: 11}
	budget := selection.Budget{MaxInputTokens: selection.Quantity{Known: true, Value: 1}}
	if err := selection.CheckCurrentBudget(captured, ctx, budget); err != nil {
		t.Fatal(err)
	}
	pin := captured.Snapshot().Selection
	if pin.AccountID != prepared.Capture.Selection.AccountID || pin.Model != prepared.Capture.Selection.ModelID || pin.Effort != prepared.Capture.Selection.Effort || pin.Route != scopeA.Route || pin.Epoch != ticket.Epoch() {
		t.Fatal("estimate did not retain exact app account/model/effort/catalogue binding")
	}
	ctx.InputDigest = strings.Repeat("b", 64)
	if selection.CheckCurrentBudget(captured, ctx, budget) == nil {
		t.Fatal("foreign input accepted")
	}
	ctx.InputDigest = digest
	ctx.NowMillis = 20
	if selection.CheckCurrentBudget(captured, ctx, budget) == nil {
		t.Fatal("expired estimate accepted")
	}
	other := scopeA
	other.AccountID = "fixture-account-B"
	c.Activate(other)
	next := c.Begin()
	if err := c.Complete(next, browserSnapshot(next), nil); err != nil {
		t.Fatal(err)
	}
	newSelection, err := browserPrepare(c, other, 11)
	if err != nil {
		t.Fatal(err)
	}
	ctx.NowMillis = 11
	ctx.Selection = newSelection.Resolved
	if selection.AssessEstimate(captured, ctx) != selection.EstimateMismatched || selection.CheckCurrentBudget(captured, ctx, budget) == nil {
		t.Fatal("new app account reused original estimate")
	}
	if captured.Snapshot().Selection != pin {
		t.Fatal("new app selection retargeted captured provenance")
	}
}
