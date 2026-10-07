package interruptedretirement

import (
	"crypto/sha256"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/emptyrecovery"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

type canonicalValidator struct{}

func (canonicalValidator) Validate(r port.HandoffRecord) error { return handoff.ValidateRecord(r) }

// Metadata fixtures only. These prove no profile/process closure, native claim,
// original runtime ACK, archive effect or fresh live-owner retirement.
func fixture() (port.InterruptedRetirementSelection, port.InterruptedRetirementObservation) {
	parent := port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}
	chat := port.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}
	b := port.HandoffBinding{ProfileID: "profile", BackendGeneration: "d46bfba7", BuildID: "original-build", HostLifetimeID: "original-host", ChildLaunchID: "original-child", ParentRoot: parent, ChatRoot: chat}
	scope := port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
	w := port.RetirementWrite{Scope: scope, Root: chat, Revision: 1, Turns: []port.RetirementTurn{}}
	d := sha256.Sum256([]byte("canonical empty retired lifecycle fixture"))
	p := port.HandoffPublication{Binding: b, HandoffID: "original-handoff", ReceiptDigest: d}
	r := port.HandoffRecord{Version: 1, Stage: port.HandoffAcknowledged, Origin: port.HandoffLiveOwner, Publication: p, Receipt: port.RetirementReceipt{Write: w, PublicationDigest: d}, ACK: &port.HandoffACK{Publication: p}}
	if err := handoff.ValidateRecord(r); err != nil {
		panic(err)
	}
	raw, err := json.Marshal(r)
	if err != nil {
		panic(err)
	}
	h := sha256.Sum256(raw)
	s := port.InterruptedRetirementSelection{EmptyRecoverySelection: port.EmptyRecoverySelection{OperationID: "835a913b-bc20-42c6-bf56-9b83852cde3c", Current: b, HeadDigest: h, LifecycleDigest: d, Next: port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: "fresh"}, BuildID: "fresh-build", HostLifetimeID: "fresh-host", ChildLaunchID: "fresh-child"}, OriginalHandoffID: p.HandoffID, ExpectedACKDigest: h}
	o := port.InterruptedRetirementObservation{EmptyRecoveryObservation: port.EmptyRecoveryObservation{Head: port.HandoffHead{Record: &r, Digest: h, EmptyRetirementChain: true}, Scope: scope, Root: chat, LifecycleDigest: d, Incarnations: []string{"7e8cad", b.BackendGeneration}, RetirementPresent: true, ResultsRoot: chat, ResultsStorageRoot: port.JournalRoot{Device: 1, Inode: 4, OwnerUID: 501}}, Retirement: &w}
	return s, o
}

func TestSelectPreservesExactInterruptedRetirementWithoutCleanProof(t *testing.T) {
	s, o := fixture()
	before := handoff.Copy(*o.Head.Record)
	p, err := Select(s, o, canonicalValidator{})
	if err != nil || p == nil || p.Selection != s.EmptyRecoverySelection || p.ArchiveName != "chat-retired-"+s.OperationID {
		t.Fatal(p, err)
	}
	if _, ok := any(p).(port.CleanRetirement); ok {
		t.Fatal("preservation plan became CleanRetirement")
	}
	if !reflect.DeepEqual(before, *o.Head.Record) || o.Head.Record.Terminal != nil || o.Head.Record.Consumption != nil {
		t.Fatal("old unknown head changed")
	}
	if p, err := emptyrecovery.Select(s.EmptyRecoverySelection, o.EmptyRecoveryObservation, canonicalValidator{}); p != nil || err != emptyrecovery.Refused {
		t.Fatal("interrupted ACK broadened prior empty recovery", p, err)
	}
	// Same-build fresh owners are allowed; freshness concerns host, child and
	// backend identities rather than requiring a software update.
	s.BuildID = s.Current.BuildID
	if p, err := Select(s, o, canonicalValidator{}); p == nil || err != nil {
		t.Fatal("fresh owner unnecessarily requires another build", p, err)
	}
}

