package port

import (
	"errors"
	"strings"
	"testing"
)

func request() ObserveRequest {
	return ObserveRequest{Binding: BrowserBinding{Lease: BrowserLease{Identity: RequestIdentity{ProfileID: "fixture-profile", OwnerID: "fixture-owner", SessionID: "fixture-session", TaskID: "fixture-task", TurnID: "fixture-turn", OperationID: "fixture-operation", TurnGeneration: 7}, BackendGeneration: "fixture-backend", SlotOrdinal: 1, SlotGeneration: 2}, ViewID: "fixture-view", ViewGeneration: 3, DocumentGeneration: 4, ConversationID: "fixture-conversation"}, AfterSequence: 8, DeadlineMillis: 1000}
}
func response(count int, text string) *ObserveResponse {
	req := request()
	res := &ObserveResponse{}
	for n := 0; n < count; n++ {
		res.Events = append(res.Events, BrowserObservation{Binding: req.Binding, Sequence: req.AfterSequence + uint64(n) + 1, ObservedAtMillis: 900, Kind: AnswerDelta, Text: text})
	}
	return res
}
func TestObservationPageBounds(t *testing.T) {
	req := request()
	if err := ValidateObserveResponse(req, response(MaxObserveEvents, "")); err != nil {
		t.Fatal(err)
	}
	if err := ValidateObserveResponse(req, response(4, strings.Repeat("a", MaxObserveTextBytes))); err != nil {
		t.Fatal(err)
	}
	for _, res := range []*ObserveResponse{nil, response(MaxObserveEvents+1, ""), response(1, strings.Repeat("a", MaxObserveTextBytes+1)), response(5, strings.Repeat("a", MaxObserveTextBytes)), response(1, string([]byte{255}))} {
		if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveInvalid) {
			t.Fatal(err)
		}
	}
	// A rune count below the bound can still exceed the UTF-8 byte bound.
	if err := ValidateObserveResponse(req, response(1, strings.Repeat("🙂", MaxObserveTextBytes/4+1))); !errors.Is(err, ObserveInvalid) {
		t.Fatal(err)
	}
	req.Limit = 1
	if err := ValidateObserveResponse(req, response(2, "x")); !errors.Is(err, ObserveInvalid) {
		t.Fatal(err)
	}
	req.Limit = MaxObserveEvents + 1
	if err := ValidateObserveResponse(req, response(1, "x")); !errors.Is(err, ObserveInvalid) {
		t.Fatal(err)
	}
	req = request()
	res := response(4, strings.Repeat("a", MaxObserveTextBytes))
	res.Events[0].Code = "CLASSIFIED"
	if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveInvalid) {
		t.Fatal("codes omitted from page bytes", err)
	}
}
func TestObservationCorrelationAndGap(t *testing.T) {
	req := request()
	res := response(1, "synthetic")
	res.Events[0].Binding.DocumentGeneration++
	if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveCorrelation) {
		t.Fatal(err)
	}
	res = response(1, "synthetic")
	res.Events[0].Sequence++
	if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveSequence) {
		t.Fatal(err)
	}
	res = response(1, "synthetic")
	res.Events[0].Kind = "arbitrary"
	if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveInvalid) {
		t.Fatal(err)
	}
	res = response(1, "synthetic")
	res.Gap = true
	if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveGap) {
		t.Fatal(err)
	}
	req.AfterSequence = ^uint64(0)
	res = response(1, "synthetic")
	res.Events[0].Sequence = 0
	if err := ValidateObserveResponse(req, res); !errors.Is(err, ObserveSequence) {
		t.Fatal("sequence wrapped", err)
	}
}
