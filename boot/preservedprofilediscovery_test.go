package boot

import (
	"context"
	"errors"
	"testing"
	"time"

	archivepolicy "github.com/legrch/farol/modules/chat/app/capabilities/archive"
	chatport "github.com/legrch/farol/modules/chat/app/port"
)

// This syntactically valid selection deliberately names no native fixture. An
// archive-policy refusal, rather than a native ProfileFailure, guards validation
// before qualification without replacing any production implementation.
func preservedProfileDiscoveryUnopenedInput() preservedProfileInspectionInput {
	return preservedProfileInspectionInput{
		Profile: ProfileBinding{ProfileID: "selected-profile", Root: "/farol-discovery-unopened-profile", Device: 7, Inode: 11},
		OwnerID: "selected-owner", ComputerID: "selected-computer", AccessDigest: [32]byte{1},
		Selection: chatport.PreservedRecoverySelection{
			OperationID: "835a913b-bc20-42c6-bf56-9b83852cde3c",
			Current: chatport.PreservedRecoveryBinding{
				Scope:      chatport.JournalScope{ProfileID: "selected-profile"},
				ParentRoot: chatport.JournalRoot{Device: 7, Inode: 11},
				ChatRoot:   chatport.JournalRoot{Device: 7, Inode: 12},
			},
			Next:    chatport.JournalScope{ProfileID: "selected-profile", BackendGeneration: "future-generation"},
			BuildID: BuildID, HostLifetimeID: "future-host", ChildLaunchID: "future-child",
		},
	}
}

// Only test request construction: the original physical roots, access digest,
// future identities and complete selected mutation records remain supplied.
func preservedProfileDiscoveryRequest(in preservedProfileInspectionInput) preservedProfileInspectionInput {
	in.Mutations = append(in.Mutations[:0:0], in.Mutations...)
	in.Selection.Current.Scope.BackendGeneration = ""
	in.Selection.HandoffDigest = [32]byte{}
	in.Selection.LifecycleDigest = [32]byte{}
	in.Selection.ResultsDigest = [32]byte{}
	return in
}

func TestPreservedProfileDiscoveryRefusesSelectedMetadataBeforeQualification(t *testing.T) {
	for _, selected := range []string{"generation", "handoff-digest", "lifecycle-digest", "results-digest", "profile-mismatch"} {
		t.Run(selected, func(t *testing.T) {
			in := preservedProfileDiscoveryUnopenedInput()
			switch selected {
			case "generation":
				in.Selection.Current.Scope.BackendGeneration = "caller-guessed-generation"
			case "handoff-digest":
				in.Selection.HandoffDigest[0] = 1
			case "lifecycle-digest":
				in.Selection.LifecycleDigest[0] = 1
			case "results-digest":
				in.Selection.ResultsDigest[0] = 1
			case "profile-mismatch":
				in.Selection.Current.Scope.ProfileID = "another-selected-profile"
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			calls := 0
			err := discoverPreservedProfile(ctx, in, func(preservedProfileInspection) error { calls++; return nil })
			if !errors.Is(err, archivepolicy.Refused) || calls != 0 {
				t.Fatal("invalid discovery selection reached qualification or visitor", selected, err, calls)
			}
		})
	}
}

func TestPreservedProfileDiscoveryRefusesMissingOrExpiredOriginalBudgetBeforeQualification(t *testing.T) {
	cancelled, cancel := context.WithTimeout(context.Background(), time.Hour)
	cancel()
	for _, tc := range []struct {
		name string
		ctx  context.Context
	}{
		{"nil", nil},
		{"unbounded", context.Background()},
		{"cancelled", cancelled},
		{"zero-deadline", &preservedProfileLagContext{Context: context.Background()}},
		{"expired-with-lagging-timer", &preservedProfileLagContext{Context: context.Background(), until: time.Now().Add(-time.Second)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			err := discoverPreservedProfile(tc.ctx, preservedProfileDiscoveryUnopenedInput(), func(preservedProfileInspection) error { calls++; return nil })
			if !errors.Is(err, archivepolicy.Refused) || calls != 0 {
				t.Fatal("invalid original budget reached qualification or visitor", err, calls)
			}
		})
	}
}

func TestPreservedProfileDiscoveryRefusesMissingVisitorBeforeQualification(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := discoverPreservedProfile(ctx, preservedProfileDiscoveryUnopenedInput(), nil); !errors.Is(err, archivepolicy.Refused) {
		t.Fatal("missing discovery visitor reached qualification", err)
	}
}
