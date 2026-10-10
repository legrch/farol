package modelruntime_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	appmodel "github.com/legrch/farol/modules/chat/app/services/modelselection"
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/modelruntime"
)

type clock struct{ now uint64 }

func (c *clock) NowMillis() uint64 { return c.now }

type fixture struct {
	capture port.ModelSelectionCapture
	source  modelruntime.BrowserSource
	owner   *accountapproval.Service
	grant   *accountapproval.Grant
	clock   *clock
}

func existingOwners(t *testing.T) fixture {
	t.Helper()
	// Same declaration shape as the existing controlled startup profile, passed
	// through the actual Browser app resolver. No native/provider qualification.
	low := "low"
	policy := port.ModelPolicy{DefaultHarness: "browser", Harnesses: map[string]port.ModelHarnessPolicy{
		"browser": {DefaultModel: "chatgpt", Models: map[string]port.ConfiguredModel{
			"chatgpt": {Model: "controlled-model", DefaultEffort: &low},
		}},
	}}
	profiles := []port.BrowserModelProfile{{ID: "controlled-fixture-v1", Executor: "browser", RuntimeModel: "controlled-model",
		ModelID: "controlled-model", DefaultEffort: "low", Efforts: []port.BrowserModelEffort{{Requested: "low", Resolved: "low"}},
		Required: port.RequiredControls{Model: true, Effort: true}}}
	principal := strings.Repeat("a", 64)
	capture, err := appmodel.Resolve(intent.SHA256{}, policy, port.ModelRequest{Effort: &low}, profiles, principal)
	if err != nil {
		t.Fatal(err)
	}
	c := &clock{now: 100}
	scope := port.AccountScope{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session"}
	owner, err := accountapproval.New(scope, gate.New(), c)
	if err != nil {
		t.Fatal(err)
	}
	observation := port.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: principal, ObservedAtMillis: 90, ExpiresAtMillis: 9000}
	grant, err := owner.Approve(context.Background(), "approval", 0, observation)
	if err != nil {
		t.Fatal(err)
	}
	source := modelruntime.BrowserSource{Observation: observation}
	if err := grant.WithCurrent(context.Background(), scope, "approval", observation, func(a port.AccountApproval) error {
		source.Approval = a
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return fixture{*capture, source, owner, grant, c}
}

func prepare(t *testing.T, f fixture) modelruntime.BrowserCapture {
	t.Helper()
	captured, err := modelruntime.CaptureBrowser(f.capture, f.source, f.clock.now)
	if err != nil {
		t.Fatal(err)
	}
	return captured
}

func TestBrowserCaptureConsumesExistingResolverAndOriginalAccountOwner(t *testing.T) {
	f := existingOwners(t)
	captured := prepare(t, f)
	pin := captured.Resolved().Pin()
	if captured.Capture() != f.capture || captured.Source() != f.source ||
		pin.Route != (selection.Route{Provider: "farol", Backend: selection.BrowserChat, Billing: selection.Plan}) ||
		pin.AccountID != f.source.Approval.PrincipalKey || pin.Epoch != f.source.Approval.Revision ||
		pin.Revision != f.capture.Resolution.ConfigSHA256 || pin.Model != f.capture.Selection.ModelID ||
		pin.Effort != "low" || pin.CapabilityRevision != f.capture.Resolution.TranslationID {
		t.Fatal("actual app/account/profile identity was not retained")
	}
	caps := captured.Resolved().Capabilities()
	if caps.Text != selection.Yes || caps.Image != selection.Unknown || caps.Tools != selection.Unknown ||
		caps.Provenance != "farol-browser-text-turn-v1" {
		t.Fatal("software text support fabricated another capability or entitlement")
	}
	if err := modelruntime.RecheckBrowser(captured, f.capture, f.source, 101); err != nil {
		t.Fatal(err)
	}
}

func TestExactBrowserOwnerAndMappingRecheck(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*port.ModelSelectionCapture, *modelruntime.BrowserSource)
	}{
		{"configuration", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Resolution.ConfigSHA256 = strings.Repeat("b", 64)
		}},
		{"profile", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Resolution.TranslationID = "new-profile"
		}},
		{"model", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Selection.ModelID = "new-model"
			c.Resolution.Resolved = c.Selection
		}},
		{"effort", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Selection.Effort = "high"
			c.Resolution.Resolved = c.Selection
		}},
		{"mode", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Selection.Mode = "pro"
			c.Resolution.Resolved = c.Selection
			c.Required.Mode = true
		}},
		{"requested alias", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Resolution.RequestedAlias = "new-alias"
		}},
		{"requested effort", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Resolution.RequestedEffort = "high"
		}},
		{"required controls", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) { c.Required.Effort = false }},
		{"account", func(c *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			c.Selection.AccountID = strings.Repeat("b", 64)
			c.Resolution.Resolved = c.Selection
			s.Approval.PrincipalKey = c.Selection.AccountID
			s.Observation.PrincipalKey = c.Selection.AccountID
		}},
		{"profile owner", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Approval.Scope.ProfileID = "new-profile"
		}},
		{"backend incarnation", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Approval.Scope.BackendGeneration = "new-backend"
		}},
		{"owner", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Approval.Scope.OwnerID = "new-owner"
		}},
		{"session", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Approval.Scope.SessionID = "new-session"
		}},
		{"approval", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Approval.ApprovalID = "new-approval"
		}},
		{"epoch", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) { s.Approval.Revision++ }},
		{"renewed observation", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Observation.ObservedAtMillis++
			s.Observation.ExpiresAtMillis++
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := existingOwners(t)
			original := prepare(t, f)
			before := original
			current, source := f.capture, f.source
			tc.edit(&current, &source)
			if err := modelruntime.RecheckBrowser(original, current, source, 101); err != modelruntime.Changed {
				t.Fatalf("changed owner/mapping accepted: %v", err)
			}
			if original != before {
				t.Fatal("recheck retargeted the original value")
			}
		})
	}
}

