package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/transport/desktop"
)

type verificationFailedNative struct {
	*settingsNativeFixture
	code string
}

func (n verificationFailedNative) Inspect(ctx context.Context, request port.ListRequest) (*port.DirectoryBinding, error) {
	_, _ = n.settingsNativeFixture.Inspect(ctx, request)
	if n.code != "" {
		return nil, authority.Fail(n.code, "native-workspace")
	}
	return nil, errors.New("native result unavailable")
}

func TestComputerConnectorVerificationFailedInspectionIsNeverRepeated(t *testing.T) {
	s, _, native, _ := verificationOpen(t)
	s.current.route.workspace = verificationFailedNative{settingsNativeFixture: native}
	method := s.verificationMethod(s.current)
	for _, call := range []string{"original", "must-not-repeat"} {
		out, err := verificationInvoke(t, method, wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "work", CallId: call})
		if err == nil && out != nil && out.Status == "ok" {
			t.Fatal("failed List became success")
		}
		if native.calls != 1 {
			t.Fatal("failed challenge repeated native List", native.calls)
		}
	}
}

func TestComputerConnectorVerificationPreservesInspectionRefusalWithoutPoisoning(t *testing.T) {
	for _, code := range []string{"WORKSPACE_RACE_DETECTED", "WORKSPACE_HELPER_FAILED"} {
		t.Run(code, func(t *testing.T) {
			s, journal, native, opened := verificationOpen(t)
			before := journal.revision
			s.current.route.workspace = verificationFailedNative{settingsNativeFixture: native, code: code}
			out, err := verificationInvoke(t, s.verificationMethod(s.current), wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "work", CallId: "original"})
			if err != nil || out == nil || out.Status != "refused" || out.Code != code {
				t.Fatalf("lost classified refusal: %+v %v", out, err)
			}
			out, err = verificationInvoke(t, s.verificationObservationMethod(), wire.ComputerConnectorVerificationQuery{Binding: opened.Endpoint.Binding})
			if err != nil || out == nil || out.Status != "unknown" || out.Code != "COMPUTER_CONNECTOR_VERIFICATION_UNCONFIRMED" {
				t.Fatalf("incomplete proof misclassified: %+v %v", out, err)
			}
			if native.calls != 1 || journal.revision != before || s.root.unknown {
				t.Fatal("read failure replayed List, changed journal or poisoned root", native.calls, journal.revision, before, s.root.unknown)
			}
		})
	}
}

