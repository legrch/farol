//go:build darwin

package boot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
)

// Native stores and canonical consumed history; process closure, terminal and
// Settings remain explicit fixture facts. This never opens a real Dev profile.
func preservedEmptyProfileFixture(t *testing.T) preservedProfileInspectionInput {
	t.Helper()
	empty := emptyRecoveryFixtureWithMutations(t, true, false, "Farol Dev", false)
	b, s := empty.Selection.Current, empty.Selection
	return preservedProfileInspectionInput{
		Profile: empty.Profile, OwnerID: empty.OwnerID, ComputerID: empty.ComputerID, AccessDigest: empty.AccessDigest,
		Selection: chatport.PreservedRecoverySelection{
			OperationID: s.OperationID,
			Current:     chatport.PreservedRecoveryBinding{Scope: chatport.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, ParentRoot: b.ParentRoot, ChatRoot: b.ChatRoot},
			Next:        s.Next, BuildID: s.BuildID, HostLifetimeID: s.HostLifetimeID, ChildLaunchID: s.ChildLaunchID,
		},
	}
}

func TestPreservedProfileDiscoveryNativeConsumedEmptyHistory(t *testing.T) {
	in := preservedEmptyProfileFixture(t)
	before := snapshotPreservedObservationTree(t, in.Profile.Root)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	calls := 0
	err := discoverPreservedProfile(ctx, preservedProfileDiscoveryRequest(in), func(v preservedProfileInspection) error {
		calls++
		if v.Lifecycle.WriteCount != 0 || v.Lifecycle.TurnCount != 0 || v.Results.ResultCount != 0 || len(v.Lifecycle.Incarnations) < 2 || v.Lifecycle.Retirement != nil {
			t.Fatal("fixture did not retain consumed empty history")
		}
		return nil
	})
	unchangedPreservedObservationTree(t, in.Profile.Root, before)
	if err != nil || calls != 1 {
		t.Fatal("canonical consumed empty history was not routed", err, calls)
	}
}

func TestPreservedProfileNativeEmptySelectionKeepsExistingRefusals(t *testing.T) {
	in := preservedEmptyProfileFixture(t)
	before := snapshotPreservedObservationTree(t, in.Profile.Root)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := discoverPreservedProfile(ctx, preservedProfileDiscoveryRequest(in), func(v preservedProfileInspection) error {
		base := chatport.PreservedRecoveryObservation{Scope: v.Lifecycle.Scope, ParentRoot: v.Handoff.ParentRoot, ChatRoot: v.Handoff.ChatRoot, ResultsRoot: v.Results.Root, ResultsStorageRoot: v.Results.StorageRoot, HandoffDigest: v.Handoff.HeadDigest, LifecycleDigest: v.Lifecycle.SnapshotDigest, ResultsDigest: v.Results.SnapshotDigest, HandoffSteps: len(v.Handoff.Stages), Incarnations: v.Lifecycle.Incarnations}
		unknown := base
		unknown.ResultsUnresolved = true
		if plan, err := selectPreservedProfilePlan(v.Plan.Selection, unknown, v.Handoff.EmptyHead); err != nil || plan == nil || !plan.RetainsUnresolvedResults {
			t.Fatal("unresolved results were routed as empty or lost", err)
		}
		for _, fault := range []string{"missing-head", "not-empty-chain", "retirement", "results-digest", "handoff-digest", "lifecycle-digest", "chat-root", "parent-root", "scope", "reuse-generation", "reuse-host", "reuse-child", "invalid-operation", "invalid-build", "steps"} {
			t.Run(fault, func(t *testing.T) {
				s, o, head := v.Plan.Selection, base, *v.Handoff.EmptyHead
				h := &head
				switch fault {
				case "missing-head":
					h = nil
				case "not-empty-chain":
					head.EmptyRetirementChain = false
				case "retirement":
					o.RetirementPresent = true
				case "results-digest":
					s.ResultsDigest[0] ^= 1
				case "handoff-digest":
					s.HandoffDigest[0] ^= 1
				case "lifecycle-digest":
					s.LifecycleDigest[0] ^= 1
				case "chat-root":
					s.Current.ChatRoot.Inode++
				case "parent-root":
					s.Current.ParentRoot.Inode++
				case "scope":
					s.Current.Scope.BackendGeneration = "another-scope"
				case "reuse-generation":
					s.Next.BackendGeneration = o.Incarnations[0]
				case "reuse-host":
					s.HostLifetimeID = head.Record.Consumption.NextBinding.HostLifetimeID
				case "reuse-child":
					s.ChildLaunchID = head.Record.Consumption.NextBinding.ChildLaunchID
				case "invalid-operation":
					s.OperationID = "invalid"
				case "invalid-build":
					s.BuildID = ""
				case "steps":
					o.HandoffSteps = 0
				}
				if plan, err := selectPreservedProfilePlan(s, o, h); err == nil || plan != nil {
					t.Fatal("invalid empty selection gained archive metadata", fault)
				}
			})
		}
		return nil
	})
	unchangedPreservedObservationTree(t, in.Profile.Root, before)
	if err != nil {
		t.Fatal(err)
	}
}

func TestPreservedProfileNativeEmptyPreparationRetainsHistoryAndFence(t *testing.T) {
	for _, lostACK := range []bool{false, true} {
		t.Run(map[bool]string{false: "acknowledged", true: "lost-ack"}[lostACK], func(t *testing.T) {
			in := preservedEmptyProfileFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var oldChat NativeRoot
			var original map[string]emptyRecoveryFile
			if err := discoverPreservedProfile(ctx, preservedProfileDiscoveryRequest(in), func(v preservedProfileInspection) error {
				in.Selection = v.Plan.Selection
				oldChat = v.Chat
				var err error
				original, err = emptyRecoveryArchiveFiles(ctx, v.Chat)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			computer := snapshotPreservedObservationTree(t, filepath.Join(in.Profile.Root, "computer"))
			calls := 0
			ack, err := preparePreservedProfileRecovery(ctx, in, func(p chatport.HandoffPublication) error {
				calls++
				if p.Binding.BackendGeneration != in.Selection.Next.BackendGeneration || p.Binding.ChatRoot == in.Selection.Current.ChatRoot || p.Binding.HostLifetimeID != in.Selection.HostLifetimeID {
					t.Fatal("old lifetime reused")
				}
				if lostACK {
					return errors.New("fixture host ACK unavailable")
				}
				return nil // Fixture ACK, never live host or process proof.
			})
			if calls != 1 || (!lostACK && (err != nil || ack.HandoffId == "")) || (lostACK && (err == nil || ack.HandoffId != "")) {
				t.Fatal("incorrect fresh ACK outcome", err, calls)
			}
			archived := oldChat
			archived.Path = filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)
			current, err := emptyRecoveryArchiveFiles(ctx, archived)
			if err != nil || !reflect.DeepEqual(original, current) {
				t.Fatal("original consumed history changed", err)
			}
			unchangedPreservedObservationTree(t, filepath.Join(in.Profile.Root, "computer"), computer)
			if _, err := os.Lstat(emptyRecoveryPendingPath(in.Profile.Root)); err != nil {
				t.Fatal("pending fence lost before terminal", err)
			}
			before := recoverySnapshot(t, in.Profile.Root)
			if _, err := preparePreservedProfileRecovery(ctx, in, func(chatport.HandoffPublication) error { t.Fatal("old operation repeated"); return nil }); err == nil {
				t.Fatal("preparation replayed")
			}
			if !reflect.DeepEqual(before, recoverySnapshot(t, in.Profile.Root)) {
				t.Fatal("rejected replay changed custody")
			}
		})
	}
}
