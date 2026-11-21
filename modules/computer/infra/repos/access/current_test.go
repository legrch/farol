package access

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
)

// Synthetic qualification: actual mounted startup Data, compatible reader,
// owner Settings and recovery/update predicates require macOS witnesses.
type currentQualifierFixture struct {
	calls   int
	err     error
	witness *currentWitnessFixture
}
type currentWitnessFixture struct {
	checked, closed    int
	checkErr, closeErr error
}

func (w *currentWitnessFixture) RequalifyCurrent(context.Context) error {
	w.checked++
	return w.checkErr
}
func (w *currentWitnessFixture) Close() error { w.closed++; return w.closeErr }
func (f *currentQualifierFixture) PrepareCurrent(_ context.Context, entry journal.Entry, a authority.Approval) (CurrentWitness, error) {
	f.calls++
	if entry.Certificate == nil || entry.Certificate.Kind != journal.Committed || a.Generation != 4 {
		return nil, errors.New("invalid test scope")
	}
	if f.err != nil {
		return nil, f.err
	}
	if f.witness == nil {
		f.witness = &currentWitnessFixture{}
	}
	return f.witness, nil
}

func committedCurrentFixture(t *testing.T) (stateFixture, journal.Request) {
	t.Helper()
	f := fixtureState(t)
	approve(t, f)
	r := transitionIntent
	r.Root = f.workspace
	r.WorkspaceID = "work"
	ctx := context.Background()
	if _, _, err := f.store.BeginTransition(ctx, r); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []journal.Phase{journal.Prepared, journal.WithdrawIntent, journal.WithdrawAcknowledged, journal.SettingsIntent, journal.SettingsAcknowledged, journal.PublishIntent} {
		if err := f.store.AdvanceTransition(ctx, r.OperationID, phase, transitionProof); err != nil {
			t.Fatal(err)
		}
	}
	revised := f.approval.Clone()
	revised.Generation++
	revised.Workspaces[0].RootIdentity.Device = "999999"
	prior := f.store.current.Revision
	if _, err := f.store.StageContinuityApproval(ctx, r.OperationID, transitionProof, prior, revised); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []journal.Phase{journal.PublishAcknowledged, journal.CloseIntent, journal.CloseAcknowledged} {
		if err := f.store.AdvanceTransition(ctx, r.OperationID, phase, transitionProof); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.store.CertifyTransition(ctx, r.OperationID, journal.Committed, transitionProof); err != nil {
		t.Fatal(err)
	}
	return f, r
}

func TestCurrentCertificateNeedsTrustedQualificationNotEqualSavedBytes(t *testing.T) {
	f, r := committedCurrentFixture(t)
	ctx := context.Background()
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("terminal certificate activated old Store")
	}
	if _, err := f.store.ActivateCurrentTransition(ctx, nil); err == nil {
		t.Fatal("missing host qualification passed")
	}
	denied := &currentQualifierFixture{err: errors.New("incompatible recovery")}
	if _, err := f.store.ActivateCurrentTransition(ctx, denied); err == nil || denied.calls != 1 {
		t.Fatal("unsupported recovery activated current", err)
	}
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("failed qualification changed admission")
	}
	q := &currentQualifierFixture{}
	proof, err := f.store.ActivateCurrentTransition(ctx, q)
	if err != nil || q.calls != 1 || q.witness.checked != 1 || q.witness.closed != 1 || proof.OperationID != r.OperationID || proof.CallerDelivery != "not_recorded" {
		t.Fatal("qualified current result", err, proof)
	}
	if _, err := f.store.Status(ctx); err != nil {
		t.Fatal("qualified native/store gate did not open", err)
	}
	if _, err := f.store.ActivateCurrentTransition(ctx, q); err == nil {
		t.Fatal("double current activation")
	}
	reopened := restored(t, f)
	if _, err := reopened.Status(ctx); err == nil {
		t.Fatal("restart reused ephemeral native qualification")
	}
}

