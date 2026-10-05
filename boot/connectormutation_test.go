package boot

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// This aggregate joins existing real owners with injected storage, endpoint and
// native effects. It does not launch a backend or qualify a writable MCP route.
func connectorMutationFixture(t *testing.T) (*computerConnector, *connectorJournalFixture, *chatMutationJournal, *chatMutationNative, wire.ComputerConnectorOpen) {
	t.Helper()
	s, access, _, _, in := newConnectorFixture(t)
	access.approval.Capabilities = []authority.Capability{authority.List, authority.Read, authority.Write}
	access.approval.Workspaces[0].Access = authority.WriteAccess
	access.PutApproval(access.approval)
	s.root.publication.approval = access.approval.Clone()
	deps, journal, native := chatMutationDependencies()
	var err error
	s.mutations, err = settingsMutationIngress(s.root, deps)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "open", in); err != nil {
		t.Fatal(err)
	}
	return s, access, journal, native, in
}

func connectorWriteFixture() mutationct.ConnectorRequest {
	return mutationct.ConnectorRequest{WorkspaceID: "work", Operation: mutationct.Write{RelativePath: "note.md", Content: "new"}}
}

func reconnectMutationFixture(t *testing.T, s *computerConnector, in wire.ComputerConnectorOpen) {
	t.Helper()
	if _, err := s.Close(context.Background(), "close", wire.ComputerConnectorClose{Binding: s.current.opened.Endpoint.Binding}); err != nil {
		t.Fatal(err)
	}
	in.RuntimeId = "next-runtime"
	in.ConnectorGeneration = "9007199254740994"
	if _, err := s.Open(context.Background(), "reopen", in); err != nil {
		t.Fatal(err)
	}
}

func TestConnectorMutationRootRetainsOneOriginalAcrossReconnect(t *testing.T) {
	s, access, journal, native, in := connectorMutationFixture(t)
	first, err := s.mutate(context.Background(), s.current, "original", "original-call", connectorWriteFixture())
	if err != nil || first == nil || first.Phase != "completed" || first.Publication != "durable" || first.Origin.ConnectorGeneration != 9007199254740993 || first.Origin.CallID != "original-call" {
		t.Fatal("original mutation failed", first, err)
	}
	if len(s.mutations.operations) != 1 || s.mutations.operations["original"].connector == nil || journal.admits != 1 || journal.saves != 1 || native.calls != 1 {
		t.Fatal("not one shared attempt")
	}
	for i := 0; i < 2; i++ {
		out, err := s.mutate(context.Background(), s.current, "original", "new-call", connectorWriteFixture())
		if err == nil || out != nil || native.calls != 1 || journal.admits != 1 {
			t.Fatal("duplicate root attempt executed", out, err)
		}
	}
	access.clock.now = access.clock.now.Add(16 * time.Second)
	reconnectMutationFixture(t, s, in)
	out, err := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
	if err != nil || out == nil || out.Origin != first.Origin || out.Receipt.AfterSHA256 != first.Receipt.AfterSHA256 || journal.admits != 1 || journal.saves != 1 || journal.loads != 0 || native.calls != 1 {
		t.Fatal("reconnect changed result, reloaded memory or executed", out, err)
	}
	if s.current.opened.Endpoint.Binding.RuntimeId == out.Origin.RuntimeID || s.current.opened.Execution.SessionId == out.Origin.SessionID {
		t.Fatal("fixture did not change current correlation")
	}
	if err := s.mutations.freezeForRetirement(); err != nil {
		t.Fatal("durable known result refused retirement", err)
	}
	if out, err := s.mutate(context.Background(), s.current, "after-freeze", "call", connectorWriteFixture()); err == nil || out != nil || native.calls != 1 {
		t.Fatal("retirement freeze permitted another effect", out, err)
	}
}

func TestConnectorMutationRootPreservesUncertaintyAfterClose(t *testing.T) {
	for _, fault := range []string{"admit-before", "admit-after", "save-before", "save-after", "pending"} {
		t.Run(fault, func(t *testing.T) {
			s, _, journal, native, in := connectorMutationFixture(t)
			switch fault {
			case "admit-before":
				journal.admitFault = "before"
			case "admit-after":
				journal.admitFault = "after"
			case "save-before":
				journal.saveFault = "before"
			case "save-after":
				journal.saveFault = "after"
			case "pending":
				native.after = func() {
					if err := s.mutations.freezeForRetirement(); err == nil {
						t.Fatal("pending connector mutation retired")
					}
				}
			}
			_, _ = s.mutate(context.Background(), s.current, "original", "call", connectorWriteFixture())
			reconnectMutationFixture(t, s, in)
			if len(s.mutations.operations) != 1 {
				t.Fatal("connector close discarded mutation owner")
			}
			out, err := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
			switch fault {
			case "admit-before", "admit-after":
				if err == nil || out != nil || native.calls != 0 {
					t.Fatal("uncertain admission upgraded or repeated", out, err)
				}
			case "save-before", "save-after":
				if err != nil || out == nil || out.Phase != "completed" || out.Publication != "memory_only" || native.calls != 1 {
					t.Fatal("uncertain publication upgraded or repeated", out, err)
				}
			}
			if journal.admits != 1 || journal.loads != 0 || s.mutations.freezeForRetirement() == nil {
				t.Fatal("uncertainty lost after close/observe")
			}
		})
	}
}

