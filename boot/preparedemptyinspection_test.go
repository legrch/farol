//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// CPU-only selected bytes and metadata. No profile, native claim, preservation,
// original runtime ACK, child facts or recovery effects are established here.
func preparedEmptyPureFixture(t *testing.T) (preparedEmptyInspectionInput, NativeRoot, *chatport.HandoffHead, *lifecyclerepo.Inspection, results.ClosedInspection, map[string]emptyRecoveryFile) {
	t.Helper()
	parent := chatport.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}
	old := chatport.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}
	current := chatport.HandoffBinding{ProfileID: "profile", BackendGeneration: "failed-current", BuildID: "old-build", HostLifetimeID: "failed-host", ChildLaunchID: "failed-child", ParentRoot: parent, ChatRoot: old}
	original := emptyRecoveryInspectionInput{Profile: ProfileBinding{ProfileID: "profile", Root: "/private/tmp/synthetic/Farol Dev/farol-state/go-core", Device: 1, Inode: 2}, OwnerID: "owner", ComputerID: "computer", AccessDigest: [32]byte{1}, Mutations: make([]mutationrepo.ExpectedSettledRecord, 2), Selection: chatport.EmptyRecoverySelection{OperationID: "835a913b-bc20-42c6-bf56-9b83852cde3c", Current: current, HeadDigest: [32]byte{2}, LifecycleDigest: [32]byte{3}, Next: chatport.JournalScope{ProfileID: "profile", BackendGeneration: "original-maintenance"}, BuildID: "original-preparation-build", HostLifetimeID: "original-maintenance-host", ChildLaunchID: "original-maintenance-child"}}
	pending, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	in := preparedEmptyInspectionInput{Original: original, PendingSHA: sha256.Sum256(pending), OriginalSteps: 4}
	chat := NativeRoot{Path: original.Profile.Root + "/chat", ProfileID: "profile", Device: 1, Inode: 4, OwnerUID: 501, Mode: 0700}
	root := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	binding := chatport.HandoffBinding{ProfileID: "profile", BackendGeneration: original.Selection.Next.BackendGeneration, BuildID: original.Selection.BuildID, HostLifetimeID: original.Selection.HostLifetimeID, ChildLaunchID: original.Selection.ChildLaunchID, ParentRoot: parent, ChatRoot: root}
	receipt := chatport.RetirementReceipt{Write: chatport.RetirementWrite{Scope: original.Selection.Next, Root: root, Revision: 1, Turns: []chatport.RetirementTurn{}}, PublicationDigest: [32]byte{9}}
	publication := chatport.HandoffPublication{Binding: binding, HandoffID: original.Selection.OperationID, ReceiptDigest: receipt.PublicationDigest}
	record := chatport.HandoffRecord{Version: 1, Stage: chatport.HandoffAcknowledged, Origin: chatport.HandoffLiveOwner, Publication: publication, Receipt: receipt, ACK: &chatport.HandoffACK{Publication: publication}}
	raw, err := json.Marshal(record)
	if err != nil || policy.ValidateRecord(record) != nil {
		t.Fatal("invalid pure ACK fixture", err)
	}
	head := &chatport.HandoffHead{Record: &record, Digest: sha256.Sum256(raw), EmptyRetirementChain: true}
	life := &lifecyclerepo.Inspection{Scope: original.Selection.Next, Root: root, SnapshotDigest: receipt.PublicationDigest, Version: 1, Incarnations: []string{original.Selection.Next.BackendGeneration}, Retirement: &lifecyclerepo.InspectionRetirement{Revision: 1}}
	result := results.ClosedInspection{Scope: original.Selection.Next, Root: root, StorageRoot: chatport.JournalRoot{Device: 1, Inode: 5, OwnerUID: 501}, ClaimDigest: [32]byte{8}}
	files := map[string]emptyRecoveryFile{"chat-lifecycle.json": {Device: 1, Inode: 10, Mode: 0100600, OwnerUID: 501, SHA256: original.Selection.LifecycleDigest}}
	return in, chat, head, life, result, files
}