func TestStartupQualifiesCommittedContinuityBeforePublication(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		err    error
		wanted string
	}{
		{name: "qualified"},
		{name: "reader refusal", err: journal.ErrRefused, wanted: "WORKSPACE_STARTUP_CONTINUITY_REFUSED"},
		{name: "reader outcome unknown", err: journal.ErrUnknown, wanted: ErrStartupContinuityUnknown.Error()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, request := committedCurrentFixture(t)
			reopened := restored(t, f)
			if _, err := reopened.Status(ctx); err == nil {
				t.Fatal("startup exposed the persisted Store without qualification")
			}
			proposed := reopened.current.Approval.Clone()
			binding := proposed.Workspaces[0].RootIdentity
			inode, err := strconv.ParseUint(binding.Inode, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			device, err := strconv.ParseUint(binding.Device, 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			_, _, reader, native := nativeCurrentFixture()
			reader.err = tc.err
			reader.proof.ConsentDigest = request.ConsentDigest
			reader.proof.Saved.Binding.Path = request.Root
			reader.proof.Saved.Binding.Inode = binding.Inode
			reader.proof.Saved.Evidence.FileID = binding.Inode
			native.observed.Binding = reader.proof.Saved.Binding
			native.observed.Binding.Device = binding.Device
			native.observed.Evidence = *reader.proof.Saved.Evidence
			native.inode, native.device = inode, device
			qualifier := NewHeldCurrentQualifier(reader, native, native)
			startup := reopened.StartupContinuity(qualifier)
			if ok, err := reopened.QualifyContinuityOperation(ctx, request.OperationID, qualifier); ok || err != nil || reader.calls != 0 {
				t.Fatal("desktop reached the retained commit before startup", ok, err)
			}
			for i := 0; i < 2; i++ {
				startup = reopened.StartupContinuity(qualifier)
				current, err := startup.Status(ctx, reopened.Status)
				if tc.wanted != "" {
					var refused *authority.Failure
					classified := errors.Is(err, ErrStartupContinuityUnknown) && err.Error() == tc.wanted ||
						errors.As(err, &refused) && refused.Code == tc.wanted
					if !classified || current != (Status{}) {
						t.Fatal("startup failure returned an authority receipt", current, err)
					}
					if state, err := reopened.TransitionStatus(ctx); err != nil || !state.Restricted {
						t.Fatal("startup failure lifted the fence", state, err)
					}
					continue
				}
				if err != nil || !current.ApprovalPresent {
					t.Fatal("qualification did not release normal publication", current, err)
				}
				if err := reopened.UpdateApproval(ctx, current.Revision, proposed); err != nil {
					t.Fatal("first ordinary authority publication was refused", err)
				}
			}
			if ok, err := reopened.QualifyContinuityOperation(ctx, request.OperationID, qualifier); ok || err != nil || reader.calls != 1 {
				t.Fatal("retained commit qualification was replayed", ok, err, reader.calls)
			}
			if tc.err != nil && native.acquired != 0 || tc.err == nil && native.released != 2 {
				t.Fatal("startup did not retain and close its original native custody", native)
			}
		})
	}
}

