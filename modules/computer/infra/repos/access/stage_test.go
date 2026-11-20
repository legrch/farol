package access

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/services/migration"
	"github.com/legrch/farol/modules/computer/domain/authority"
	transition "github.com/legrch/farol/modules/computer/domain/journal"
	obs "github.com/legrch/farol/modules/computer/domain/observation"
	"github.com/legrch/farol/modules/computer/infra/observation"
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

type continuityBoot string

func (b continuityBoot) Current(context.Context) (string, error) { return string(b), nil }

// Both modes use the protected C7 and C4 WAL and real Go staging. Boot, anchor,
// held observation, Settings and withdrawal receipts are disposable fixtures.
func TestLinkedContinuityStagesAndQualifiesBothModes(t *testing.T) {
	cases := []struct {
		mode    migration.Mode
		command string
	}{
		{migration.Legacy, "computer.confirm-workspace"},
		{migration.Rebind, "computer.rebind-workspace"},
	}
	ctx := context.Background()
	for _, tc := range cases {
		t.Run(string(tc.mode), func(t *testing.T) {
			f := fixtureState(t)
			request := linkedChildRequest(f)
			stop := completeLinkedStopModeFixture(t, f, request, string(tc.mode), tc.command)
			old := f.approval.Workspaces[0].RootIdentity
			device, err := strconv.ParseUint(old.Device, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			inode, err := strconv.ParseUint(old.Inode, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			measured := obs.Observation{
				Binding: obs.Binding{Path: f.workspace, Device: strconv.FormatUint(device+1, 10), Inode: old.Inode},
				Evidence: obs.Evidence{Schema: obs.EvidenceSchema, Filesystem: "apfs",
					VolumeUUID: "11111111-2222-3333-4444-555555555555", FileID: old.Inode, BirthSeconds: "10", BirthNanoseconds: "7"},
			}
			saved := obs.Saved{Binding: obs.Binding{Device: old.Device, Inode: old.Inode}}
			if tc.mode == migration.Rebind {
				saved.Evidence = &measured.Evidence
			}
			parents := migration.NewParent(f.store.ObserveStopLedger, stop.HostLifetimeID, stop.BackendGeneration)
			selection, err := parents.Select(ctx, request.OperationID, tc.mode, saved)
			if err != nil {
				t.Fatal(err)
			}
			native := &candidateNative{device: device + 1, inode: inode, observed: measured}
			owner := migration.New(f.store, continuityBoot(request.BootUUID), parents, native, native, &sync.Mutex{}, observation.Digester{})
			t.Cleanup(func() {
				if err := owner.Close(); err != nil {
					t.Error(err)
				}
			})
			id := request.OperationID
			if first, err := owner.Begin(ctx, selection); err != nil || !first.Admitted || first.PriorPhase != transition.Intent {
				t.Fatal("admission", first, err)
			}
			if _, err := owner.Begin(ctx, selection); !errors.Is(err, transition.ErrRefused) || native.acquired != 1 || native.held != 1 {
				t.Fatal("second begin acquired custody", err)
			}
			root := ""
			if tc.mode == migration.Legacy {
				root = f.workspace
				if _, err := owner.Confirm(ctx, id, "/different/root", true); !errors.Is(err, transition.ErrRefused) {
					t.Fatal("different picker root accepted", err)
				}
			}
			prepared, err := owner.Confirm(ctx, id, root, tc.mode == migration.Legacy)
			if err != nil || prepared.Observation != measured || prepared.Request != selection.Request {
				t.Fatal("prepared result differs from parent and native measurement", prepared, err)
			}
			record := func(phase transition.Phase, receipt transition.Receipt) {
				t.Helper()
				if err := owner.Record(ctx, id, phase, receipt); err != nil {
					t.Fatal(phase, err)
				}
			}
			intent := func(phase transition.Phase) transition.Receipt {
				t.Helper()
				plan, err := owner.Plan(ctx, id, phase)
				if err != nil {
					t.Fatal(phase, err)
				}
				record(phase, plan)
				return plan
			}
			withdraw := intent(transition.WithdrawIntent)
			calls := 0
			withdrawEffect := func(ctx context.Context, id string, planned transition.Receipt) (transition.Receipt, error) {
				calls++
				_, err := f.store.TransitionEffectSnapshot(ctx, id, transition.WithdrawIntent, planned)
				return transition.Receipt{EffectID: planned.EffectID, Digest: strings.Repeat("1", 64)}, err
			}
			ack, err := owner.WithdrawOnce(ctx, id, withdrawEffect)
			if err != nil || ack.EffectID != withdraw.EffectID {
				t.Fatal("withdrawal did not bind original intent", ack, err)
			}
			if _, err := owner.WithdrawOnce(ctx, id, withdrawEffect); !errors.Is(err, transition.ErrRefused) || calls != 1 {
				t.Fatal("second withdrawal dispatched", err)
			}
			record(transition.WithdrawAcknowledged, ack)
			settings := intent(transition.SettingsIntent)
			record(transition.SettingsAcknowledged, transition.Receipt{EffectID: settings.EffectID, Digest: strings.Repeat("2", 64)})
			publish := intent(transition.PublishIntent)
			ack, err = owner.StageOnce(ctx, id, f.store.StageMeasuredContinuity)
			if err != nil || ack.EffectID != publish.EffectID || ack.Digest == publish.Digest {
				t.Fatal("stage receipt invalid", ack, err)
			}
			if _, err := owner.StageOnce(ctx, id, f.store.StageMeasuredContinuity); !errors.Is(err, transition.ErrRefused) {
				t.Fatal("second stage accepted", err)
			}
			record(transition.PublishAcknowledged, ack)
			cleanup := intent(transition.CloseIntent)
			if err := owner.Finish(ctx, id, transition.Committed, cleanup); err != nil {
				t.Fatal("finish", err)
			}
			if err := owner.Finish(ctx, id, transition.Committed, cleanup); !errors.Is(err, transition.ErrRefused) || native.released != 2 {
				t.Fatal("finish replayed close", err)
			}
			if _, err := f.store.Status(ctx); err == nil {
				t.Fatal("staged or committed bytes activated without qualification")
			}
			reader := &qualifiedReader{proof: CurrentReaderProof{
				Saved:         obs.Saved{Binding: measured.Binding, Evidence: &measured.Evidence},
				ConsentDigest: request.ConsentDigest, SettingsRevision: 3, ComputerGeneration: 4,
			}}
			qualifier := NewHeldCurrentQualifier(reader, native, native)
			if qualified, err := f.store.QualifyContinuityOperation(ctx, stop.OperationID, qualifier); err != nil || qualified || reader.calls != 0 {
				t.Fatal("qualification invoked for wrong operation", qualified, err)
			}
			if qualified, err := f.store.QualifyContinuityOperation(ctx, id, qualifier); err != nil || !qualified || native.released != 4 {
				t.Fatal("current qualification", qualified, err)
			}
			if value := status(t, f.store); value.Generation != f.approval.Generation+1 ||
				f.store.current.Approval.Workspaces[0].RootIdentity.Device != measured.Binding.Device {
				t.Fatal("measured binding not staged and qualified", value)
			}
		})
	}
}
