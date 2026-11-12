package access

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	stop "github.com/legrch/farol/modules/computer/domain/journal"
	"golang.org/x/sys/unix"
)

// These are disposable real-store/on-disk fixtures. They do not exercise the
// native lifecycle owner, TS Settings writer, IPC, Darwin, or production boot.
func stopStoreRequest(f stateFixture, n int) stop.StopRequest {
	id := func(offset int) string {
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", n*10+offset)
	}
	return stop.StopRequest{
		OperationID: id(1), RequestDigest: strings.Repeat("a", 64),
		CommandKind: "computer.update-access", CommandDigest: strings.Repeat("b", 64),
		Purpose: "workspace-change", ProfileID: testBinding.ProfileID,
		OwnerID: testBinding.OwnerID, ComputerID: testBinding.ComputerID,
		WorkspaceID: "work", Root: f.workspace, ConsentDigest: strings.Repeat("c", 64),
		ExpectedRevision: "1", ComputerGeneration: "3", ConnectorGeneration: "2",
		SettingsDigest: strings.Repeat("d", 64),
		BootUUID:       "22222222-2222-4222-8222-222222222222",
		HostLifetimeID: "host", BackendGeneration: "backend", RuntimeID: "runtime",
		BuildID:      strings.Repeat("e", 64),
		StopEffectID: id(2), SettingsEffectID: id(3), CleanupEffectID: id(4),
	}
}
func admittedStop(t *testing.T, f stateFixture, n int) stop.StopRequest {
	t.Helper()
	r := stopStoreRequest(f, n)
	e, admitted, err := f.store.BeginStop(context.Background(), r)
	if err != nil || !admitted || e.Phase != stop.StopAdmissionIntent || e.Request != r {
		t.Fatalf("original Stop admission unconfirmed: %v", err)
	}
	return r
}

func TestStopStoreFreshWithoutWitnessLeavesOriginalApprovalGateUnchanged(t *testing.T) {
	f := fixtureState(t)
	s, err := f.store.StopStatus(context.Background())
	if err != nil || s.Present || s.Restricted || !s.Ledger.Valid() || len(s.Ledger.Entries) != 0 {
		t.Fatal("fresh empty Store invented Stop custody", err)
	}
	approve(t, f)
	if _, err := f.store.Status(context.Background()); err != nil {
		t.Fatal("fresh ordinary admission was blocked", err)
	}
}

func TestStopOriginalIntentBeforeEffectFencesCurrentAuthorityWithoutC4WAL(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r := admittedStop(t, f, 1)
	ctx := context.Background()
	if _, err := f.store.Status(ctx); err == nil {
		t.Fatal("pending Stop without C4 WAL disclosed approval")
	}
	c4, err := f.store.TransitionStatus(ctx)
	if err != nil || c4.Present || !c4.Restricted {
		t.Fatal("existing C4 status failed to reflect original prerequisite fence", err)
	}
	original, admitted, err := f.store.BeginStop(ctx, r)
	if err != nil || admitted || original.Phase != stop.StopAdmissionIntent {
		t.Fatal("duplicate granted another Stop", err)
	}
	second := stopStoreRequest(f, 2)
	if _, admitted, err = f.store.BeginStop(ctx, second); !errors.Is(err, stop.ErrStopPending) || admitted {
		t.Fatal("second parent crossed pending first Stop", err)
	}
	if _, admitted, err = f.store.BeginTransition(ctx, transitionIntent); err == nil || admitted {
		t.Fatal("unlinked C4 child crossed prerequisite admission")
	}
	lock, err := os.Stat(filepath.Join(f.root, lockName))
	if err != nil || lock.Size() != 0 {
		t.Fatal("C7 presence witness changed existing C4 one-byte lock format", err)
	}
}

func TestStopRestartWithLostStopAckNeverRedispatchesEvenWhenApprovalUnchanged(t *testing.T) {
	f := fixtureState(t)
	approve(t, f)
	r := admittedStop(t, f, 1)
	beforeDigest, beforeRevision := f.store.digest, f.store.current.Revision
	ctx := context.Background()
	entry, _ := f.store.stops.Find(r.OperationID)
	entry.Phase = stop.StopEffectIntent
	if err := f.store.AdvanceStop(ctx, r.OperationID, entry); err != nil {
		t.Fatal(err)
	}
	reopened := restored(t, f)
	state, err := reopened.StopStatus(ctx)
	if err != nil || !state.Restricted || state.Delivery != "not_recorded" ||
		state.Ledger.Entries[0].Phase != stop.StopEffectIntent {
		t.Fatal("restart lost original one-shot Stop intent", err)
	}
	if reopened.digest != beforeDigest || reopened.current.Revision != beforeRevision {
		t.Fatal("ordinary approval changed when Stop ACK was lost")
	}
	if _, first, err := reopened.BeginStop(ctx, stopStoreRequest(f, 2)); err == nil || first {
		t.Fatal("restart permitted a new parent Stop")
	}
	prior, first, err := reopened.BeginStop(ctx, r)
	if err != nil || first || prior.Phase != stop.StopEffectIntent {
		t.Fatal("same UUID was not observation-only", err)
	}
	if _, err := reopened.Status(ctx); err == nil {
		t.Fatal("restart made pending Stop into authority")
	}
}