func TestStartupQualificationLeavesEmptyAndUnknownHistoryUntouched(t *testing.T) {
	ctx := context.Background()
	for _, unknown := range []bool{false, true} {
		f := fixtureState(t)
		approve(t, f)
		before, err := f.store.Status(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if unknown {
			if _, _, err := f.store.BeginTransition(ctx, transitionIntent); err != nil {
				t.Fatal(err)
			}
		}
		reopened := restored(t, f)
		qualifier := &currentQualifierFixture{}
		startup := reopened.StartupContinuity(qualifier)
		for i := 0; i < 2; i++ {
			after, err := startup.Status(ctx, reopened.Status)
			if unknown {
				if !errors.Is(err, ErrStartupContinuityUnknown) {
					t.Fatal("original unknown WAL was not reported", err)
				}
			} else if err != nil || after != before {
				t.Fatal("empty history changed startup", before, after, err)
			}
		}
		if state, err := reopened.TransitionStatus(ctx); err != nil || state.Restricted != unknown || qualifier.calls != 0 {
			t.Fatal("startup attempted qualification without a committed transition", state, err, qualifier.calls)
		}
	}
}

func TestStartupQualificationUsesLaterVerifiedGeneration(t *testing.T) {
	ctx := context.Background()
	f, _ := committedCurrentFixture(t)
	if _, err := f.store.ActivateCurrentTransition(ctx, &currentQualifierFixture{}); err != nil {
		t.Fatal(err)
	}
	proposed := f.store.current.Approval.Clone()
	proposed.Generation++
	if err := f.store.UpdateApproval(ctx, f.store.current.Revision, proposed); err != nil {
		t.Fatal(err)
	}
	reopened := restored(t, f)
	calls := 0
	qualifier := currentQualifierFunc(func(_ context.Context, _ journal.Entry, approval authority.Approval) (CurrentWitness, error) {
		calls++
		if approval.Generation != proposed.Generation {
			t.Fatalf("qualification used historical generation %d", approval.Generation)
		}
		return &currentWitnessFixture{}, nil
	})
	startup := reopened.StartupContinuity(qualifier)
	if status, err := startup.Status(ctx, reopened.Status); err != nil || status.Generation != proposed.Generation || calls != 1 {
		t.Fatal("later verified generation was fenced", status, err, calls)
	}
}

type currentQualifierFunc func(context.Context, journal.Entry, authority.Approval) (CurrentWitness, error)

func (f currentQualifierFunc) PrepareCurrent(ctx context.Context, entry journal.Entry, proposed authority.Approval) (CurrentWitness, error) {
	return f(ctx, entry, proposed)
}

func TestCurrentTicketRequiresExactStoreAndJournalBytes(t *testing.T) {
	f, _ := committedCurrentFixture(t)
	ctx := context.Background()
	if _, err := f.store.ActivateCurrentTransition(ctx, &currentQualifierFixture{}); err != nil {
		t.Fatal(err)
	}
	// Synthetic mutation of a protected digest simulates invalidation; native
	// restore also refuses changed durable bytes via checkStorage().
	original := f.store.digest
	f.store.digest[0] ^= 1
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("mutated protected digest retained admission")
	}
	f.store.digest = original
	// The poisoned Store never opens after a protected disk disagreement.
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("poisoned snapshot revived")
	}
}

