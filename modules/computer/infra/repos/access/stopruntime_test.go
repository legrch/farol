package access

import (
	"context"
	"errors"
	"testing"

	stop "github.com/legrch/farol/modules/computer/domain/journal"
	"golang.org/x/sys/unix"
)

// These real-Store fixtures prove runtime ownership without replaying a native
// Stop, Settings publication, or RPC. They do not qualify the production route.
func TestStopReopenedOriginalCannotAdvanceOrRefuseWithIdenticalApprovalBytes(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r := admittedStop(t, f, 1)
	originalDigest, originalRevision := f.store.digest, f.store.current.Revision
	reopened := restored(t, f)
	if f.store.activeStopID != "" {
		t.Fatal("retired Store retained an original lifetime right")
	}
	ctx := context.Background()
	if reopened.activeStopID != "" {
		t.Fatal("restoration minted original effect rights")
	}
	observed, first, err := reopened.BeginStop(ctx, r)
	if err != nil || first || observed.Phase != stop.StopAdmissionIntent ||
		reopened.activeStopID != "" {
		t.Fatal("same UUID observation minted a dispatch right", err)
	}
	original := observed.Clone()
	original.Phase = stop.StopEffectIntent
	if err := reopened.AdvanceStop(ctx, r.OperationID, original); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("reopened owner advanced original Stop", err)
	}
	if err := reopened.RefuseStopBeforeDispatch(ctx, r.OperationID); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("reopened owner fabricated no-dispatch proof", err)
	}
	if reopened.digest != originalDigest || reopened.current.Revision != originalRevision {
		t.Fatal("original approval changed instead of retaining custody")
	}
	state, err := reopened.StopStatus(ctx)
	if err != nil || !state.Restricted || len(state.Ledger.Entries) != 1 ||
		state.Ledger.Entries[0].Phase != stop.StopAdmissionIntent {
		t.Fatal("restored admission was lost after refused advancement", err)
	}
	if _, nextFirst, err := reopened.BeginStop(ctx, stopStoreRequest(f, 2)); !errors.Is(err, stop.ErrStopPending) || nextFirst {
		t.Fatal("new original admitted despite retained pending custody", err)
	}
}

func TestStopOnlyFreshFirstBeginGrantsRuntimeRightAndTerminalReleasesIt(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	r := admittedStop(t, f, 1)
	if f.store.activeStopID != r.OperationID {
		t.Fatal("confirmed first admission lacked original runtime right")
	}
	prior, first, err := f.store.BeginStop(ctx, r)
	if err != nil || first || prior.Phase != stop.StopAdmissionIntent ||
		f.store.activeStopID != r.OperationID {
		t.Fatal("repeat did not remain observation-only", err)
	}
	foreign := stopStoreRequest(f, 2)
	nextForeign := stop.StopEntry{Request: foreign, Phase: stop.StopEffectIntent}
	if err := f.store.AdvanceStop(ctx, foreign.OperationID, nextForeign); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("foreign UUID advanced original lifetime", err)
	}
	if err := f.store.RefuseStopBeforeDispatch(ctx, foreign.OperationID); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("foreign UUID supplied no-dispatch evidence", err)
	}
	if err := f.store.RefuseStopBeforeDispatch(ctx, r.OperationID); err != nil {
		t.Fatal("fresh original could not make known no-dispatch refusal", err)
	}
	if f.store.activeStopID != "" {
		t.Fatal("known-terminal refusal left an effect right")
	}
	seen, first, err := f.store.BeginStop(ctx, r)
	if err != nil || first || seen.Phase != stop.StopRefusedBeforeDispatch ||
		f.store.activeStopID != "" {
		t.Fatal("observing terminal history regenerated original runtime right", err)
	}
	fresh, first, err := f.store.BeginStop(ctx, foreign)
	if err != nil || !first || fresh.Phase != stop.StopAdmissionIntent ||
		f.store.activeStopID != foreign.OperationID {
		t.Fatal("known terminal did not permit an independent fresh parent", err)
	}
	if err := f.store.RefuseStopBeforeDispatch(ctx, r.OperationID); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("retired parent regained prior dispatch rights", err)
	}
	if err := f.store.RefuseStopBeforeDispatch(ctx, foreign.OperationID); err != nil ||
		f.store.activeStopID != "" {
		t.Fatal("second original did not settle its runtime right", err)
	}
}