func TestStopFirstPresenceUnknownDoesNotPermitMissingLedgerAsFresh(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	original := stopStoreRequest(f, 1)
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	if _, first, err := f.store.BeginStop(ctx, original); err == nil || first || !OutcomeUnknown(err) || f.store.activeStopID != "" {
		t.Fatal("lost first witness minted an original Stop right", err)
	}
	if _, _, err := f.store.BeginStop(ctx, original); err == nil {
		t.Fatal("poisoned original retried witness/Stop")
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(f.root, testBinding, f.clock); err == nil {
		s.Close()
		t.Fatal("first witness without ledger restored as fresh profile")
	}
}

func TestStopFirstLedgerUnknownRetainsOriginalAfterRestart(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	calls := 0
	f.store.disk.syncDirectory = func(fd int) error {
		calls++
		if calls == 2 {
			return unix.EIO
		}
		return unix.Fsync(fd)
	}
	if _, first, err := f.store.BeginStop(ctx, stopStoreRequest(f, 1)); err == nil || first || !OutcomeUnknown(err) || f.store.activeStopID != "" {
		t.Fatal("lost first ledger confirmation minted Stop dispatch", err)
	}
	if calls != 2 {
		t.Fatal("fixture did not reach the ledger publication boundary", calls)
	}
	reopened := restored(t, f)
	s, err := reopened.StopStatus(ctx)
	if err != nil || !s.Restricted || !s.Present || s.Ledger.Entries[0].Phase != stop.StopAdmissionIntent {
		t.Fatal("qualified restart lost original uncertain admission", err)
	}
	if _, admitted, err := reopened.BeginStop(ctx, stopStoreRequest(f, 2)); err == nil || admitted {
		t.Fatal("second UUID admitted after unknown first ledger publication", err)
	}
}

func TestStopUpdateUnknownAfterRenameRemainsPendingThroughReopen(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	r := admittedStop(t, f, 1)
	e, _ := f.store.stops.Find(r.OperationID)
	e.Phase = stop.StopEffectIntent
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	if err := f.store.AdvanceStop(ctx, r.OperationID, e); !OutcomeUnknown(err) {
		t.Fatal("possible Stop intent rename was reclassified as safe", err)
	}
	if err := f.store.AdvanceStop(ctx, r.OperationID, e); err == nil {
		t.Fatal("original unknown update retried")
	}
	reopened := restored(t, f)
	s, err := reopened.StopStatus(ctx)
	if err != nil || !s.Restricted || s.Ledger.Entries[0].Phase != stop.StopEffectIntent {
		t.Fatal("visible rename was not retained as original pending custody", err)
	}
}

func TestStopStrictRestoreRefusesMissingForeignAndMalformedWitnessOrLedger(t *testing.T) {
	for _, kind := range []string{
		"missing-ledger", "missing-witness", "ledger-schema", "ledger-extra",
		"ledger-duplicate", "ledger-trailing", "ledger-binding", "ledger-mode",
		"ledger-symlink", "witness-mode", "witness-corrupt", "witness-symlink",
	} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			admittedStop(t, f, 1)
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			ledger := filepath.Join(f.root, stopLedgerName)
			witness := filepath.Join(f.root, stopWitnessName)
			raw, err := os.ReadFile(ledger)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "missing-ledger":
				err = os.Remove(ledger)
			case "missing-witness":
				err = os.Remove(witness)
			case "ledger-schema":
				err = os.WriteFile(ledger, []byte(strings.Replace(string(raw), `"schema":1`, `"schema":2`, 1)), 0600)
			case "ledger-extra":
				err = os.WriteFile(ledger, []byte(strings.Replace(string(raw), `"schema":1`, `"schema":1,"extra":true`, 1)), 0600)
			case "ledger-duplicate":
				err = os.WriteFile(ledger, []byte(strings.Replace(string(raw), `"schema":1`, `"schema":1,"schema":1`, 1)), 0600)
			case "ledger-trailing":
				err = os.WriteFile(ledger, append(raw, []byte("{}")...), 0600)
			case "ledger-binding":
				err = os.WriteFile(ledger, []byte(strings.Replace(string(raw), testBinding.ProfileID, "foreign-profile", 1)), 0600)
			case "ledger-mode":
				err = os.Chmod(ledger, 0644)
			case "ledger-symlink":
				if err = os.Rename(ledger, filepath.Join(f.home, "old-ledger")); err == nil {
					err = os.Symlink(filepath.Join(f.home, "old-ledger"), ledger)
				}
			case "witness-mode":
				err = os.Chmod(witness, 0644)
			case "witness-corrupt":
				err = os.WriteFile(witness, []byte("X\n"), 0600)
			case "witness-symlink":
				if err = os.Rename(witness, filepath.Join(f.home, "old-witness")); err == nil {
					err = os.Symlink(filepath.Join(f.home, "old-witness"), witness)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			restored, err := Open(f.root, testBinding, f.clock)
			if restored != nil {
				restored.Close()
				t.Fatal("unsafe original Stop custody restored")
			}
			if err == nil {
				t.Fatal("missing or corrupt prerequisite became fresh authority")
			}
		})
	}
}