func TestCurrentUnknownJournalAndWrongGenerationRemainClosed(t *testing.T) {
	f, r := committedCurrentFixture(t)
	ctx := context.Background()
	f.store.current.Generation--
	if _, err := f.store.ActivateCurrentTransition(ctx, &currentQualifierFixture{}); err == nil {
		t.Fatal("wrong generation admitted")
	}
	f.store.current.Generation++
	if _, err := f.store.TransitionStatus(ctx); err != nil {
		t.Fatal(err)
	}
	// This distinct request may not inherit the previous UUID/certificate.
	second := r
	second.OperationID = "22222222-2222-4222-8222-222222222222"
	if _, _, err := f.store.BeginTransition(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ActivateCurrentTransition(ctx, &currentQualifierFixture{}); err == nil {
		t.Fatal("pending new WAL ignored")
	}
}

func TestCurrentNativeCloseUnknownNeverExposesApproval(t *testing.T) {
	f, _ := committedCurrentFixture(t)
	q := &currentQualifierFixture{witness: &currentWitnessFixture{closeErr: errors.New("disposable close refused")}}
	if _, err := f.store.ActivateCurrentTransition(context.Background(), q); err == nil {
		t.Fatal("unknown close activated")
	}
	if q.witness.closed != 1 || q.witness.checked != 1 {
		t.Fatal("numeric-fd Close retried or skipped")
	}
	if _, err := f.store.Status(context.Background()); err == nil {
		t.Fatal("poisoned current owner reopened")
	}
	if _, err := f.store.ActivateCurrentTransition(context.Background(), q); err == nil {
		t.Fatal("failed close tried a new activation")
	}
	if q.witness.closed != 1 {
		t.Fatal("retry close-effect")
	}
}

type blockingCurrentQualifier struct {
	started chan struct{}
	release chan struct{}
	witness *currentWitnessFixture
}

func (q *blockingCurrentQualifier) PrepareCurrent(context.Context, journal.Entry, authority.Approval) (CurrentWitness, error) {
	close(q.started)
	<-q.release
	return q.witness, nil
}

func TestCurrentPreparationDoesNotHoldStoreMutexAndStaleJournalRejects(t *testing.T) {
	f, r := committedCurrentFixture(t)
	ctx := context.Background()
	q := &blockingCurrentQualifier{started: make(chan struct{}), release: make(chan struct{}), witness: &currentWitnessFixture{}}
	result := make(chan error, 1)
	go func() { _, err := f.store.ActivateCurrentTransition(ctx, q); result <- err }()
	<-q.started
	// No Store mutex while preparing native/compatibility evidence. A newer
	// original durable WAL intent must invalidate this old qualification.
	second := r
	second.OperationID = "22222222-2222-4222-8222-222222222222"
	if _, _, err := f.store.BeginTransition(ctx, second); err != nil {
		t.Fatal(err)
	}
	close(q.release)
	if err := <-result; err == nil {
		t.Fatal("stale certificate activated")
	}
	if q.witness.checked != 0 || q.witness.closed != 1 {
		t.Fatal("stale held handles mishandled", q.witness)
	}
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("new unsettled WAL bypassed")
	}
}

func TestCurrentNativeBindingSurvivesOrdinaryParticipantAndPolicyMutation(t *testing.T) {
	f, original := committedCurrentFixture(t)
	ctx := context.Background()
	if _, err := f.store.ActivateCurrentTransition(ctx, &currentQualifierFixture{}); err != nil {
		t.Fatal(err)
	}
	originalTicket, err := f.store.CurrentContinuityStatus(ctx)
	if err != nil || originalTicket.OperationID != original.OperationID {
		t.Fatal("initial current admission", err)
	}
	// Real durable Store Admit/Revoke change revision/digest but not the
	// physically qualified root binding or original terminal certificate.
	admission := f.admission
	admission.ComputerGeneration = f.store.current.Generation
	p, err := f.store.Admit(ctx, f.store.current.Revision, admission, f.participant)
	if err != nil || p == nil {
		t.Fatal("lawful participant admission", err)
	}
	if _, err := f.store.Status(ctx); err != nil {
		t.Fatal("ordinary admission fenced current", err)
	}
	if err := f.store.RevokeParticipant(ctx, f.store.current.Revision, p.ParticipantID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Status(ctx); err != nil {
		t.Fatal("ordinary revocation fenced current", err)
	}
	newPolicy := f.store.current.Approval.Clone()
	newPolicy.Generation++
	newPolicy.Capabilities = []authority.Capability{authority.List}
	if err := f.store.UpdateApproval(ctx, f.store.current.Revision, newPolicy); err != nil {
		t.Fatal("normal owner policy change", err)
	}
	if _, err := f.store.Status(ctx); err != nil {
		t.Fatal("same-root authorized policy change fenced", err)
	}
	if out, err := f.store.CurrentContinuityStatus(ctx); err != nil || out.Generation != newPolicy.Generation || out.OperationID != original.OperationID {
		t.Fatal("historical certificate lost", err)
	}
	changed := newPolicy.Clone()
	changed.Generation++
	changed.Workspaces[0].RootIdentity.Device = "10000"
	if err := f.store.UpdateApproval(ctx, f.store.current.Revision, changed); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("unqualified later root change reused former native ticket")
	}
}
