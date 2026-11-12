package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	check "github.com/legrch/farol/modules/computer/domain/connector"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

// Actual durable Go attempt owner and connector slot, with disposable storage
// and scripted endpoint/native ports. The Setup/public MCP seam is exercised
// separately in connection-check-main.test.ts; this is not provider evidence.
func TestExistingAttachmentCheckUsesDurableOwnerAndExactStatusID(t *testing.T) {
	previousBuildID := BuildID
	BuildID = strings.Repeat("b", 64)
	defer func() { BuildID = previousBuildID }()
	s, journal, native, opened := verificationOpen(t)
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	out, err := verificationInvoke(t, s.verificationMethod(s.current), wire.ComputerConnectorVerify{
		Challenge: "visible-challenge", WorkspaceId: "work", CallId: "existing-attachment",
	})
	_ = verificationState(t, out, err)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "farol-state", "go-core", "computer")
	if err = os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	store, err := accessrepo.Create(root, accessrepo.Binding{ProfileID: "profile", OwnerID: "owner", ComputerID: "computer"}, journal.clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	owner := connectorsvc.NewConnectionCheckOwner(store, s, connectorsvc.ConnectionCheckScope{ProfileID: "profile", OwnerID: "owner", ComputerID: "computer"})
	id := "0311add3-b03c-4f89-b916-aea6a0a39242"
	if _, first, err := owner.Claim(ctx, id, strings.Repeat("a", 64)); err != nil || !first {
		t.Fatal("claim", first, err)
	}
	current, err := s.CurrentConnectionCheck(ctx)
	if err != nil || !current.ProofCurrent {
		t.Fatal("existing proof", err)
	}
	prepared, prompt, err := owner.Prepare(ctx, id, connectorsvc.ConnectionCheckSelection{
		Mode: check.Status, AppName: "Farol", Model: "temporary-instant", TunnelID: "tunnel",
		WorkspaceID: "work", ChallengeDigest: current.ChallengeDigest,
		ComputerGeneration: current.ComputerGeneration, DocumentDigest: strings.Repeat("d", 64),
	})
	if err != nil || prepared.Scope == nil || prepared.Scope.CheckID == "" ||
		!strings.Contains(prompt, `checkId "`+prepared.Scope.CheckID+`"`) {
		t.Fatal("original Go prompt/nonce", err)
	}
	if owner.ReceiptAvailable(ctx, id) || s.current.expectedStatusCheckID != "" {
		t.Fatal("saved attachment or preparation counted as fresh evidence")
	}
	if _, err = owner.Arm(ctx, id); err != nil {
		t.Fatal("durable dispatch arm", err)
	}
	query := wire.ComputerConnectorVerificationQuery{Binding: opened.Endpoint.Binding, CheckId: &prepared.Scope.CheckID}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), query)
	if host := verificationState(t, out, err); host.CheckId != nil || owner.ReceiptAvailable(ctx, id) {
		t.Fatal("host observation acknowledged a provider call")
	}
	wrong := "49a0cb44-5c67-4aae-9b56-41db024507d3"
	for _, supplied := range []*string{nil, &wrong} {
		passive := query
		passive.CheckId = supplied
		out, err = verificationInvoke(t, s.verificationObservationMethodFor(s.current), passive)
		if state := verificationState(t, out, err); state.CheckId != nil || owner.ReceiptAvailable(ctx, id) {
			t.Fatal("missing/wrong provider ID accepted")
		}
		if _, err = owner.Confirm(ctx, id); err == nil {
			t.Fatal("uncorrelated receipt confirmed")
		}
	}
	out, err = verificationInvoke(t, s.verificationObservationMethodFor(s.current), query)
	if state := verificationState(t, out, err); state.CheckId == nil || *state.CheckId != prepared.Scope.CheckID || !owner.ReceiptAvailable(ctx, id) {
		t.Fatal("exact provider ID was not observed")
	}
	confirmed, err := owner.Confirm(ctx, id)
	if err != nil || confirmed.Phase != check.Verified || confirmed.Receipt == nil || confirmed.Receipt.CheckID != prepared.Scope.CheckID {
		t.Fatal("original receipt not confirmed", err)
	}
	if native.calls != 1 {
		t.Fatal("status repeated native verification", native.calls)
	}
	if _, err = owner.Arm(ctx, id); err == nil {
		t.Fatal("verified operation authorized another Send")
	}
}

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
	// Model the original Go owner arming a fresh status check on this slot.
	checkID := "fresh-status-check"
	s.current.expectedStatusCheckID = checkID
	checkedQuery := query
	checkedQuery.CheckId = &checkID
	out, err = verificationInvoke(t, s.verificationObservationMethod(), checkedQuery)
	armed := verificationState(t, out, err)
	if armed.CheckId != nil {
		t.Fatal("desktop observation fabricated a socket acknowledgement")
	}
	out, err = verificationInvoke(t, method, query)
	passive := verificationState(t, out, err)
	if passive.CheckId != nil {
		t.Fatal("uncorrelated socket read acknowledged the check")
	}
	out, err = verificationInvoke(t, method, checkedQuery)
	checked := verificationState(t, out, err)
	if checked.CheckId == nil || *checked.CheckId != checkID || *checked.Receipt != *proof.Receipt || native.calls != 1 {
		t.Fatal("matching socket check failed or changed retained proof")
	}
	out, err = verificationInvoke(t, s.verificationObservationMethod(), checkedQuery)
	observed := verificationState(t, out, err)
	if observed.CheckId == nil || *observed.CheckId != checkID {
		t.Fatal("desktop failed to observe matching acknowledgement")
	}
	otherID := "independent-status-check"
	otherQuery := query
	otherQuery.CheckId = &otherID
	out, err = verificationInvoke(t, method, otherQuery)
	independent := verificationState(t, out, err)
	if independent.CheckId != nil {
		t.Fatal("unarmed nonce was acknowledged")
	}
	// Simulate retirement of the old original and a fresh original slot owner.
	s.current.expectedStatusCheckID = otherID
	s.current.statusCheckID = ""
	out, err = verificationInvoke(t, method, checkedQuery)
	late := verificationState(t, out, err)
	if late.CheckId != nil {
		t.Fatal("late prior nonce acknowledged the newer check")
	}
	out, err = verificationInvoke(t, method, otherQuery)
	_ = verificationState(t, out, err)
	out, err = verificationInvoke(t, s.verificationObservationMethod(), otherQuery)
	observed = verificationState(t, out, err)
	if observed.CheckId == nil || *observed.CheckId != otherID || native.calls != 1 {
		t.Fatal("current original acknowledgement missing")
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