func TestStopLedgerCannotBePresentWithoutIndependentFirstWitness(t *testing.T) {
	f := fixtureState(t)
	raw, err := encodeStopLedger(testBinding, stop.StopLedger{Entries: []stop.StopEntry{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, stopLedgerName), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if restored, err := Open(f.root, testBinding, f.clock); err == nil {
		restored.Close()
		t.Fatal("unwitnessed foreign ledger adopted")
	}
}

func TestStopKnownPreDispatchRefusalAndBoundedTerminalSuccession(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	for n := 1; n <= stop.MaxStopEntries; n++ {
		r := admittedStop(t, f, n)
		if err := f.store.RefuseStopBeforeDispatch(ctx, r.OperationID); err != nil {
			t.Fatal(n, err)
		}
		s, err := f.store.StopStatus(ctx)
		if err != nil || s.Restricted || s.Ledger.Entries[n-1].Phase != stop.StopRefusedBeforeDispatch {
			t.Fatal(n, "known no-dispatch refusal stayed pending", err)
		}
		if _, err := f.store.Status(ctx); err != nil {
			t.Fatal(n, "ordinary next command was blocked", err)
		}
	}
	if _, admitted, err := f.store.BeginStop(ctx, stopStoreRequest(f, stop.MaxStopEntries+1)); !errors.Is(err, stop.ErrStopCapacity) || admitted {
		t.Fatal("capacity exhaustion evicted earlier original receipt", err)
	}
	reopened := restored(t, f)
	s, err := reopened.StopStatus(ctx)
	if err != nil || s.Restricted || len(s.Ledger.Entries) != stop.MaxStopEntries {
		t.Fatal("terminal history not retained after reopen", err)
	}
}

func TestStopCompletedWithOriginalACKsCannotBeRecastAsChildAdmission(t *testing.T) {
	f := fixtureState(t)
	r := admittedStop(t, f, 1)
	ctx := context.Background()
	// Simulate the protected original phase records only. No native/Settings
	// effect, real ACK or production linkage is asserted by this fixture.
	next, _ := f.store.stops.Find(r.OperationID)
	next.Phase = stop.StopComplete
	if err := f.store.AdvanceStop(ctx, r.OperationID, next); err == nil {
		t.Fatal("terminal certificate without effect ACKs was accepted")
	}
	if _, admitted, err := f.store.BeginTransition(ctx, transitionIntent); err == nil || admitted {
		t.Fatal("legacy C4 child bypassed original prerequisite")
	}
}

func TestStopConcurrentOriginalAdmissionHasOneWinningUUID(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	one, two := stopStoreRequest(f, 1), stopStoreRequest(f, 2)
	type outcome struct {
		id       string
		admitted bool
		err      error
	}
	result := make(chan outcome, 2)
	go func() {
		_, admitted, err := f.store.BeginStop(ctx, one)
		result <- outcome{one.OperationID, admitted, err}
	}()
	go func() {
		_, admitted, err := f.store.BeginStop(ctx, two)
		result <- outcome{two.OperationID, admitted, err}
	}()
	first, second := <-result, <-result
	if first.admitted == second.admitted || (first.admitted && first.err != nil) || (second.admitted && second.err != nil) {
		t.Fatalf("concurrent original claims were not exclusive: %+v %+v", first, second)
	}
	loser := first
	if first.admitted {
		loser = second
	}
	if !errors.Is(loser.err, stop.ErrStopPending) {
		t.Fatal("loser did not observe pending original custody", loser.err)
	}
	s, err := f.store.StopStatus(ctx)
	if err != nil || !s.Restricted || len(s.Ledger.Entries) != 1 {
		t.Fatal("concurrent admission created multiple original effects", err)
	}
}

func TestStopLedgerReadbackDetectsReplacedProtectedBytesBeforeDisclosure(t *testing.T) {
	f := fixtureState(t)
	admittedStop(t, f, 1)
	file := filepath.Join(f.root, stopLedgerName)
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, append(raw, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.StopStatus(context.Background()); err == nil {
		t.Fatal("cached original disclosure bypassed changed protected bytes")
	}
	if _, _, err := f.store.BeginStop(context.Background(), stopStoreRequest(f, 2)); err == nil {
		t.Fatal("poisoned owner performed new admission")
	}
}