func TestPreparedEmptyInspectionPurePendingExactCanonicalOriginal(t *testing.T) {
	in, _, _, _, _, _ := preparedEmptyPureFixture(t)
	raw, _ := json.Marshal(in.Original)
	if !preparedEmptyPendingMatches(raw, in) || !preparedEmptyInputValid(in) {
		t.Fatal("exact original refused")
	}
	for _, kind := range []string{"sha", "original", "alias", "duplicate", "whitespace", "trailing", "unknown", "malformed", "overflow"} {
		t.Run(kind, func(t *testing.T) {
			selected, changed := in, append([]byte{}, raw...)
			switch kind {
			case "sha":
				selected.PendingSHA[0]++
			case "original":
				selected.Original.Selection.ChildLaunchID = "different"
			case "alias":
				changed = []byte(strings.Replace(string(raw), `"OwnerID"`, `"ownerid"`, 1))
			case "duplicate":
				changed = append([]byte(`{"OwnerID":"other",`), raw[1:]...)
			case "whitespace":
				changed = append(changed, ' ')
			case "trailing":
				changed = append(changed, []byte(" {}")...)
			case "unknown":
				changed = append([]byte(`{"Unknown":true,`), raw[1:]...)
			case "malformed":
				changed = []byte("{")
			case "overflow":
				changed = []byte(strings.Repeat(" ", 65537))
			}
			if kind != "sha" && kind != "original" {
				selected.PendingSHA = sha256.Sum256(changed)
			}
			if preparedEmptyPendingMatches(changed, selected) {
				t.Fatal("noncanonical or mismatched pending accepted")
			}
		})
	}
}

func TestPreparedEmptyInspectionPureObservationBuildAndDiagnostic(t *testing.T) {
	in, chat, head, life, result, files := preparedEmptyPureFixture(t)
	v, err := preparedEmptyObservation(in, chat, head, life, result, files)
	if err != nil || v.ObserverBuildID != BuildID || v.Publication.Binding.BuildID != in.Original.Selection.BuildID || v.ObserverBuildID == v.Publication.Binding.BuildID || v.NewChatRoot == in.Original.Selection.Current.ChatRoot || v.Acknowledgement.AckDigest != hex.EncodeToString(head.Digest[:]) || v.LifecycleSHA != hex.EncodeToString(life.SnapshotDigest[:]) {
		t.Fatal("observer/original identity or canonical ACK differs", err)
	}
	// Inventory digest binds all retained metadata, independent of map order.
	files["second"] = emptyRecoveryFile{Device: 1, Inode: 11, SHA256: [32]byte{4}}
	changed, err := preparedEmptyObservation(in, chat, head, life, result, files)
	if err != nil || changed.ArchiveDigest == v.ArchiveDigest {
		t.Fatal("full archive inventory not bound", err)
	}
	encoded, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(encoded, &fields) != nil || len(fields) != 8 {
		t.Fatal("diagnostic surface broadened")
	}
	for _, field := range []string{"schema", "observerBuildId", "profileId", "publication", "acknowledgement", "lifecycleSHA", "archiveInventoryDigest", "newChatRoot"} {
		if _, ok := fields[field]; !ok {
			t.Fatal("missing diagnostic field", field)
		}
	}
	for _, forbidden := range []string{in.Original.Profile.Root, `"Receipt":`, `"Terminal":`, `"Consumption":`, "PreviousHostDrainConfirmed", "recoveryAuthorized", "originalClosed", "originalAcknowledged"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("authority or unnecessary private bytes exposed", forbidden)
		}
	}
	if _, ok := any(v).(chatport.CleanRetirement); ok {
		t.Fatal("diagnostic became origin proof")
	}
	v.Publication.Binding.ChildLaunchID = "caller-mutated"
	if head.Record.Publication.Binding.ChildLaunchID != in.Original.Selection.ChildLaunchID {
		t.Fatal("visitor DTO aliases canonical record")
	}
}

