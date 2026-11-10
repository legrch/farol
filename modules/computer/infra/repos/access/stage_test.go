package access

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
	transition "github.com/legrch/farol/modules/computer/domain/journal"
)

func TestContinuityStagedPublicationIsNotAuthority(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	approve(t, f)
	admit(t, f) // old task must be revoked by the staged generation.
	before := status(t, f.store)
	request := transitionIntent
	request.WorkspaceID, request.Root = "work", f.workspace
	if _, _, err := f.store.BeginTransition(ctx, request); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []transition.Phase{transition.Prepared, transition.WithdrawIntent, transition.WithdrawAcknowledged, transition.SettingsIntent, transition.SettingsAcknowledged, transition.PublishIntent} {
		if err := f.store.AdvanceTransition(ctx, request.OperationID, phase, transitionProof); err != nil {
			t.Fatal(phase, err)
		}
	}
	proposal := f.approval.Clone()
	proposal.Generation++
	proposal.Workspaces[0].RootIdentity.Device = "999999" // synthetic remount; no native authority
	if _, err := f.store.StageContinuityApproval(ctx, request.OperationID, transition.Receipt{EffectID: "wrong", Digest: strings.Repeat("c", 64)}, before.Revision, proposal); err == nil {
		t.Fatal("unrelated publish intent accepted")
	}
	if _, err := f.store.StageContinuityApproval(ctx, request.OperationID, transitionProof, before.Revision, proposal); err != nil {
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
	request := transitionIntent
	request.WorkspaceID, request.Root = "work", f.workspace
	if _, _, err := f.store.BeginTransition(ctx, request); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []transition.Phase{transition.Prepared, transition.WithdrawIntent, transition.WithdrawAcknowledged, transition.SettingsIntent, transition.SettingsAcknowledged, transition.PublishIntent} {
		if err := f.store.AdvanceTransition(ctx, request.OperationID, phase, transitionProof); err != nil {
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
			if _, err := f.store.StageContinuityApproval(ctx, request.OperationID, transitionProof, revision, proposed); err == nil {
				t.Fatal("expanded policy staged")
			}
			if f.store.current.Revision != revision || f.store.current.Approval.Generation != f.approval.Generation {
				t.Fatal("refused staged approval still changed Store")
			}
		})
	}
}

func TestStageContinuityOnlySelectedRootCanRebindAndNeverExtendsExpiry(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	other := f.approval.Workspaces[0]
	other.WorkspaceID, other.Root = "other", f.home
	other.RootIdentity = authority.RootIdentity{Device: "777", Inode: "555"}
	f.approval.Workspaces = append(f.approval.Workspaces, other)
	approve(t, f)
	prior := status(t, f.store)
	request := transitionIntent
	request.Root, request.WorkspaceID = f.workspace, "work"
	if _, _, err := f.store.BeginTransition(ctx, request); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []transition.Phase{transition.Prepared, transition.WithdrawIntent, transition.WithdrawAcknowledged, transition.SettingsIntent, transition.SettingsAcknowledged, transition.PublishIntent} {
		if err := f.store.AdvanceTransition(ctx, request.OperationID, phase, transitionProof); err != nil {
			t.Fatal(err)
		}
	}
	base := f.approval.Clone()
	base.Generation++
	base.Workspaces[0].RootIdentity.Device = "888"
	cases := []struct {
		name   string
		change func(*authority.Approval)
	}{
		{"extended expiry", func(a *authority.Approval) { a.ExpiresAt = a.ExpiresAt.Add(time.Hour) }},
		{"other workspace device", func(a *authority.Approval) { a.Workspaces[1].RootIdentity.Device = "888" }},
		{"other workspace inode", func(a *authority.Approval) { a.Workspaces[1].RootIdentity.Inode = "999" }},
		{"other workspace permissions", func(a *authority.Approval) { a.Workspaces[1].Access = authority.WriteAccess }},
		{"other workspace identity", func(a *authority.Approval) { a.Workspaces[1].WorkspaceID = "different" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := base.Clone()
			tc.change(&a)
			if _, err := f.store.StageContinuityApproval(ctx, request.OperationID, transitionProof, prior.Revision, a); err == nil {
				t.Fatal("side-effect/expiry staged")
			}
			if f.store.current.Revision != prior.Revision {
				t.Fatal("refused stage changed Store")
			}
		})
	}
	if _, err := f.store.StageContinuityApproval(ctx, request.OperationID, transitionProof, prior.Revision, base); err != nil {
		t.Fatal("exact selected root refused", err)
	}
}
