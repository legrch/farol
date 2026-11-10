package access

import (
	"context"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
	transition "github.com/legrch/farol/modules/computer/domain/journal"
)

func TestContinuityStagedPublicationIsNotAuthority(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	approve(t, f)
	admit(t, f) // old task must be revoked by the staged generation.
	before := status(t, f.store)
	if _, _, err := f.store.BeginTransition(ctx, transitionIntent); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []transition.Phase{transition.Prepared, transition.WithdrawIntent, transition.WithdrawAcknowledged, transition.SettingsIntent, transition.SettingsAcknowledged, transition.PublishIntent} {
		if err := f.store.AdvanceTransition(ctx, transitionIntent.OperationID, phase, transitionProof); err != nil {
			t.Fatal(phase, err)
		}
	}
	proposal := f.approval.Clone()
	proposal.Generation++
	proposal.Workspaces[0].RootIdentity.Device = "999999" // synthetic remount; no native authority
	if _, err := f.store.StageContinuityApproval(ctx, transitionIntent.OperationID, transition.Receipt{EffectID: "wrong", Digest: strings.Repeat("c", 64)}, before.Revision, proposal); err == nil {
		t.Fatal("unrelated publish intent accepted")
	}
	if _, err := f.store.StageContinuityApproval(ctx, transitionIntent.OperationID, transitionProof, before.Revision, proposal); err != nil {
		t.Fatal("staged-only CAS", err)
	}
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("staged approval activated before native Close/certificate")
	}
	if err := f.store.WithOwnerApproval(ctx, func(_ Status, _ *authority.Approval) error { t.Fatal("staged approval exposed"); return nil }); err == nil {
		t.Fatal("protected read succeeded during staging")
	}
	observed, err := f.store.TransitionStatus(ctx)
	if err != nil || !observed.Restricted || observed.Journal.Entries[0].Phase != transition.PublishIntent {
		t.Fatal("staging changed journal or bypassed pending", err)
	}
	if f.store.current.Approval == nil || f.store.current.Approval.Generation != proposal.Generation {
		t.Fatal("staged bytes not committed under Store owner")
	}
	for _, participant := range f.store.current.Participants {
		if !participant.Revoked {
			t.Fatal("staged native rebind preserved an old task grant")
		}
	}
}

func TestContinuityStagingRefusesExpandedEffectivePolicy(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	approve(t, f)
	revision := status(t, f.store).Revision
	if _, _, err := f.store.BeginTransition(ctx, transitionIntent); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []transition.Phase{transition.Prepared, transition.WithdrawIntent, transition.WithdrawAcknowledged, transition.SettingsIntent, transition.SettingsAcknowledged, transition.PublishIntent} {
		if err := f.store.AdvanceTransition(ctx, transitionIntent.OperationID, phase, transitionProof); err != nil {
			t.Fatal(err)
		}
	}
	baseline := f.approval.Clone()
	baseline.Generation++
	cases := map[string]func(*authority.Approval){
		"shell verified": func(a *authority.Approval) { a.Workspaces[0].ShellVerified = true },
		"write access":   func(a *authority.Approval) { a.Workspaces[0].Access = authority.WriteAccess },
		"changed root":   func(a *authority.Approval) { a.Workspaces[0].Root = "/other" },
		"new capability": func(a *authority.Approval) { a.Capabilities = append(a.Capabilities, authority.Write) },
		"greater commands": func(a *authority.Approval) {
			a.Commands = authority.WorkspaceCommands
			a.Capabilities = append(a.Capabilities, authority.Shell)
		},
		"different inode": func(a *authority.Approval) { a.Workspaces[0].RootIdentity.Inode = "4242" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			proposed := baseline.Clone()
			change(&proposed)
			if _, err := f.store.StageContinuityApproval(ctx, transitionIntent.OperationID, transitionProof, revision, proposed); err == nil {
				t.Fatal("expanded policy staged")
			}
			if f.store.current.Revision != revision || f.store.current.Approval.Generation != f.approval.Generation {
				t.Fatal("refused staged approval still changed Store")
			}
		})
	}
}
