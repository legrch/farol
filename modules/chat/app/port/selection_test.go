package port

import (
	"fmt"
	"strings"
	"testing"
)

func TestControlFactLiteralConformance(t *testing.T) {
	// Keep these vectors aligned with go-chat-browser.test.ts. This pins the
	// existing Go domain; it does not qualify any actual provider controls.
	type vector struct {
		name, literal string
		accepted      bool
	}
	vectors := []vector{
		{"empty", "", false},
		{"invalid-UTF8-high-surrogate", string([]byte{0xed, 0xa0, 0x80}), false},
		{"invalid-UTF8-low-surrogate", string([]byte{0xed, 0xb0, 0x80}), false},
		{"padded-exact-text", "\u0085 Model é 😀 \u3000", true},
		{"BOM-is-not-Go-whitespace", "\ufeff", true},
		{"C1-is-not-Go-control", "\u0080\u009f", true},
		{"replacement-character", "\ufffd", true},
		{"decomposed-exact-text", "e\u0301", true},
	}
	for _, size := range []int{255, 256, 257, 512} {
		for _, sample := range []struct {
			name, literal string
		}{
			{"ASCII", strings.Repeat("x", size)},
			{"UTF8-two-byte", strings.Repeat("é", size/2) + strings.Repeat("x", size%2)},
			{"UTF8-four-byte", strings.Repeat("😀", size/4) + strings.Repeat("x", size%4)},
		} {
			if len(sample.literal) != size {
				t.Fatalf("bad byte-length vector: %s-%d", sample.name, size)
			}
			vectors = append(vectors, vector{fmt.Sprintf("%s-%d", sample.name, size), sample.literal, size <= 256})
		}
	}
	for _, c := range " \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000" {
		vectors = append(vectors, vector{fmt.Sprintf("blank-U+%x", c), string(c), false})
	}
	for c := rune(0); c < 32; c++ {
		vectors = append(vectors, vector{fmt.Sprintf("control-%d", c), "A" + string(c) + "B", false})
	}
	vectors = append(vectors, vector{"control-127", "A\u007fB", false})
	for _, sample := range vectors {
		t.Run(sample.name, func(t *testing.T) {
			fact := ControlFact{Value: "model-pro", Literal: sample.literal, Source: FactPublicControl}
			if got := fact.Valid(); got != sample.accepted {
				t.Fatalf("Valid() = %v, want %v", got, sample.accepted)
			}
			if fact.Literal != sample.literal {
				t.Fatal("literal text changed during validation")
			}
		})
	}
}

func TestControlFactCanonicalValueBound(t *testing.T) {
	for _, size := range []int{120, 121, 128} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			fact := ControlFact{Value: strings.Repeat("x", size), Literal: "Model", Source: FactPublicControl}
			if got := fact.Valid(); got != (size <= 120) {
				t.Fatalf("Valid() = %v for %d canonical bytes", got, size)
			}
		})
	}
}

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