func TestPreparedEmptyInspectionPureObservationRefusals(t *testing.T) {
	for _, kind := range []string{"old-root", "profile", "id", "build", "host", "child", "generation", "head-digest", "terminal", "consumption", "nonempty-chain", "lifecycle-scope", "lifecycle-root", "lifecycle-sha", "write", "turn", "incarnation", "retirement", "retirement-turn", "retirement-revision", "result", "result-scope", "result-root", "result-storage"} {
		t.Run(kind, func(t *testing.T) {
			in, chat, head, life, result, files := preparedEmptyPureFixture(t)
			switch kind {
			case "old-root":
				chat.Inode = in.Original.Selection.Current.ChatRoot.Inode
			case "profile":
				chat.ProfileID = "other"
			case "id":
				in.Original.Selection.OperationID = "other"
			case "build":
				in.Original.Selection.BuildID = "other"
			case "host":
				in.Original.Selection.HostLifetimeID = "other"
			case "child":
				in.Original.Selection.ChildLaunchID = "other"
			case "generation":
				in.Original.Selection.Next.BackendGeneration = "other"
			case "head-digest":
				head.Digest[0]++
			case "terminal":
				head.Record.Terminal = &chatport.HandoffTerminal{}
			case "consumption":
				head.Record.Consumption = &chatport.HandoffConsumption{}
			case "nonempty-chain":
				head.EmptyRetirementChain = false
			case "lifecycle-scope":
				life.Scope.BackendGeneration = "other"
			case "lifecycle-root":
				life.Root.Inode++
			case "lifecycle-sha":
				life.SnapshotDigest[0]++
			case "write":
				life.WriteCount++
			case "turn":
				life.TurnCount++
			case "incarnation":
				life.Incarnations = append(life.Incarnations, "other")
			case "retirement":
				life.Retirement = nil
			case "retirement-turn":
				life.Retirement.TurnCount++
			case "retirement-revision":
				life.Retirement.Revision++
			case "result":
				result.ResultCount++
			case "result-scope":
				result.Scope.BackendGeneration = "other"
			case "result-root":
				result.Root.Inode++
			case "result-storage":
				result.StorageRoot = result.Root
			}
			if v, err := preparedEmptyObservation(in, chat, head, life, result, files); err == nil || v != (preparedEmptyInspection{}) {
				t.Fatal("unsafe metadata qualified", err)
			}
		})
	}
}

func TestPreparedEmptyInspectionPureInputRefusesBeforeIO(t *testing.T) {
	in, _, _, _, _, _ := preparedEmptyPureFixture(t)
	for _, kind := range []string{"steps-zero", "steps-overflow", "pending", "profile", "operation", "generation", "host", "child", "mutations", "access", "head", "lifecycle"} {
		t.Run(kind, func(t *testing.T) {
			bad := in
			switch kind {
			case "steps-zero":
				bad.OriginalSteps = 0
			case "steps-overflow":
				bad.OriginalSteps = 1025
			case "pending":
				bad.PendingSHA = [32]byte{}
			case "profile":
				bad.Original.Profile = ProfileBinding{}
			case "operation":
				bad.Original.Selection.OperationID = "../../other"
			case "generation":
				bad.Original.Selection.Next.BackendGeneration = bad.Original.Selection.Current.BackendGeneration
			case "host":
				bad.Original.Selection.HostLifetimeID = bad.Original.Selection.Current.HostLifetimeID
			case "child":
				bad.Original.Selection.ChildLaunchID = bad.Original.Selection.Current.ChildLaunchID
			case "mutations":
				bad.Original.Mutations = bad.Original.Mutations[:1]
			case "access":
				bad.Original.AccessDigest = [32]byte{}
			case "head":
				bad.Original.Selection.HeadDigest = [32]byte{}
			case "lifecycle":
				bad.Original.Selection.LifecycleDigest = [32]byte{}
			}
			if preparedEmptyInputValid(bad) || inspectPreparedEmptyRecovery(context.Background(), bad, func(preparedEmptyInspection) error { t.Fatal("invalid input reached native visitor"); return nil }) == nil {
				t.Fatal("unsafe input accepted")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, ctx := range []context.Context{nil, ctx} {
		if inspectPreparedEmptyRecovery(ctx, in, func(preparedEmptyInspection) error { t.Fatal("cancelled input reached native visitor"); return nil }) == nil {
			t.Fatal("cancelled input accepted")
		}
	}
	if inspectPreparedEmptyRecovery(context.Background(), in, nil) == nil {
		t.Fatal("nil visitor accepted")
	}
	for _, steps := range []int{1, 1024} {
		in.OriginalSteps = steps
		if !preparedEmptyInputValid(in) || len(preparedEmptyChatNames(steps)) != 2*steps+4 {
			t.Fatal("original namespace budget differs")
		}
	}
}
