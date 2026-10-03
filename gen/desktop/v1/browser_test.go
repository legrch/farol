package desktop

import (
	"encoding/json"
	"os"
	"testing"
)

func browserObservationFixture(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("../../../api/desktop/v1/fixtures/browser-observation.json")
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}
func TestBrowserWireLogicalIdentityAndLosslessCounters(t *testing.T) {
	value := browserObservationFixture(t)
	raw, _ := json.Marshal(value)
	if err := Validate("BrowserObserved", raw); err != nil {
		t.Fatal(err)
	}
	var observed BrowserObserved
	if err := json.Unmarshal(raw, &observed); err != nil {
		t.Fatal(err)
	}
	if observed.Events[0].Sequence != "9007199254740993" || observed.Events[0].Binding.Lease.Identity.TurnGeneration != "18446744073709551615" {
		t.Fatal("lossy identity")
	}
	if !RequiresOperationID("chat.browser.reply") || RequiresOperationID("chat.browser.next") {
		t.Fatal("wrong dispatch classification")
	}
}
func TestBrowserWireRejectsBoundaryCorruption(t *testing.T) {
	for _, kind := range []string{"string-flag", "unknown-field", "lossy-counter", "wrong-kind", "wrong-slot", "too-many"} {
		t.Run(kind, func(t *testing.T) {
			value := browserObservationFixture(t)
			events := value["events"].([]any)
			event := events[0].(map[string]any)
			binding := event["binding"].(map[string]any)
			switch kind {
			case "string-flag":
				value["gap"] = "false"
			case "unknown-field":
				binding["authority"] = true
			case "lossy-counter":
				event["sequence"] = 9007199254740993
			case "wrong-kind":
				event["kind"] = "eval"
			case "wrong-slot":
				binding["lease"].(map[string]any)["slotOrdinal"] = 0
			case "too-many":
				out := make([]any, 129)
				for i := range out {
					out[i] = event
				}
				value["events"] = out
			}
			raw, _ := json.Marshal(value)
			if Validate("BrowserObserved", raw) == nil {
				t.Fatal("invalid browser data accepted")
			}
		})
	}
}
