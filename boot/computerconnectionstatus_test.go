package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

// Uses the existing Root/endpoint fixture. Not an actual external MCP witness.
func TestConnectorSocketRegistersBoundReadOnlyVerificationObservation(t *testing.T) {
	s, _, native, endpoint, input := newConnectorFixture(t)
	digest := sha256.Sum256([]byte("visible-challenge"))
	value := hex.EncodeToString(digest[:])
	input.ChallengeSha256 = &value
	opened, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	method, ok := endpoint.methods["computer.connector.verification"]
	if !ok {
		t.Fatal("connector socket must advertise its bound observation method")
	}
	query := wire.ComputerConnectorVerificationQuery{Binding: opened.Endpoint.Binding}
	out, err := verificationInvoke(t, method, query)
	initial := verificationState(t, out, err)
	if initial.Receipt != nil || native.calls != 0 {
		t.Fatal("status performed List or invented proof")
	}
	out, err = verificationInvoke(t, s.verificationMethod(s.current), wire.ComputerConnectorVerify{Challenge: "visible-challenge", WorkspaceId: "work", CallId: "initial-proof"})
	proof := verificationState(t, out, err)
	if proof.Receipt == nil || native.calls != 1 {
		t.Fatal("fixture needs exactly one original verification")
	}
	for i := 0; i < 3; i++ {
		out, err = verificationInvoke(t, method, query)
		observed := verificationState(t, out, err)
		if observed.Receipt == nil || *observed.Receipt != *proof.Receipt || native.calls != 1 {
			t.Fatal("status repeated List or changed retained proof")
		}
	}
	checkID := "fresh-status-check"
	checkedQuery := query
	checkedQuery.CheckId = &checkID
	out, err = verificationInvoke(t, s.verificationObservationMethod(), checkedQuery)
	armed := verificationState(t, out, err)
	if armed.CheckId != nil {
		t.Fatal("desktop pipe fabricated a socket status acknowledgement")
	}
	out, err = verificationInvoke(t, method, query)
	checked := verificationState(t, out, err)
	if checked.CheckId == nil || *checked.CheckId != checkID || *checked.Receipt != *proof.Receipt || native.calls != 1 {
		t.Fatal("socket status failed to acknowledge the fresh read without changing proof")
	}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), query)
	observed := verificationState(t, out, err)
	if observed.CheckId == nil || *observed.CheckId != checkID || native.calls != 1 {
		t.Fatal("desktop did not observe the exact socket read acknowledgement")
	}
	// A concurrent unrelated status read cannot consume/replace the host's
	// acknowledgement. A later host check also fences the previous late reply.
	otherID := "independent-status-check"
	otherQuery := query
	otherQuery.CheckId = &otherID
	out, err = verificationInvoke(t, method, query)
	independent := verificationState(t, out, err)
	if independent.CheckId == nil || *independent.CheckId != checkID {
		t.Fatal("independent status did not retain the active host check")
	}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), query)
	observed = verificationState(t, out, err)
	if observed.CheckId == nil || *observed.CheckId != checkID {
		t.Fatal("independent status replaced the in-progress check acknowledgement")
	}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), otherQuery)
	armed = verificationState(t, out, err)
	if armed.CheckId != nil {
		t.Fatal("new host check inherited the previous acknowledgement")
	}
	out, err = verificationInvoke(t, method, checkedQuery)
	if err == nil && out != nil && out.Status == "ok" {
		t.Fatal("socket selected a host correlation")
	}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), query)
	observed = verificationState(t, out, err)
	if observed.CheckId != nil {
		t.Fatal("late previous reply acknowledged the newer host check")
	}
	out, err = verificationInvoke(t, method, query)
	_ = verificationState(t, out, err)
	out, err = verificationInvoke(t, s.verificationObservationMethod(), query)
	observed = verificationState(t, out, err)
	if observed.CheckId == nil || *observed.CheckId != otherID || native.calls != 1 {
		t.Fatal("current host check did not retain its own acknowledgement")
	}
	// Even a matching public binding cannot transfer an old endpoint's method
	// to another retained slot. This is a synthetic slot-identity regression.
	original := s.current
	other := *original
	s.current = &other
	out, err = verificationInvoke(t, method, query)
	s.current = original
	if err == nil && out != nil && out.Status == "ok" {
		t.Fatal("old socket observed a different retained slot")
	}
	if native.calls != 1 {
		t.Fatal("refused status performed native List")
	}
}

func TestConnectorSocketObservationRechecksCurrentAuthority(t *testing.T) {
	for _, mode := range []string{"revoked", "host-withdrawn", "expired", "startup-unknown", "closing", "crossed-binding", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			s, journal, native, endpoint, input := newConnectorFixture(t)
			opened, err := s.Open(context.Background(), "open", input)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Shutdown() })
			query := wire.ComputerConnectorVerificationQuery{Binding: opened.Endpoint.Binding}
			ctx := context.Background()
			switch mode {
			case "revoked":
				journal.RevokeParticipant(opened.Execution.ParticipantId)
			case "host-withdrawn":
				_, _ = s.root.guard.deactivate()
			case "expired":
				journal.clock.now = journal.clock.now.Add(24 * time.Hour)
			case "startup-unknown":
				s.current.startupUncertain = true
			case "closing":
				s.current.closing = true
			case "crossed-binding":
				query.Binding.RuntimeId = "foreign"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			raw, _ := json.Marshal(query)
			out, err := endpoint.methods["computer.connector.verification"].Handle(ctx, desktop.Request{RequestID: "observe", Body: raw})
			if err == nil && out != nil && out.Status == "ok" {
				t.Fatal("invalid current authority disclosed observation")
			}
			if native.calls != 0 {
				t.Fatal("observation invoked native List")
			}
		})
	}
}
