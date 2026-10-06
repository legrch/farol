package boot

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Actual root/connector/execution/application policy with controlled journal,
// physical roots and child values. Separate fixture roots represent known owner
// lifetimes; no real process, disk, clean boot or public endpoint is qualified.
type storedProcessDouble struct {
	*connectorProcessJournalDouble
	s     *computerConnector
	value *processsvc.TerminalResult
	loads int
	after func()
	err   error
}

func (r *storedProcessDouble) LoadProcessTerminal(_ context.Context, id domain.Identity) (*processsvc.TerminalResult, error) {
	if !r.s.mutations.mu.TryLock() {
		return nil, errors.New("load under ledger gate")
	}
	r.s.mutations.mu.Unlock()
	if !r.s.current.guard.mu.TryLock() {
		return nil, errors.New("load under current owner gate")
	}
	r.s.current.guard.mu.Unlock()
	r.loads++
	if id != (domain.Identity{Scope: domain.ScopeConnector, OperationID: "process-operation", OwnerID: r.s.root.ownerID,
		ProfileID: r.s.root.peer.ProfileId, ComputerID: r.s.root.computerID}) {
		return nil, errors.New("wrong root-selected identity")
	}
	if r.after != nil {
		r.after()
	}
	if r.value == nil {
		return nil, r.err
	}
	copy := r.value.Clone()
	return &copy, r.err
}

func storedProcessFixture(t *testing.T) (*computerConnector, *storedProcessDouble, *connectorProcessNativeDouble, *connectorProcessObservation, processct.ReadRequest) {
	t.Helper()
	original, _, _, child, _ := connectorProcessFixture(t)
	start := startConnectorProcessFixture(t, original, child)
	child.terminal = true
	current, err := original.processObservation(context.Background(), original.current)
	if err != nil {
		t.Fatal(err)
	}
	value, err := original.mutations.operations[start.OperationID].process.service.CaptureTerminal(context.Background(), current, child)
	if err != nil {
		t.Fatal(err)
	}
	s, access, journal, physical, input := connectorProcessFixture(t)
	access.clock.now = access.clock.now.Add(16 * time.Second)
	input.RuntimeId, input.ConnectorGeneration = "successor-runtime", "9007199254740994"
	selectConnectorProcessSlot(t, s, access, input, "successor")
	reader := &storedProcessDouble{connectorProcessJournalDouble: journal, s: s, value: value}
	s.mutations.dependencies.repository = reader
	selected, err := s.processObservation(context.Background(), s.current)
	if err != nil {
		t.Fatal(err)
	}
	return s, reader, physical, selected, processct.ReadRequest{Handle: start.Handle}
}

func readStoredFixture(s *computerConnector, current *connectorProcessObservation, physical *connectorProcessNativeDouble, request processct.ReadRequest) (*processct.ReadResponse, error) {
	return s.observeStoredProcess(context.Background(), current, "process-operation", request, func(seal processsvc.Seal) (processsvc.ObservationWorkspace, error) {
		if seal.WorkspaceID != physical.seal.WorkspaceID || seal.Root != physical.seal.Root || seal.Cwd != physical.seal.Cwd {
			return nil, errors.New("selected a replacement workspace")
		}
		return physical, nil
	})
}

func TestConnectorStoredProcessReadsOriginalWithoutChildOrSettlement(t *testing.T) {
	s, store, physical, current, request := storedProcessFixture(t)
	original := store.value.Clone()
	out, err := readStoredFixture(s, current, physical, request)
	if err != nil || out == nil || out.State != processct.Terminal || out.StdoutBase64 != "c2F2ZWQ=" || out.StderrBase64 != "ZXJy" || out.ExitCode == nil || *out.ExitCode != 7 {
		t.Fatal("retained value not disclosed", err)
	}
	if store.loads != 1 || physical.reads != 0 || physical.spawns != 0 || store.reserves != 0 || len(s.mutations.operations) != 0 || store.value.Scope != original.Scope || store.value.Intent != original.Intent {
		t.Fatal("cold read reconstructed, renewed or settled work")
	}
	*out.ExitCode = 99
	request.StdoutOffset, request.StderrOffset = out.StdoutNext, out.StderrNext
	out, err = readStoredFixture(s, current, physical, request)
	if err != nil || out == nil || out.StdoutBase64 != "" || out.StderrBase64 != "" || *out.ExitCode != 7 || store.loads != 2 {
		t.Fatal("bounded EOF observation changed retained value", err)
	}
}

