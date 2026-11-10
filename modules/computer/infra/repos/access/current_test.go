package access

import (
	"context"
	"errors"
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