func TestConnectorMutationRootLateDisclosureCanObserveWithoutRenewal(t *testing.T) {
	s, access, journal, native, in := connectorMutationFixture(t)
	native.after = func() { access.clock.now = access.clock.now.Add(16 * time.Second) }
	out, err := s.mutate(context.Background(), s.current, "original", "call", connectorWriteFixture())
	if err == nil || out != nil || journal.saves != 1 || native.calls != 1 || s.mutations.operations["original"].settled {
		t.Fatal("late disclosure treated as completed delivery", out, err)
	}
	reconnectMutationFixture(t, s, in)
	out, err = s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
	if err != nil || out == nil || out.Phase != "completed" || out.Publication != "durable" || out.Origin.RuntimeID != in.RuntimeId || journal.admits != 1 || journal.saves != 1 || journal.loads != 0 || native.calls != 1 {
		t.Fatal("retained result unavailable or repeated", out, err)
	}
	if err := s.mutations.freezeForRetirement(); err != nil {
		t.Fatal("known durable settlement not retained", err)
	}
}

func TestConnectorMutationRootSharesSettingsKeyAndRetirement(t *testing.T) {
	s, _, journal, native, in := connectorMutationFixture(t)
	edit := wire.ComputerSettingsEditRequest{Publication: in.Publication, WorkspaceId: "work", RelativePath: "note.md", ExpectedSHA256: strings.Repeat("b", 64), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}}
	if _, err := s.mutations.edit(context.Background(), "settings", edit); err != nil {
		t.Fatal(err)
	}
	if out, err := s.mutate(context.Background(), s.current, "settings", "call", connectorWriteFixture()); err == nil || out != nil || journal.admits != 1 || native.calls != 1 {
		t.Fatal("connector bypassed shared Settings operation key", out, err)
	}
	if _, err := s.mutate(context.Background(), s.current, "connector", "call", connectorWriteFixture()); err != nil {
		t.Fatal(err)
	}
	if out, err := s.mutations.edit(context.Background(), "connector", edit); err == nil || out != nil || journal.admits != 2 || native.calls != 2 {
		t.Fatal("Settings bypassed shared connector operation key", out, err)
	}
	if out, err := s.mutations.observe(context.Background(), settingsRead("connector", edit)); err == nil || out != nil {
		t.Fatal("Settings observed connector as its own operation", out, err)
	}
	if out, err := s.observeMutation(context.Background(), s.current, "settings", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"}); err == nil || out != nil || journal.loads != 0 {
		t.Fatal("connector observed Settings as its own operation", out, err)
	}
	if len(s.mutations.operations) != 2 || len(journal.records) != 2 || s.mutations.freezeForRetirement() != nil {
		t.Fatal("shared ledger did not retain both settled operations")
	}
}

func TestConnectorMutationRootRequiresQualifiedOwnerAndWriteScope(t *testing.T) {
	s, _, journal, native, _ := connectorMutationFixture(t)
	s.current.guard.close()
	if out, err := s.mutate(context.Background(), s.current, "refused", "call", connectorWriteFixture()); err == nil || out != nil || journal.admits != 0 || native.calls != 0 || s.mutations.freezeForRetirement() != nil {
		t.Fatal("known pre-admission refusal had an effect or uncertain retirement", out, err)
	}
	readOnly, _, _, _, in := newConnectorFixture(t)
	deps, records, effects := chatMutationDependencies()
	if _, err := readOnly.Open(context.Background(), "read-only-open", in); err != nil {
		t.Fatal(err)
	}
	// Attaching a backend after admission cannot widen the original ceiling.
	readOnly.mutations, _ = settingsMutationIngress(readOnly.root, deps)
	if out, err := readOnly.mutate(context.Background(), readOnly.current, "write", "call", connectorWriteFixture()); err == nil || out != nil || records.admits != 0 || effects.calls != 0 {
		t.Fatal("read-only ceiling widened", out, err)
	}
	foreign, foreignAccess, _, _, foreignInput := newConnectorFixture(t)
	foreign.mutations = readOnly.mutations
	if out, err := foreign.Open(context.Background(), "foreign-owner", foreignInput); err == nil || out != nil || foreignAccess.publications != 0 {
		t.Fatal("foreign mutation owner published", out, err)
	}
}