func TestStopCancelledAdvanceBeforePublicationRevokesOriginalRuntimeRight(t *testing.T) {
	f := fixtureState(t)
	r := admittedStop(t, f, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	entry, _ := f.store.stops.Find(r.OperationID)
	entry.Phase = stop.StopEffectIntent
	if err := f.store.AdvanceStop(ctx, r.OperationID, entry); err == nil {
		t.Fatal("cancelled phase call was accepted")
	}
	if f.store.activeStopID != "" || !f.store.poisoned {
		t.Fatal("cancelled original retained transient effect rights")
	}
	reopened := restored(t, f)
	state, err := reopened.StopStatus(context.Background())
	if err != nil || !state.Restricted ||
		state.Ledger.Entries[0].Phase != stop.StopAdmissionIntent ||
		reopened.activeStopID != "" {
		t.Fatal("cancellation became replayable after restart", err)
	}
	if err := reopened.AdvanceStop(context.Background(), r.OperationID, entry); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("reopened cancelled parent advanced its old intent", err)
	}
}

func TestStopLateCancellationAfterPhasePublicationRevokesRightAndPreservesOriginal(t *testing.T) {
	f := fixtureState(t)
	r := admittedStop(t, f, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.store.disk.syncDirectory = func(fd int) error {
		if err := unix.Fsync(fd); err != nil {
			return err
		}
		cancel() // the original phase can become visible, but not a new permit
		return nil
	}
	entry, _ := f.store.stops.Find(r.OperationID)
	entry.Phase = stop.StopEffectIntent
	if err := f.store.AdvanceStop(ctx, r.OperationID, entry); !errors.Is(err, stop.ErrStopUnknown) {
		t.Fatal("late cancellation after original publication did not return unknown", err)
	}
	if f.store.activeStopID != "" || !f.store.poisoned {
		t.Fatal("late cancellation retained a usable runtime right")
	}
	reopened := restored(t, f)
	state, err := reopened.StopStatus(context.Background())
	if err != nil || !state.Restricted ||
		state.Ledger.Entries[0].Phase != stop.StopEffectIntent ||
		reopened.activeStopID != "" {
		t.Fatal("restart failed to retain the original effect intent", err)
	}
	if err := reopened.AdvanceStop(context.Background(), r.OperationID, entry); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("late-cancelled original was dispatched twice after reopen", err)
	}
	if _, first, err := reopened.BeginStop(context.Background(), r); err != nil || first {
		t.Fatal("observing cancelled original generated a new first permit", err)
	}
}

func TestStopUnknownPublicationRevokesRightWithoutReplayingAfterReopen(t *testing.T) {
	f := fixtureState(t)
	r := admittedStop(t, f, 1)
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	entry, _ := f.store.stops.Find(r.OperationID)
	entry.Phase = stop.StopEffectIntent
	if err := f.store.AdvanceStop(context.Background(), r.OperationID, entry); !OutcomeUnknown(err) {
		t.Fatal("possibly published original intent was not outcome-unknown", err)
	}
	if f.store.activeStopID != "" || !f.store.poisoned {
		t.Fatal("unknown persistence left a runtime dispatch right")
	}
	if err := f.store.AdvanceStop(context.Background(), r.OperationID, entry); err == nil {
		t.Fatal("unknown original was replayed in poisoned lifetime")
	}
	reopened := restored(t, f)
	state, err := reopened.StopStatus(context.Background())
	if err != nil || !state.Restricted ||
		state.Ledger.Entries[0].Phase != stop.StopEffectIntent ||
		reopened.activeStopID != "" {
		t.Fatal("reopen lost unknown original phase", err)
	}
	if err := reopened.RefuseStopBeforeDispatch(context.Background(), r.OperationID); !errors.Is(err, stop.ErrStopRefused) {
		t.Fatal("recovered uncertain Stop invented pre-dispatch refusal", err)
	}
}

func TestStopUnknownRefusalPublicationCannotRegrantOriginalRight(t *testing.T) {
	f := fixtureState(t)
	r := admittedStop(t, f, 1)
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	if err := f.store.RefuseStopBeforeDispatch(context.Background(), r.OperationID); !OutcomeUnknown(err) {
		t.Fatal("unconfirmed refusal publication was not unknown", err)
	}
	if f.store.activeStopID != "" || !f.store.poisoned {
		t.Fatal("unknown refusal retained the effect right")
	}
	if err := f.store.RefuseStopBeforeDispatch(context.Background(), r.OperationID); err == nil {
		t.Fatal("original refused again after uncertain publication")
	}
	reopened := restored(t, f)
	state, err := reopened.StopStatus(context.Background())
	if err != nil || state.Ledger.Entries[0].Phase != stop.StopRefusedBeforeDispatch ||
		reopened.activeStopID != "" {
		t.Fatal("restarted owner lost original known no-effect terminal bytes", err)
	}
	observed, first, err := reopened.BeginStop(context.Background(), r)
	if err != nil || first || observed.Phase != stop.StopRefusedBeforeDispatch ||
		reopened.activeStopID != "" {
		t.Fatal("a previously refused parent acquired a new runtime right", err)
	}
}
