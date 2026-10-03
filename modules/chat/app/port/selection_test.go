package port

import (
	"strings"
	"testing"
)

func TestControlFactsAreFieldScopedAndRequiredUnknownFailsClosed(t *testing.T) {
	selected := Selection{Provider: "farol", Alias: "chatgpt", AccountID: "configured-account", ModelID: "canonical-model", Effort: "configured-default", Mode: "standard"}
	required := RequiredControls{Model: true, Mode: true}
	known := func(v, l string) ControlFact { return ControlFact{Value: v, Literal: l, Source: FactPublicControl} }
	facts := SelectionFacts{Model: known("canonical-model", "Literal Model"), Mode: known("standard", "Standard"), ObservedAtMillis: 10}
	if !facts.Matches(selected, required) {
		t.Fatal("declared control set rejected")
	}
	projected := facts.Projection()
	if projected.Effort.Source != FactUnknown || projected.Effort.Value != "" {
		t.Fatal("default became observed")
	}
	cases := map[string]func(*SelectionFacts, *RequiredControls){
		"required-model":  func(f *SelectionFacts, r *RequiredControls) { f.Model = ControlFact{} },
		"required-effort": func(f *SelectionFacts, r *RequiredControls) { r.Effort = true },
		"required-mode":   func(f *SelectionFacts, r *RequiredControls) { f.Mode = ControlFact{} },
		"weaken-model":    func(f *SelectionFacts, r *RequiredControls) { r.Model = false },
		"weaken-mode":     func(f *SelectionFacts, r *RequiredControls) { r.Mode = false },
		"configured-echo": func(f *SelectionFacts, r *RequiredControls) { f.Model.Source = "configured" },
		"unknown-value": func(f *SelectionFacts, r *RequiredControls) {
			f.Effort = ControlFact{Source: FactUnknown, Value: "configured-default"}
		},
		"literal-missing":         func(f *SelectionFacts, r *RequiredControls) { f.Model.Literal = "" },
		"literal-control":         func(f *SelectionFacts, r *RequiredControls) { f.Model.Literal = "private\ntext" },
		"literal-bound":           func(f *SelectionFacts, r *RequiredControls) { f.Model.Literal = strings.Repeat("x", 257) },
		"canonical-mismatch":      func(f *SelectionFacts, r *RequiredControls) { f.Model.Value = "other" },
		"optional-known-mismatch": func(f *SelectionFacts, r *RequiredControls) { f.Effort = known("other", "High") },
		"missing-capture":         func(f *SelectionFacts, r *RequiredControls) { f.ObservedAtMillis = 0 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f, r := facts, required
			change(&f, &r)
			if f.Matches(selected, r) {
				t.Fatal("unproven/mismatched controls accepted")
			}
		})
	}
}
func TestHomeAcceptedCIDIsSeparateFromImmutablePhysicalEcho(t *testing.T) {
	binding := BrowserBinding{ProviderState: ProviderHome, ConversationID: ""}
	request := ObserveRequest{Binding: binding, Limit: 1}
	event := BrowserObservation{Binding: binding, Kind: Accepted, Sequence: 1, UserTurnID: "user", ProviderConversationID: "real-cid"}
	if err := ValidateObserveResponse(request, &ObserveResponse{Events: []BrowserObservation{event}}); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*BrowserObservation){func(e *BrowserObservation) { e.ProviderConversationID = "" }, func(e *BrowserObservation) { e.ProviderConversationID = "invalid id" }, func(e *BrowserObservation) { e.Binding.ConversationID = "real-cid" }, func(e *BrowserObservation) { e.Kind = AnswerDelta }} {
		copy := event
		change(&copy)
		if err := ValidateObserveResponse(request, &ObserveResponse{Events: []BrowserObservation{copy}}); err == nil {
			t.Fatal("invalid CID adoption accepted")
		}
	}
}

func TestUnspecifiedOptionalModeCanRemainIndependentlyObserved(t *testing.T) {
	selection := Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "configured"}
	facts := SelectionFacts{Model: ControlFact{Value: "model", Literal: "Actual Model", Source: FactPublicControl}, Mode: ControlFact{Value: "standard", Literal: "Standard", Source: FactPublicControl}, ObservedAtMillis: 1}
	if !facts.Matches(selection, RequiredControls{Model: true}) || selection.Mode != "" {
		t.Fatal("unrequested actual mode was hidden or policy rewritten")
	}
	facts.Mode.Value = "invented"
	if facts.Matches(selection, RequiredControls{Model: true}) {
		t.Fatal("open mode admitted")
	}
}
