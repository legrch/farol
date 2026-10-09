package boot

import (
	"context"
	"testing"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// These are validated-shape metadata values, not native storage or live origin
// evidence. Real module scanners and held claims are separate native gates.
func terminatedProfilePureFixture(ancestor bool) (terminatedProfileInspectionInput, NativeRoot, handoffrepo.ClosedInspection, lifecyclerepo.ClosedInspection, results.ClosedInspection) {
	profile := ProfileBinding{ProfileID: "profile", Root: "/synthetic/profile", Device: 11, Inode: 12}
	parent := chatport.JournalRoot{Device: 11, Inode: 12, OwnerUID: 20}
	root := chatport.JournalRoot{Device: 11, Inode: 13, OwnerUID: 20}
	b := chatport.HandoffBinding{ProfileID: profile.ProfileID, BackendGeneration: "current", BuildID: BuildID, HostLifetimeID: "host", ChildLaunchID: "child", ParentRoot: parent, ChatRoot: root}
	p := chatport.HandoffPublication{Binding: b, HandoffID: "original", ReceiptDigest: [32]byte{3}}
	in := terminatedProfileInspectionInput{Profile: profile, Publication: p, KnownACKDigest: [32]byte{4}, OwnerID: "owner", ComputerID: "computer", AccessDigest: [32]byte{5}, Mutations: make([]mutationrepo.ExpectedSettledRecord, 2)}
	w := chatport.RetirementWrite{Scope: chatport.JournalScope{ProfileID: profile.ProfileID, BackendGeneration: b.BackendGeneration}, Root: root, Revision: 1, Turns: []chatport.RetirementTurn{}}
	zero := 0
	record := chatport.HandoffRecord{Version: 1, Stage: chatport.HandoffTerminated, Origin: chatport.HandoffLiveOwner, Publication: p,
		Receipt: chatport.RetirementReceipt{Write: w, PublicationDigest: p.ReceiptDigest}, ACK: &chatport.HandoffACK{Publication: p},
		Terminal: &chatport.HandoffTerminal{Publication: p, KnownACKDigest: in.KnownACKDigest, Kind: chatport.HandoffNormalExit, StopMode: chatport.HandoffGracefulStop, ExitCode: &zero}}
	stages := []handoffrepo.ClosedInspectionStage{{Stage: chatport.HandoffCaptured}, {Stage: chatport.HandoffAcknowledged}, {Stage: chatport.HandoffTerminated}}
	incarnations := []string{b.BackendGeneration}
	if ancestor {
		stages = append([]handoffrepo.ClosedInspectionStage{{Stage: chatport.HandoffCaptured}, {Stage: chatport.HandoffAcknowledged}, {Stage: chatport.HandoffTerminated}, {Stage: chatport.HandoffConsumed}}, stages...)
		incarnations = append([]string{"previous"}, incarnations...)
	}
	h := handoffrepo.ClosedInspection{Scope: w.Scope, ParentRoot: parent, ChatRoot: root, Publication: p, HeadStage: record.Stage,
		HeadDigest: [32]byte{6}, Stages: stages, Head: &chatport.HandoffHead{Record: &record, Digest: [32]byte{6}, EmptyRetirementChain: true}}
	l := lifecyclerepo.ClosedInspection{Scope: w.Scope, Root: root, SnapshotDigest: p.ReceiptDigest, Version: 3, Revision: 1, Incarnations: incarnations, Retirement: &w}
	r := results.ClosedInspection{Scope: w.Scope, Root: root, StorageRoot: chatport.JournalRoot{Device: root.Device, Inode: 14, OwnerUID: root.OwnerUID}, ClaimDigest: [32]byte{7}}
	chat := NativeRoot{Path: "/synthetic/profile/chat", ProfileID: profile.ProfileID, Device: root.Device, Inode: root.Inode, OwnerUID: root.OwnerUID, Mode: 0700}
	return in, chat, h, l, r
}

func TestTerminatedProfileInspectionPureJoinsExactOriginalEmptyRetirement(t *testing.T) {
	for _, ancestor := range []bool{false, true} {
		in, chat, h, l, r := terminatedProfilePureFixture(ancestor)
		if !terminatedProfileInputValid(in) || handoff.ValidateRecord(*h.Head.Record) != nil || !terminatedProfileObservationsMatch(in, chat, h, l, r) {
			t.Fatal("exact empty first/successor observation refused")
		}
		if _, ok := any(terminatedProfileInspection{}).(chatport.CleanRetirement); ok {
			t.Fatal("storage observation grants original retirement proof")
		}
	}
}

func TestTerminatedProfileInspectionPureSelectionRefusesBeforeNativeIO(t *testing.T) {
	for _, kind := range []string{"profile", "owner", "computer", "generation", "host", "child", "build", "handoff", "parent", "chat", "uid", "receipt", "ack", "access", "one-mutation", "three-mutations"} {
		t.Run(kind, func(t *testing.T) {
			in, _, _, _, _ := terminatedProfilePureFixture(false)
			switch kind {
			case "profile":
				in.Profile.ProfileID = "other"
			case "owner":
				in.OwnerID = ""
			case "computer":
				in.ComputerID = ""
			case "generation":
				in.Publication.Binding.BackendGeneration = " "
			case "host":
				in.Publication.Binding.HostLifetimeID = ""
			case "child":
				in.Publication.Binding.ChildLaunchID = ""
			case "build":
				in.Publication.Binding.BuildID = BuildID + "-other"
			case "handoff":
				in.Publication.HandoffID = ""
			case "parent":
				in.Publication.Binding.ParentRoot.Inode++
			case "chat":
				in.Publication.Binding.ChatRoot = in.Publication.Binding.ParentRoot
			case "uid":
				in.Publication.Binding.ChatRoot.OwnerUID++
			case "receipt":
				in.Publication.ReceiptDigest = [32]byte{}
			case "ack":
				in.KnownACKDigest = [32]byte{}
			case "access":
				in.AccessDigest = [32]byte{}
			case "one-mutation":
				in.Mutations = in.Mutations[:1]
			case "three-mutations":
				in.Mutations = append(in.Mutations, mutationrepo.ExpectedSettledRecord{})
			}
			calls := 0
			if terminatedProfileInputValid(in) || inspectTerminatedProfile(context.Background(), in, func(terminatedProfileInspection) error { calls++; return nil }) != handoff.Refused || calls != 0 {
				t.Fatal("invalid selection passed pre-native guard")
			}
		})
	}
	in, _, _, _, _ := terminatedProfilePureFixture(false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, c := range []context.Context{nil, ctx} {
		if err := inspectTerminatedProfile(c, in, func(terminatedProfileInspection) error { t.Fatal("cancelled visitor"); return nil }); err != handoff.Refused {
			t.Fatal("cancelled context reached physical qualification", err)
		}
	}
	if err := inspectTerminatedProfile(context.Background(), in, nil); err != handoff.Refused {
		t.Fatal("missing visitor reached physical qualification", err)
	}
}

func TestTerminatedProfileInspectionPureRejectsUnjoinedObservations(t *testing.T) {
	for _, kind := range []string{"scope", "physical-root", "parent", "profile", "publication", "head", "record", "nonempty-prefix", "head-digest", "zero-head", "stage", "consumption", "next", "attempt", "missing-terminal", "wrong-ack", "forced", "nonzero-exit", "signal", "missing-retirement", "retirement-bytes", "lifecycle-sha", "lifecycle-scope", "lifecycle-root", "revision", "missing-history", "extra-history", "wrong-history", "result-scope", "result-root", "result-count", "result-claim", "result-storage", "result-uid"} {
		t.Run(kind, func(t *testing.T) {
			in, chat, h, l, r := terminatedProfilePureFixture(true)
			switch kind {
			case "scope":
				h.Scope.BackendGeneration = "other"
			case "physical-root":
				chat.Inode++
			case "parent":
				h.ParentRoot.Inode++
			case "profile":
				chat.ProfileID = "other"
			case "publication":
				h.Publication.Binding.ChildLaunchID = "other"
			case "head":
				h.Head = nil
			case "record":
				h.Head.Record = nil
			case "nonempty-prefix":
				h.Head.EmptyRetirementChain = false
			case "head-digest":
				h.Head.Digest[0]++
			case "zero-head":
				h.Head.Digest, h.HeadDigest = [32]byte{}, [32]byte{}
			case "stage":
				h.HeadStage = chatport.HandoffConsumed
			case "consumption":
				h.Head.Record.Consumption = &chatport.HandoffConsumption{}
			case "next":
				h.NextBinding = in.Publication.Binding
			case "attempt":
				h.AttemptID = "next"
			case "missing-terminal":
				h.Head.Record.Terminal = nil
			case "wrong-ack":
				h.Head.Record.Terminal.KnownACKDigest[0]++
			case "forced":
				h.Head.Record.Terminal.StopMode = chatport.HandoffForcedStop
			case "nonzero-exit":
				*h.Head.Record.Terminal.ExitCode = 1
			case "signal":
				h.Head.Record.Terminal.Signal = "SIGTERM"
			case "missing-retirement":
				l.Retirement = nil
			case "retirement-bytes":
				w := chatport.CopyRetirement(*l.Retirement)
				w.Root.Inode++
				l.Retirement = &w
			case "lifecycle-sha":
				l.SnapshotDigest[0]++
			case "lifecycle-scope":
				l.Scope.BackendGeneration = "other"
			case "lifecycle-root":
				l.Root.Inode++
			case "revision":
				l.Revision++
			case "missing-history":
				l.Incarnations = nil
			case "extra-history":
				l.Incarnations = append(l.Incarnations, "extra")
			case "wrong-history":
				l.Incarnations[len(l.Incarnations)-1] = "other"
			case "result-scope":
				r.Scope.BackendGeneration = "other"
			case "result-root":
				r.Root.Inode++
			case "result-count":
				r.ResultCount = 1
			case "result-claim":
				r.ClaimDigest = [32]byte{}
			case "result-storage":
				r.StorageRoot = r.Root
			case "result-uid":
				r.StorageRoot.OwnerUID++
			}
			if terminatedProfileObservationsMatch(in, chat, h, l, r) {
				t.Fatal("unjoined/stale observation accepted")
			}
		})
	}
}
