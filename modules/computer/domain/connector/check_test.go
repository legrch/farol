package connector

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func testDigest(value string) string {
	h := sha256.Sum256([]byte(value))
	return hex.EncodeToString(h[:])
}
func testRequest(n int) Request {
	return Request{OperationID: fmt.Sprintf("00000000-0000-4000-8000-%012d", n), Fingerprint: testDigest("caller"), ProfileID: "profile", OwnerID: "owner", ComputerID: "computer"}
}
func testScope(mode Mode) Scope {
	s := Scope{Mode: mode, ScopeDigest: testDigest("scope"), BuildID: testDigest("build"), BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: "1", ComputerGeneration: "1", TunnelID: "tunnel", AppName: "Farol Dev", WorkspaceID: "workspace", ChallengeDigest: testDigest("challenge"), Model: "temporary-instant", DocumentDigest: testDigest("document")}
	if mode == Status {
		s.CheckID = "49a0cb44-5c67-4aae-9b56-41db024507d3"
		s.AttachmentDigest = testDigest("proof")
	} else {
		s.Challenge = "challenge"
	}
	s.PromptDigest = testDigest(Prompt(s))
	return s
}
func preparedJournal(t *testing.T, mode Mode) (Journal, Entry) {
	t.Helper()
	j, first, err := (Journal{Entries: []Entry{}}).Begin(testRequest(1))
	if err != nil || !first {
		t.Fatal(err)
	}
	e, _ := j.Find(testRequest(1).OperationID)
	s := testScope(mode)
	e.Scope = &s
	e.Phase = Prepared
	j, err = j.Advance(e.Request.OperationID, e)
	if err != nil {
		t.Fatal(err)
	}
	return j, e
}
func TestOriginalIdentityAndChangedInputNeverBecomeFresh(t *testing.T) {
	j, e := preparedJournal(t, Status)
	again, first, err := j.Begin(e.Request)
	if err != nil || first || len(again.Entries) != 1 {
		t.Fatal("duplicate was not original observation", err)
	}
	changed := e.Request
	changed.Fingerprint = testDigest("changed caller")
	if _, _, err := j.Begin(changed); !errors.Is(err, ErrRefused) {
		t.Fatal("changed input accepted", err)
	}
	if _, _, err := j.Begin(testRequest(2)); !errors.Is(err, ErrPending) {
		t.Fatal("second UUID overwrote pending", err)
	}
	copy, _ := j.Find(e.Request.OperationID)
	copy.Scope.AppName = "different"
	if original, _ := j.Find(e.Request.OperationID); original.Scope.AppName != "Farol Dev" {
		t.Fatal("observation mutated stored scope")
	}
}
func TestOriginalDispatchPhasesAreMonotonicAndUnknownCannotReplay(t *testing.T) {
	for _, mode := range []Mode{Bootstrap, Status} {
		t.Run(string(mode), func(t *testing.T) {
			j, e := preparedJournal(t, mode)
			e.Phase = DispatchIntent
			var err error
			j, err = j.Advance(e.Request.OperationID, e)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = j.Advance(e.Request.OperationID, e); err == nil {
				t.Fatal("duplicate intent admitted")
			}
			e.Phase = RefusedBeforeSend
			if _, err = j.Advance(e.Request.OperationID, e); err == nil {
				t.Fatal("post-intent no-Send invented")
			}
			e.Phase = OutcomeUnknown
			j, err = j.Advance(e.Request.OperationID, e)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(j)
			var reopened Journal
			if json.Unmarshal(raw, &reopened) != nil || !reopened.Valid() {
				t.Fatal("portable history invalid")
			}
			for _, phase := range []Phase{Prepared, DispatchIntent, SendAcknowledged, RefusedBeforeSend, Verified} {
				next := e
				next.Phase = phase
				if phase == Verified {
					next.Receipt = &Receipt{Kind: string(mode), CheckID: e.Scope.CheckID, Digest: testDigest("late proof")}
				}
				if _, err := reopened.Advance(e.Request.OperationID, next); err == nil {
					t.Fatalf("UNKNOWN replayed as %s", phase)
				}
			}
			if _, _, err = reopened.Begin(testRequest(2)); !errors.Is(err, ErrPending) {
				t.Fatal("reopen lost unresolved custody", err)
			}
		})
	}
}
func TestCorrelatedReceiptCanConfirmLostSendAckButCannotChangeScope(t *testing.T) {
	j, e := preparedJournal(t, Status)
	e.Phase = DispatchIntent
	j, _ = j.Advance(e.Request.OperationID, e)
	confirmed := e
	confirmed.Phase = Verified
	confirmed.Receipt = &Receipt{Kind: "status", CheckID: e.Scope.CheckID, Digest: testDigest("original native proof")}
	wrong := confirmed
	wrong.Receipt = &Receipt{Kind: "status", CheckID: testRequest(4).OperationID, Digest: testDigest("other")}
	if _, err := j.Advance(e.Request.OperationID, wrong); err == nil {
		t.Fatal("wrong checkId accepted")
	}
	wrong = confirmed
	scope := *e.Scope
	scope.DocumentDigest = testDigest("other page")
	wrong.Scope = &scope
	if _, err := j.Advance(e.Request.OperationID, wrong); err == nil {
		t.Fatal("document changed at confirmation")
	}
	done, err := j.Advance(e.Request.OperationID, confirmed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = done.Advance(e.Request.OperationID, confirmed); err == nil {
		t.Fatal("terminal re-entered")
	}
	if _, first, err := done.Begin(testRequest(2)); err != nil || !first {
		t.Fatal("settled history blocked independent check", err)
	}
}
func TestPromptIsModeExactAndNeverUsesPassiveStatusForFreshCheck(t *testing.T) {
	status := testScope(Status)
	p := Prompt(status)
	if !strings.Contains(p, status.CheckID) || !strings.Contains(p, "computer_connection_status ONCE") || !strings.Contains(p, "Do not use {}") || strings.Contains(p, "farol_connector_verify") {
		t.Fatal(p)
	}
	boot := testScope(Bootstrap)
	if p = Prompt(boot); !strings.Contains(p, "farol_connector_verify ONCE") || !strings.Contains(p, "\"challenge\"") || !strings.Contains(p, "\"workspace\"") {
		t.Fatal(p)
	}
	boot.WorkspaceID = ""
	if p = Prompt(boot); !strings.Contains(p, "farol_connector_verify_catalogue ONCE") || !strings.Contains(p, "No workspace is configured") {
		t.Fatal(p)
	}
	for _, change := range []func(*Scope){func(s *Scope) { s.Challenge = "wrong" }, func(s *Scope) { s.CheckID = testRequest(3).OperationID }, func(s *Scope) { s.DocumentDigest = "invalid" }} {
		x := testScope(Bootstrap)
		change(&x)
		if ValidScope(x) {
			t.Fatal("invalid bootstrap scope accepted", x)
		}
	}
}
func TestBoundedCapacityNeverEvictsKnownOrUnknownIdentity(t *testing.T) {
	j := Journal{Entries: []Entry{}}
	for n := 1; n <= MaxEntries; n++ {
		var err error
		j, _, err = j.Begin(testRequest(n))
		if err != nil {
			t.Fatal(err)
		}
		e, _ := j.Find(testRequest(n).OperationID)
		e.Phase = RefusedBeforeSend
		j, err = j.Advance(e.Request.OperationID, e)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := j.Begin(testRequest(MaxEntries + 1)); !errors.Is(err, ErrCapacity) {
		t.Fatal("capacity evicted history", err)
	}
	if _, first, err := j.Begin(testRequest(1)); err != nil || first {
		t.Fatal("old UUID was recycled", err)
	}
}