func TestConnectorMutationRootConcurrentDuplicateHasOneEffect(t *testing.T) {
	s, _, journal, native, _ := connectorMutationFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	native.after = func() { close(entered); <-release }
	done := make(chan error, 1)
	go func() {
		_, err := s.mutate(context.Background(), s.current, "original", "call", connectorWriteFixture())
		done <- err
	}()
	<-entered
	out, duplicateErr := s.mutate(context.Background(), s.current, "original", "second-call", connectorWriteFixture())
	pending, observeErr := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
	admissions, effects, loads := journal.admits, native.calls, journal.loads
	close(release)
	err := <-done
	if err != nil || duplicateErr == nil || out != nil || observeErr == nil || pending != nil || admissions != 1 || effects != 1 || loads != 0 || journal.saves != 1 {
		t.Fatal("concurrent duplicate or pending observation crossed effect", err, duplicateErr, observeErr, admissions, effects, loads)
	}
}

type connectorColdLoadFixture struct {
	computerport.MutationRepository
	before func()
}

func (s *connectorColdLoadFixture) Load(ctx context.Context, id state.Identity) (*state.State, error) {
	if s.before != nil {
		before := s.before
		s.before = nil
		before()
	}
	return s.MutationRepository.Load(ctx, id)
}

func TestConnectorMutationRootColdReadReconcilesNewRetainedAttempt(t *testing.T) {
	for _, fault := range []string{"save-after", "admit-after", "completed"} {
		t.Run(fault, func(t *testing.T) {
			s, _, journal, native, _ := connectorMutationFixture(t)
			if fault == "save-after" {
				journal.saveFault = "after"
			} else if fault == "admit-after" {
				journal.admitFault = "after"
			}
			wrapped := &connectorColdLoadFixture{MutationRepository: journal}
			s.mutations.dependencies.repository = wrapped
			// The cold observer has already selected an absent root entry. Complete
			// an actual root attempt before Load fetches its now-visible bytes.
			wrapped.before = func() {
				_, _ = s.mutate(context.Background(), s.current, "original", "call", connectorWriteFixture())
			}
			out, err := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
			if fault == "admit-after" {
				if err == nil || out != nil || native.calls != 0 {
					t.Fatal("cold observer lost admission fence", out, err)
				}
			} else {
				publication := "durable"
				if fault == "save-after" {
					publication = "memory_only"
				}
				if err != nil || out == nil || out.Publication != publication || out.Phase != "completed" || native.calls != 1 {
					t.Fatal("cold observer upgraded retained publication", out, err)
				}
			}
			if journal.admits != 1 || journal.loads != 1 || (s.mutations.freezeForRetirement() == nil) != (fault == "completed") {
				t.Fatal("cold observation repeated work or changed retirement certainty")
			}
		})
	}
}

func TestConnectorMutationRootColdReadRefusesNewPendingOrSettingsAttempt(t *testing.T) {
	for _, pending := range []bool{false, true} {
		s, _, journal, native, in := connectorMutationFixture(t)
		wrapped := &connectorColdLoadFixture{MutationRepository: journal}
		s.mutations.dependencies.repository = wrapped
		entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
		wrapped.before = func() {
			if pending {
				native.after = func() { close(entered); <-release }
				go func() {
					_, err := s.mutate(context.Background(), s.current, "original", "call", connectorWriteFixture())
					done <- err
				}()
				<-entered
			} else {
				_, err := s.mutations.edit(context.Background(), "original", wire.ComputerSettingsEditRequest{Publication: in.Publication, WorkspaceId: "work", RelativePath: "note.md", ExpectedSHA256: strings.Repeat("b", 64), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}})
				if err != nil {
					t.Fatal(err)
				}
			}
		}
		out, err := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
		if pending {
			close(release)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		code := "COMPUTER_MUTATION_OPERATION_CONFLICT"
		if pending {
			code = "COMPUTER_MUTATION_IN_PROGRESS"
		}
		var classified *mutationct.Failure
		if out != nil || !errors.As(err, &classified) || classified.Code != code || journal.admits != 1 || journal.loads != 1 || native.calls != 1 {
			t.Fatal("cold observation ignored a new ledger owner", out, err, code)
		}
	}
}