func TestNoSourceDefaultsOrAuthorityFabrication(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*port.ModelSelectionCapture, *modelruntime.BrowserSource)
	}{
		{"empty mapping", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) { *c = port.ModelSelectionCapture{} }},
		{"legacy no resolution", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Resolution = port.ModelResolution{}
		}},
		{"unknown account", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) { s.Observation.State = "unknown" }},
		{"opaque nonprincipal", func(c *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			c.Selection.AccountID = "opaque-account"
			c.Resolution.Resolved = c.Selection
			s.Approval.PrincipalKey = c.Selection.AccountID
			s.Observation.PrincipalKey = c.Selection.AccountID
		}},
		{"foreign approval", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Approval.PrincipalKey = strings.Repeat("b", 64)
		}},
		{"foreign observation", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Observation.PrincipalKey = strings.Repeat("b", 64)
		}},
		{"no epoch", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) { s.Approval.Revision = 0 }},
		{"no original owner", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) { s.Approval.Scope.OwnerID = "" }},
		{"wrong observation source", func(_ *port.ModelSelectionCapture, s *modelruntime.BrowserSource) {
			s.Observation.Source = "model/list"
		}},
		{"direct route", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Selection.Provider = "openai"
			c.Resolution.Resolved = c.Selection
		}},
		{"tools", func(c *port.ModelSelectionCapture, _ *modelruntime.BrowserSource) {
			c.Selection.ToolsEnabled = true
			c.Selection.ConnectorID = "connector"
			c.Selection.ConnectorGrantID = "grant"
			c.Resolution.Resolved = c.Selection
			c.Required.Connector = true
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := existingOwners(t)
			tc.edit(&f.capture, &f.source)
			if _, err := modelruntime.CaptureBrowser(f.capture, f.source, 100); err != modelruntime.Invalid {
				t.Fatalf("invalid source accepted: %v", err)
			}
		})
	}
	if err := modelruntime.RecheckBrowser(modelruntime.BrowserCapture{}, port.ModelSelectionCapture{}, modelruntime.BrowserSource{}, 100); err != modelruntime.Invalid {
		t.Fatal("empty original accepted")
	}
}

