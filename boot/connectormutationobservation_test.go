package boot

import (
	"context"
	"strings"
	"testing"
	"time"

	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Real connector/execution/read policy with injected journal, clock and endpoint.
// No filesystem, socket, process, application, provider or write effect is run.
func connectorMutationReaderFixture(t *testing.T) (*computerConnector, *connectorJournalFixture, *connectorMutationObservation, state.Identity) {
	t.Helper()
	s, journal, _, _, in := newConnectorFixture(t)
	journal.approval.Capabilities = append(journal.approval.Capabilities, authority.Read)
	s.root.publication.approval = journal.approval.Clone()
	journal.PutApproval(journal.approval)
	if _, err := s.Open(context.Background(), "open", in); err != nil {
		t.Fatal(err)
	}
	reader, err := s.mutationObservation(context.Background(), s.current)
	if err != nil {
		t.Fatal(err)
	}
	id := state.Identity{Scope: state.ScopeConnector, OperationID: "original", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	return s, journal, reader, id
}

func TestConnectorMutationReadGuardUsesCurrentReadLease(t *testing.T) {
	s, journal, reader, id := connectorMutationReaderFixture(t)
	called := 0
	inspect := func() error { called++; return nil }
	if err := reader.WithMutationObservation(context.Background(), id, "work", "note.md", inspect); err != nil || called != 1 {
		t.Fatal("current read unavailable", err, called)
	}
	journal.clock.now = journal.clock.now.Add(16 * time.Second)
	if err := reader.WithMutationObservation(context.Background(), id, "work", "note.md", inspect); err == nil || called != 1 {
		t.Fatal("expired original read lease renewed", err, called)
	}
	fresh, err := s.mutationObservation(context.Background(), s.current)
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh.WithMutationObservation(context.Background(), id, "work", "note.md", inspect); err != nil || called != 2 || journal.publications != 1 {
		t.Fatal("fresh metadata read changed admission", err, called, journal.publications)
	}
}

func TestConnectorMutationReadGuardRefusesChangedScope(t *testing.T) {
	for _, stage := range []string{"owner", "profile", "computer", "settings-scope", "workspace", "traversal", "withdrawn", "revoked", "excluded", "cancelled"} {
		t.Run(stage, func(t *testing.T) {
			s, journal, reader, id := connectorMutationReaderFixture(t)
			workspace, path := "work", "note.md"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch stage {
			case "owner":
				id.OwnerID = "other"
			case "profile":
				id.ProfileID = "other"
			case "computer":
				id.ComputerID = "other"
			case "settings-scope":
				id.Scope = state.ScopeOwnerSettings
			case "workspace":
				workspace = "other"
			case "traversal":
				path = "../note.md"
			case "withdrawn":
				s.current.guard.close()
			case "revoked":
				journal.RevokeParticipant(s.current.opened.Execution.ParticipantId)
			case "excluded":
				journal.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/disposable/note.md"}}
				journal.PutApproval(journal.approval)
			case "cancelled":
				cancel()
			}
			called := false
			err := reader.WithMutationObservation(ctx, id, workspace, path, func() error { called = true; return nil })
			if err == nil || called {
				t.Fatal("unauthorized metadata disclosed", err, called)
			}
		})
	}
	s, _, _, _, in := newConnectorFixture(t) // list-only ceiling
	if _, err := s.Open(context.Background(), "open", in); err != nil {
		t.Fatal(err)
	}
	if reader, err := s.mutationObservation(context.Background(), s.current); err == nil || reader != nil {
		t.Fatal("list-only connector obtained metadata read", err)
	}
}

type connectorObservationRecordFixture struct {
	record *state.State
	loads  int
	loaded state.Identity
	after  func()
}

func (s *connectorObservationRecordFixture) Load(_ context.Context, id state.Identity) (*state.State, error) {
	s.loads++
	s.loaded = id
	if s.after != nil {
		s.after()
	}
	copy := s.record.Clone()
	return &copy, nil
}

func TestConnectorMutationReadOriginalReceiptAndFinalWithdrawal(t *testing.T) {
	for _, withdraw := range []bool{false, true} {
		s, _, guard, id := connectorMutationReaderFixture(t)
		origin := state.ConnectorOrigin{BuildID: "original-build", BackendGeneration: "original-backend", RuntimeID: "original-runtime", ConnectorGeneration: 9007199254740993,
			SessionID: "original-session", TaskID: "original-task", TaskEpoch: 1, ParticipantID: "original-participant", TurnID: "original-turn", CallID: "original-call", Generation: 1, Operation: state.WriteKind}
		prepared, err := state.NewPrepared(state.Binding{Identity: id, WorkspaceID: "work", RelativePath: "note.md", ComputerGeneration: 1,
			Connector: origin, RequestDigest: strings.Repeat("a", 64)})
		if err != nil {
			t.Fatal(err)
		}
		completed, err := prepared.Complete(state.Receipt{Operation: state.WriteKind, RelativePath: "note.md", Bytes: 3, AfterSHA256: strings.Repeat("b", 64)})
		if err != nil {
			t.Fatal(err)
		}
		records := &connectorObservationRecordFixture{record: completed}
		if withdraw {
			records.after = s.current.guard.close
		}
		reader, err := mutationsvc.NewConnectorObserver(mutationsvc.ConnectorOwner{OperationID: id.OperationID, OwnerID: id.OwnerID, ProfileID: id.ProfileID, ComputerID: id.ComputerID}, records, guard)
		if err != nil {
			t.Fatal(err)
		}
		out, err := reader.Observe(context.Background(), mutationsvc.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
		if records.loads != 1 || records.loaded != id {
			t.Fatal("loaded another profile operation", records)
		}
		if withdraw {
			if err == nil || out != nil {
				t.Fatal("late withdrawal disclosed receipt", out, err)
			}
		} else if err != nil || out == nil || out.Origin != origin || out.ComputerGeneration != 1 || out.Phase != "completed" || out.Publication != "durable" {
			t.Fatal("original result changed to current correlation", out, err)
		}
	}
}