func TestConnectorStoredProcessCurrentAndOriginalFencesWin(t *testing.T) {
	for _, fault := range []string{"unknown-before", "withdraw-before", "withdraw-load", "unknown-load", "original-before", "original-load", "original-physical", "wrong-operation", "wrong-profile", "changed-root", "wrong-handle", "missing", "load-error"} {
		t.Run(fault, func(t *testing.T) {
			s, store, physical, current, request := storedProcessFixture(t)
			retainUnknown := func() {
				s.mutations.mu.Lock()
				s.mutations.operations["process-operation"] = &settingsMutationOperation{connectorScope: true, process: &connectorProcessOperation{publishAttempted: true}, failure: connectorProcessUnknown()}
				s.mutations.mu.Unlock()
			}
			switch fault {
			case "unknown-before":
				s.root.unknown = true
			case "withdraw-before":
				s.current.guard.close()
			case "withdraw-load":
				store.after = func() { s.current.guard.close() }
			case "unknown-load":
				store.after = func() { s.root.unknown = true }
			case "original-before":
				retainUnknown()
			case "original-load":
				store.after = retainUnknown
			case "original-physical":
				physical.afterProbe = retainUnknown
			case "wrong-operation":
				store.value.Intent.OperationID = "other"
			case "wrong-profile":
				store.value.Scope.Host.ProfileID = "other"
			case "changed-root":
				physical.seal.RootIdentity.Inode = "changed"
			case "wrong-handle":
				request.Handle = "different"
			case "missing":
				store.value = nil
			case "load-error":
				store.err = errors.New("controlled unreadable result")
			}
			out, err := readStoredFixture(s, current, physical, request)
			if out != nil || err == nil || store.loads > 1 || physical.reads != 0 || physical.spawns != 0 || store.reserves != 0 {
				t.Fatal("cold result crossed owner boundary", err)
			}
			if (fault == "unknown-before" || fault == "withdraw-before" || fault == "original-before") && store.loads != 0 {
				t.Fatal("preflight refusal entered repository")
			}
			if (fault == "original-before" || fault == "original-load" || fault == "original-physical") && s.mutations.operations["process-operation"].settled {
				t.Fatal("saved bytes settled retained UNKNOWN")
			}
		})
	}
}

func TestConnectorStoredProcessLostPublicationCannotFallBackToChild(t *testing.T) {
	s, _, journal, child, _ := connectorProcessFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, err: errors.New("controlled lost publication ACK")}
	s.mutations.dependencies.repository = publisher
	start := startConnectorProcessFixture(t, s, child)
	child.terminal = true
	if _, err := s.retainProcess(context.Background(), s.current, start.OperationID); err == nil {
		t.Fatal("lost publication accepted")
	}
	reads := child.reads
	if out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil || child.reads != reads || publisher.publishes != 1 {
		t.Fatal("live child cleared publication uncertainty")
	}
}

func TestConnectorProcessLatePublicationFenceWinsDuringObservation(t *testing.T) {
	for _, when := range []string{"child-io", "final-physical", "known-during-child"} {
		t.Run(when, func(t *testing.T) {
			s, _, journal, child, _ := connectorProcessFixture(t)
			publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s,
				digest: strings.Repeat("a", 64), err: errors.New("controlled late lost publication ACK")}
			if when == "known-during-child" {
				publisher.err = nil
			}
			s.mutations.dependencies.repository = publisher
			start := startConnectorProcessFixture(t, s, child)
			child.terminal = true
			publish := func() {
				child.afterRead, child.afterProbe = nil, nil
				_, err := s.retainProcess(context.Background(), s.current, start.OperationID)
				if (when == "known-during-child") != (err == nil) {
					t.Fatal("publication fixture did not reach intended outcome", err)
				}
			}
			if when == "final-physical" {
				child.afterProbe = func() {
					if child.probes == 2 {
						publish()
					}
				}
			} else {
				child.afterRead = publish
			}
			out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle})
			if when == "known-during-child" {
				if err != nil || out == nil || out.State != processct.Terminal {
					t.Fatal("known publication prevented current read", err)
				}
			} else {
				var failure *processct.Failure
				if out != nil || !errors.As(err, &failure) || failure.Outcome != "outcome_unknown" || s.mutations.operations[start.OperationID].settled {
					t.Fatal("late unknown publication disclosed a live terminal result or lost its classification", err)
				}
			}
			if publisher.publishes != 1 || child.spawns != 1 || journal.reserves != 1 {
				t.Fatal("publication interleaving repeated execution")
			}
		})
	}
}
