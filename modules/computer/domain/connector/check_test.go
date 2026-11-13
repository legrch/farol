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
	// A new owner click supersedes the unsettled earlier attempt: it is kept
	// as unknown (it was prepared), never re-sent and never verified.
	next, first, err := j.Begin(testRequest(2))
	if err != nil || !first {
		t.Fatal("repeated owner check was blocked", err)
	}
	if prior, _ := next.Find(e.Request.OperationID); prior.Phase != OutcomeUnknown || prior.Scope == nil {
		t.Fatal("superseded attempt was not retained as unknown", prior.Phase)
	}
	if _, err := next.Advance(e.Request.OperationID, e); err == nil {
		t.Fatal("superseded attempt advanced again")
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
			if _, first, err := reopened.Begin(testRequest(2)); err != nil || !first {
				t.Fatal("unknown outcome blocked a new owner check", err)
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
	// A ChatGPT connector caches its tool schema; an older cached schema has
	// no checkId. The prompt therefore never asks the model for an argument.
	if strings.Contains(p, status.CheckID) || strings.Contains(p, "checkId") || !strings.Contains(p, "computer_connection_status ONCE with no arguments") || strings.Contains(p, "farol_connector_verify") {
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
func TestRepeatedChecksForgetOldestHistoryInsteadOfRefusing(t *testing.T) {
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
	if _, first, err := j.Begin(testRequest(2)); err != nil || first {
		t.Fatal("retained UUID became fresh", err)
	}
	more, first, err := j.Begin(testRequest(MaxEntries + 1))
	if err != nil || !first || len(more.Entries) != MaxEntries || !more.Valid() {
		t.Fatal("capacity refused a repeated owner check", err)
	}
	if _, ok := more.Find(testRequest(1).OperationID); ok {
		t.Fatal("oldest settled attempt was not forgotten")
	}
	if _, ok := more.Find(testRequest(2).OperationID); !ok {
		t.Fatal("more than the oldest attempt was forgotten")
	}
}
func TestImportKeepsPredecessorAttemptsAndRefusesADifferentAttempt(t *testing.T) {
	ours, e := preparedJournal(t, Status)
	e.Phase = DispatchIntent
	ours, err := ours.Advance(e.Request.OperationID, e)
	if err != nil {
		t.Fatal(err)
	}
	earlier := e
	earlier.Phase = Prepared
	merged, err := ours.Import(Journal{Entries: []Entry{earlier}})
	if err == nil {
		merged, err = merged.Import(Journal{Entries: []Entry{{Request: testRequest(2), Phase: Claimed}}})
	}
	if err != nil || len(merged.Entries) != 2 {
		t.Fatal("predecessor attempts not imported", err)
	}
	if got, _ := merged.Find(e.Request.OperationID); got.Phase != DispatchIntent {
		t.Fatal("our more advanced record was replaced", got.Phase)
	}
	if got, _ := merged.Find(testRequest(2).OperationID); got.Phase != RefusedBeforeSend {
		t.Fatal("ended predecessor claim was not settled", got.Phase)
	}
	for _, change := range []func(*Entry){
		func(x *Entry) { x.Request.Fingerprint = testDigest("other") },
		func(x *Entry) { s := *x.Scope; s.ScopeDigest = testDigest("other"); x.Scope = &s },
		func(x *Entry) { x.Phase = OutcomeUnknown },
	} {
		other := e
		change(&other)
		if _, err := ours.Import(Journal{Entries: []Entry{other}}); !errors.Is(err, ErrRefused) {
			t.Fatal("a different attempt under a known ID was merged", other.Phase)
		}
	}
}