func TestOriginalObservationCannotRefreshCapturedModelLifetime(t *testing.T) {
	f := existingOwners(t)
	captured := prepare(t, f)
	for _, now := range []uint64{0, 89, 5091, 9000, 1 << 53} {
		if err := modelruntime.RecheckBrowser(captured, f.capture, f.source, now); err != accountapproval.Stale {
			t.Fatalf("invalid/stale time %d accepted: %v", now, err)
		}
	}
	if err := modelruntime.RecheckBrowser(captured, f.capture, f.source, 5090); err != nil {
		t.Fatal("inclusive maximum observation age incorrectly rejected")
	}
}

func TestModelsCaptureNeverReplacesPrivateAccountGrant(t *testing.T) {
	f := existingOwners(t)
	captured := prepare(t, f)
	if _, err := f.owner.Revoke(context.Background(), f.source.Approval.Revision); err != nil {
		t.Fatal(err)
	}
	// The detached correlation has no IO and cannot observe withdrawal itself.
	// Actual admission still uses the same original private account owner.
	if err := modelruntime.RecheckBrowser(captured, f.capture, f.source, 100); err != nil {
		t.Fatal(err)
	}
	called := false
	err := f.grant.WithCurrent(context.Background(), f.source.Approval.Scope, f.source.Approval.ApprovalID, f.source.Observation,
		func(port.AccountApproval) error { called = true; return nil })
	if err != accountapproval.Stale || called {
		t.Fatal("detached models pin replaced original revoked account authority")
	}
}

func TestBrowserModelPinKeepsActualEstimateProvenanceAndUnknownDimensions(t *testing.T) {
	f := existingOwners(t)
	captured := prepare(t, f)
	digest := strings.Repeat("c", 64)
	estimate := selection.Estimate{Source: "controlled-estimator", Version: "v1", InputTokens: selection.Quantity{Known: true, Value: 3}}
	e, err := selection.CaptureEstimate(captured.Resolved(), digest, selection.EstimateObservation{Qualified: true, ObservedAtMillis: 100, ExpiresAtMillis: 200}, estimate)
	if err != nil {
		t.Fatal(err)
	}
	ctx := selection.EstimateContext{Selection: captured.Resolved(), InputDigest: digest, Source: estimate.Source, Version: estimate.Version, NowMillis: 101}
	if err := selection.CheckCurrentBudget(e, ctx, selection.Budget{MaxInputTokens: selection.Quantity{Known: true, Value: 3}}); err != nil {
		t.Fatal(err)
	}
	if e.Snapshot().Selection != captured.Resolved().Pin() || e.Snapshot().Estimate.OutputTokens.Known || e.Snapshot().Estimate.CostMicrounits.Known {
		t.Fatal("estimate lost selection or invented missing dimensions")
	}
	for _, edit := range []func(*selection.EstimateContext){
		func(c *selection.EstimateContext) { c.InputDigest = strings.Repeat("d", 64) },
		func(c *selection.EstimateContext) { c.Source = "different-estimator" },
		func(c *selection.EstimateContext) { c.Version = "v2" },
		func(c *selection.EstimateContext) { c.NowMillis = 200 },
	} {
		current := ctx
		edit(&current)
		if selection.CheckCurrentBudget(e, current, selection.Budget{}) == nil {
			t.Fatal("foreign/stale estimate accepted without an explicit numeric limit")
		}
	}
	if selection.CheckCurrentBudget(e, ctx, selection.Budget{MaxOutputTokens: selection.Quantity{Known: true, Value: 0}}) == nil {
		t.Fatal("unknown output estimate manufactured zero")
	}
}

func TestDetachedCopiesAndParallelRechecksDoNotRetargetCapture(t *testing.T) {
	f := existingOwners(t)
	captured := prepare(t, f)
	copyCapture, copySource := captured.Capture(), captured.Source()
	copyCapture.Selection.ModelID = "caller-change"
	copySource.Approval.Revision++
	if captured.Capture() != f.capture || captured.Source() != f.source {
		t.Fatal("getters share mutable account or mapping state")
	}
	var wg sync.WaitGroup
	for range 32 {
		wg.Go(func() {
			if err := modelruntime.RecheckBrowser(captured, f.capture, f.source, 101); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
}