func verificationInvoke(t *testing.T, method desktop.Method, body any) (*desktop.Outcome, error) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return method.Handle(context.Background(), desktop.Request{RequestID: "probe", Body: raw})
}
func verificationOpen(t *testing.T) (*computerConnector, *connectorJournalFixture, *settingsNativeFixture, *wire.ComputerConnectorOpened) {
	t.Helper()
	s, journal, native, _, input := newConnectorFixture(t)
	hash := sha256.Sum256([]byte("visible-challenge"))
	value := hex.EncodeToString(hash[:])
	input.ChallengeSha256 = &value
	out, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	return s, journal, native, out
}
func verificationState(t *testing.T, out *desktop.Outcome, err error) wire.ComputerConnectorVerificationState {
	t.Helper()
	if err != nil || out == nil || out.Status != "ok" {
		t.Fatalf("verification failed: %+v %v", out, err)
	}
	if err := wire.Validate("ComputerConnectorVerificationState", out.Data); err != nil {
		t.Fatal(err)
	}
	var state wire.ComputerConnectorVerificationState
	if err := json.Unmarshal(out.Data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}
func TestComputerConnectorVerificationUsesOneInspectionAndCurrentHostObservation(t *testing.T) {
	s, _, native, opened := verificationOpen(t)
	query := wire.ComputerConnectorVerificationQuery{Binding: opened.Endpoint.Binding}
	out, err := verificationInvoke(t, s.verificationObservationMethod(), query)
	before := verificationState(t, out, err)
	if before.Receipt != nil || native.calls != 0 {
		t.Fatal("observation invented verification or called native List")
	}
	input := wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "work", CallId: "original-call"}
	out, err = verificationInvoke(t, s.verificationMethod(s.current), input)
	first := verificationState(t, out, err)
	if first.Receipt == nil || first.ReceiptSha256 == nil || first.Receipt.Binding != opened.Endpoint.Binding || first.Receipt.Execution != opened.Execution || first.Receipt.EntryCount != 0 || native.calls != 1 {
		t.Fatalf("missing exact Go proof: %+v", first)
	}
	raw, _ := json.Marshal(first.Receipt)
	hash := sha256.Sum256(raw)
	if *first.ReceiptSha256 != hex.EncodeToString(hash[:]) {
		t.Fatal("receipt digest mismatch")
	}
	input.CallId = "later-observation"
	out, err = verificationInvoke(t, s.verificationMethod(s.current), input)
	second := verificationState(t, out, err)
	if *second.Receipt != *first.Receipt || native.calls != 1 {
		t.Fatal("repeated verification replayed List or changed original call")
	}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), query)
	third := verificationState(t, out, err)
	if *third.Receipt != *first.Receipt || native.calls != 1 {
		t.Fatal("host observation changed proof")
	}
}
func TestComputerConnectorVerificationRejectsWrongOrLateState(t *testing.T) {
	for _, mode := range []string{"challenge", "workspace", "late-host", "late-participant", "expired", "query-binding", "withdrawn"} {
		t.Run(mode, func(t *testing.T) {
			s, journal, native, opened := verificationOpen(t)
			input := wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "work", CallId: "call"}
			if mode == "challenge" {
				input.Challenge = "wrong"
			}
			if mode == "workspace" {
				input.WorkspaceId = "foreign"
			}
			if mode == "late-host" {
				native.after = func() { _, _ = s.root.guard.deactivate() }
			}
			if mode == "late-participant" {
				native.after = func() { journal.RevokeParticipant(opened.Execution.ParticipantId) }
			}
			if mode == "expired" {
				native.after = func() { journal.clock.now = journal.clock.now.Add(2 * time.Hour) }
			}
			method := s.verificationMethod(s.current)
			var body any = input
			if mode == "query-binding" {
				binding := opened.Endpoint.Binding
				binding.BackendGeneration = "other"
				method = s.verificationObservationMethod()
				body = wire.ComputerConnectorVerificationQuery{Binding: binding}
			}
			if mode == "withdrawn" {
				if _, err := s.Close(context.Background(), "close", wire.ComputerConnectorClose{Binding: opened.Endpoint.Binding}); err != nil {
					t.Fatal(err)
				}
			}
			out, err := verificationInvoke(t, method, body)
			if err == nil && out != nil && out.Status == "ok" {
				t.Fatal("invalid proof disclosed")
			}
			if (mode == "challenge" || mode == "workspace" || mode == "query-binding" || mode == "withdrawn") && native.calls != 0 {
				t.Fatal("refused verification reached native IO")
			}
		})
	}
}

// The verifier must not inherit List's child-inventory consistency requirement.
// Native Inspect owns physical no-follow/root checks; this double proves routing.
type verificationNoListingNative struct{ *settingsNativeFixture }

func (verificationNoListingNative) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	return nil, authority.Fail("WORKSPACE_RACE_DETECTED", "native-workspace")
}

func TestComputerConnectorVerificationDoesNotEnumerateChangingChildren(t *testing.T) {
	s, _, native, _ := verificationOpen(t)
	s.current.route.workspace = verificationNoListingNative{native}
	out, err := verificationInvoke(t, s.verificationMethod(s.current), wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "work", CallId: "one-check"})
	state := verificationState(t, out, err)
	if state.Receipt == nil || state.Receipt.EntryCount != 0 || state.Receipt.Truncated || native.calls != 1 {
		t.Fatalf("directory-only verification lost exact proof: %+v", state)
	}
}
