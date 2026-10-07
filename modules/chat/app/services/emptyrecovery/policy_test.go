package emptyrecovery

import (
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

type canonicalValidator struct{}

func (canonicalValidator) Validate(r port.HandoffRecord) error { return handoff.ValidateRecord(r) }

// These are canonical metadata fixtures, never a stopped-child or live origin
// proof. Native preservation and actual fresh retirement need separate tests.
func fixture() (port.EmptyRecoverySelection, port.EmptyRecoveryObservation) {
	parent := port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}
	chat := port.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}
	original := port.HandoffBinding{ProfileID: "profile", BackendGeneration: "original", BuildID: "old-build", HostLifetimeID: "original-host", ChildLaunchID: "original-child", ParentRoot: parent, ChatRoot: chat}
	current := original
	current.BackendGeneration, current.HostLifetimeID, current.ChildLaunchID = "failed-current", "failed-host", "failed-child"
	scope := port.JournalScope{ProfileID: "profile", BackendGeneration: current.BackendGeneration}
	p := port.HandoffPublication{Binding: original, HandoffID: "original-handoff", ReceiptDigest: [32]byte{1}}
	zero := 0
	r := port.HandoffRecord{Version: 1, Stage: port.HandoffConsumed, Origin: port.HandoffLiveOwner, Publication: p,
		Receipt: port.RetirementReceipt{Write: port.RetirementWrite{Scope: port.JournalScope{ProfileID: "profile", BackendGeneration: "original"}, Root: chat, Revision: 1, Turns: []port.RetirementTurn{}}, PublicationDigest: p.ReceiptDigest},
		ACK:     &port.HandoffACK{Publication: p}, Terminal: &port.HandoffTerminal{Publication: p, KnownACKDigest: [32]byte{2}, Kind: port.HandoffNormalExit, StopMode: port.HandoffGracefulStop, ExitCode: &zero},
		Consumption: &port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: scope, NextBinding: current, AttemptID: "previous-consumption"}}
	if err := handoff.ValidateRecord(r); err != nil {
		panic(err)
	}
	s := port.EmptyRecoverySelection{OperationID: "835a913b-bc20-42c6-bf56-9b83852cde3c", Current: current, HeadDigest: [32]byte{3}, LifecycleDigest: [32]byte{4}, Next: port.JournalScope{ProfileID: "profile", BackendGeneration: "maintenance"}, BuildID: "current-build", HostLifetimeID: "maintenance-host", ChildLaunchID: "maintenance-child"}
	o := port.EmptyRecoveryObservation{Head: port.HandoffHead{Record: &r, Digest: s.HeadDigest, EmptyRetirementChain: true}, Scope: scope, Root: chat, LifecycleDigest: s.LifecycleDigest, Incarnations: []string{"original", "failed-current"}, ResultsRoot: chat, ResultsStorageRoot: port.JournalRoot{Device: 1, Inode: 4, OwnerUID: 501}}
	return s, o
}

func TestEmptyRecoverySelectionPreservesExactFailedBindingWithoutRetirement(t *testing.T) {
	s, o := fixture()
	p, err := Select(s, o, canonicalValidator{})
	if err != nil || p == nil || p.Selection != s || p.ArchiveName != "chat-retired-"+s.OperationID {
		t.Fatal(p, err)
	}
	if _, ok := any(p).(port.CleanRetirement); ok {
		t.Fatal("maintenance projection became clean retirement")
	}
	if o.Head.Record.Stage != port.HandoffConsumed || o.RetirementPresent {
		t.Fatal("selection mutated the old journal")
	}
}

func TestEmptyRecoveryRefusesNonemptyStaleUnknownOrReusedIncarnation(t *testing.T) {
	checks := map[string]func(*port.EmptyRecoverySelection, *port.EmptyRecoveryObservation){
		"writes":         func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.WriteCount = 1 },
		"turns":          func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.TurnCount = 1 },
		"negative count": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.ResultCount = -1 },
		"retirement":     func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.RetirementPresent = true },
		"results":        func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.ResultCount = 1 },
		"prefix nonempty": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.Head.EmptyRetirementChain = false
		},
		"missing head": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Head.Record = nil },
		"head digest":  func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Head.Digest = [32]byte{5} },
		"lifecycle digest": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.LifecycleDigest = [32]byte{5}
		},
		"origin":           func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Head.Record.Origin = "" },
		"ACK":              func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Head.Record.ACK = nil },
		"terminal unknown": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Head.Record.Terminal = nil },
		"not consumed": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.Head.Record.Stage = port.HandoffTerminated
			o.Head.Record.Consumption = nil
		},
		"consumption binding": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.Head.Record.Consumption.NextBinding.BuildID = "other-build"
		},
		"current scope": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.Scope.BackendGeneration = "other"
		},
		"Chat root":   func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Root.Inode++ },
		"result root": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.ResultsRoot.Inode++ },
		"result store owner": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.ResultsStorageRoot.OwnerUID++
		},
		"result root alias": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.ResultsStorageRoot = o.Root },
		"prior generation reused": func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) {
			s.Next.BackendGeneration = "original"
		},
		"current generation reused": func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) {
			s.Next.BackendGeneration = s.Current.BackendGeneration
		},
		"host reused": func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) {
			s.HostLifetimeID = s.Current.HostLifetimeID
		},
		"child reused": func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) {
			s.ChildLaunchID = s.Current.ChildLaunchID
		},
		"profile changed":      func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) { s.Next.ProfileID = "other" },
		"archive traversal":    func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) { s.OperationID = "../chat" },
		"missing incarnations": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) { o.Incarnations = nil },
		"repeated incarnation": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.Incarnations = []string{"failed-current", "failed-current"}
		},
		"current incarnation missing": func(_ *port.EmptyRecoverySelection, o *port.EmptyRecoveryObservation) {
			o.Incarnations = []string{"original"}
		},
		"missing digest": func(s *port.EmptyRecoverySelection, _ *port.EmptyRecoveryObservation) { s.HeadDigest = [32]byte{} },
	}
	for name, change := range checks {
		t.Run(name, func(t *testing.T) {
			s, o := fixture()
			change(&s, &o)
			before := handoff.Copy(*fixtureRecord(&o))
			p, err := Select(s, o, canonicalValidator{})
			if err != Refused || p != nil {
				t.Fatal("unsafe selection", p, err)
			}
			if o.Head.Record != nil && !reflect.DeepEqual(*o.Head.Record, before) {
				t.Fatal("refusal changed old head")
			}
		})
	}
}

func TestEmptyRecoveryMissingCanonicalOwnerRefuses(t *testing.T) {
	s, o := fixture()
	if p, err := Select(s, o, nil); err != Refused || p != nil {
		t.Fatal(p, err)
	}
}

func fixtureRecord(o *port.EmptyRecoveryObservation) *port.HandoffRecord {
	if o.Head.Record == nil {
		return &port.HandoffRecord{}
	}
	return o.Head.Record
}
