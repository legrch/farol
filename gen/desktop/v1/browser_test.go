package desktop

import (
	"encoding/json"
	"os"
	"strings"
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

func TestBrowserAccountObservationSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../api/desktop/v1/fixtures/browser-account-observation.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = Validate("BrowserAccountObservation", raw); err != nil {
		t.Fatal(err)
	}
	var snapshot BrowserAccountObservation
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.State != "observed" || snapshot.Source != "provider-session-v1" || snapshot.PrincipalKey != strings.Repeat("c", 64) || snapshot.ObservedAtMillis != "1000" || snapshot.ExpiresAtMillis != "60000" {
		t.Fatal("snapshot values changed")
	}
	for field, value := range map[string]any{"accountId": "configured-is-not-observed", "principalKey": "user@example.invalid", "source": "configured", "state": "unknown", "accessToken": "private-boundary-canary", "observedAtMillis": 1000, "expiresAtMillis": "01"} {
		t.Run(field, func(t *testing.T) {
			var malformed map[string]any
			if err := json.Unmarshal(raw, &malformed); err != nil {
				t.Fatal(err)
			}
			malformed[field] = value
			encoded, err := json.Marshal(malformed)
			if err != nil {
				t.Fatal(err)
			}
			if Validate("BrowserAccountObservation", encoded) == nil {
				t.Fatal("unqualified snapshot accepted")
			}
		})
	}
}