func TestSelectRefusesStaleCrossedNonemptyOrInventedClosure(t *testing.T) {
	checks := map[string]func(*port.InterruptedRetirementSelection, *port.InterruptedRetirementObservation){
		"operation traversal": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.OperationID = "../chat"
		},
		"operation uppercase": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.OperationID = "835A913b-bc20-42c6-bf56-9b83852cde3c"
		},
		"missing handoff ID": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.OriginalHandoffID = ""
		},
		"wrong handoff ID": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.OriginalHandoffID = "other"
		},
		"zero head": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.HeadDigest = [32]byte{}
		},
		"zero ACK": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.ExpectedACKDigest = [32]byte{}
		},
		"ACK mismatch": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.ExpectedACKDigest[0]++
		},
		"stale head": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Digest[0]++
		},
		"nil head": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record = nil
		},
		"nonempty prefix": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.EmptyRetirementChain = false
		},
		"captured stage": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Stage = port.HandoffCaptured
			o.Head.Record.ACK = nil
		},
		"terminal stage": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Stage = port.HandoffTerminated
		},
		"consumed stage": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Stage = port.HandoffConsumed
		},
		"invented terminal": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Terminal = &port.HandoffTerminal{}
		},
		"invented consumption": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Consumption = &port.HandoffConsumption{}
		},
		"not live origin": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Origin = ""
		},
		"missing ACK": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.ACK = nil
		},
		"ACK publication": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.ACK.Publication.HandoffID = "other"
		},
		"prior is not current": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.BackendGeneration = "7e8cad"
		},
		"binding build": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.BuildID = "other"
		},
		"binding host": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.HostLifetimeID = "other"
		},
		"binding child": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ChildLaunchID = "other"
		},
		"binding parent": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ParentRoot.Inode++
		},
		"binding chat": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ChatRoot.Inode++
		},
		"roots aliased": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ParentRoot = s.Current.ChatRoot
		},
		"roots device": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ParentRoot.Device++
		},
		"roots owner": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ParentRoot.OwnerUID++
		},
		"zero root": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ChatRoot.Inode = 0
		},
		"invalid ID": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Current.ProfileID = "bad profile"
		},
		"invalid UTF8": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.BuildID = string([]byte{0xff})
		},
		"scope generation": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Scope.BackendGeneration = "7e8cad"
		},
		"scope profile": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Scope.ProfileID = "other"
		},
		"journal root": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) { o.Root.Inode++ },
		"selected lifecycle": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.LifecycleDigest[0]++
		},
		"zero lifecycle": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.LifecycleDigest = [32]byte{}
		},
		"observed lifecycle": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.LifecycleDigest[0]++
		},
		"receipt digest equality": func(s *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			s.LifecycleDigest[0]++
			o.LifecycleDigest = s.LifecycleDigest
		},
		"receipt publication": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Receipt.PublicationDigest[0]++
		},
		"receipt scope": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Receipt.Write.Scope.BackendGeneration = "7e8cad"
		},
		"receipt root": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Head.Record.Receipt.Write.Root.Inode++
		},
		"writes": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.WriteCount = 1
		},
		"negative writes": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.WriteCount = -1
		},
		"turns": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.TurnCount = 1
		},
		"retirement flag": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.RetirementPresent = false
		},
		"nil retirement": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement = nil
		},
		"retirement scope": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement.Scope.BackendGeneration = "7e8cad"
		},
		"retirement root": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement.Root.Inode++
		},
		"previous revision": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement.PreviousRevision = 1
		},
		"revision": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement.Revision = 2
		},
		"nil turns": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement.Turns = nil
		},
		"nonempty retirement": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Retirement.Turns = []port.RetirementTurn{{}}
		},
		"results": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultCount = 1
		},
		"negative results": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultCount = -1
		},
		"results parent": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultsRoot.Inode++
		},
		"results alias": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultsStorageRoot = o.Root
		},
		"results zero identity": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultsStorageRoot.Inode = 0
		},
		"results device": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultsStorageRoot.Device++
		},
		"results owner": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.ResultsStorageRoot.OwnerUID++
		},
		"reuse current": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Next.BackendGeneration = "d46bfba7"
		},
		"reuse prior": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Next.BackendGeneration = "7e8cad"
		},
		"next profile": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.Next.ProfileID = "other"
		},
		"missing next build": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) { s.BuildID = "" },
		"reuse host": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.HostLifetimeID = s.Current.HostLifetimeID
		},
		"reuse child": func(s *port.InterruptedRetirementSelection, _ *port.InterruptedRetirementObservation) {
			s.ChildLaunchID = s.Current.ChildLaunchID
		},
		"missing incarnations": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Incarnations = nil
		},
		"repeated incarnation": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Incarnations = []string{"d46bfba7", "d46bfba7"}
		},
		"invalid incarnation": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Incarnations[0] = "bad generation"
		},
		"wrong final incarnation": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Incarnations = []string{"d46bfba7", "7e8cad"}
		},
		"over budget": func(_ *port.InterruptedRetirementSelection, o *port.InterruptedRetirementObservation) {
			o.Incarnations = make([]string, 4097)
		},
	}
	for name, change := range checks {
		t.Run(name, func(t *testing.T) {
			s, o := fixture()
			change(&s, &o)
			before, _ := json.Marshal(o)
			if p, err := Select(s, o, canonicalValidator{}); p != nil || err != Refused {
				t.Fatal("unsafe selection", p, err)
			}
			after, _ := json.Marshal(o)
			if string(before) != string(after) {
				t.Fatal("refusal mutated observation")
			}
		})
	}
}

func TestSelectRefusesOriginalHandoffAsMaintenanceOperation(t *testing.T) {
	s, o := fixture()
	s.OriginalHandoffID = s.OperationID
	o.Head.Record.Publication.HandoffID = s.OriginalHandoffID
	o.Head.Record.ACK.Publication = o.Head.Record.Publication
	raw, err := json.Marshal(o.Head.Record)
	if err != nil {
		t.Fatal(err)
	}
	s.HeadDigest = sha256.Sum256(raw)
	s.ExpectedACKDigest, o.Head.Digest = s.HeadDigest, s.HeadDigest
	if p, err := Select(s, o, canonicalValidator{}); p != nil || err != Refused {
		t.Fatal("original unresolved handoff ID reused", p, err)
	}
}

type validatorFunc func(port.HandoffRecord) error

func (f validatorFunc) Validate(r port.HandoffRecord) error { return f(r) }

func TestSelectRequiresCanonicalOwnerAndCopiesValidatorInput(t *testing.T) {
	s, o := fixture()
	for _, validator := range []port.EmptyRecoveryRecordValidator{nil, validatorFunc(func(port.HandoffRecord) error { return handoff.Invalid })} {
		if p, err := Select(s, o, validator); p != nil || err != Refused {
			t.Fatal("missing/rejecting canonical validator accepted", p, err)
		}
	}
	before := handoff.Copy(*o.Head.Record)
	validator := validatorFunc(func(r port.HandoffRecord) error {
		if err := handoff.ValidateRecord(r); err != nil {
			return err
		}
		r.ACK.Publication.HandoffID = "changed"
		r.Receipt.Write.Turns = append(r.Receipt.Write.Turns, port.RetirementTurn{})
		return nil
	})
	if p, err := Select(s, o, validator); p == nil || err != nil || !reflect.DeepEqual(before, *o.Head.Record) {
		t.Fatal("validator input aliases observation", p, err)
	}
}
