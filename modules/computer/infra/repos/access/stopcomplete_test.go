package access

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	stop "github.com/legrch/farol/modules/computer/domain/journal"
	"golang.org/x/sys/unix"
)

// The receipts in this test are controlled Go fixtures, not actual native or
// ProductSettings effects. It checks protected phase publication and retention.
func TestStopFullKnownPhaseHistoryRestoresAndAllowsOrdinaryNextParent(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	r := admittedStop(t, f, 1)
	entry, _ := f.store.stops.Find(r.OperationID)
	advance := func(phase stop.StopPhase) {
		t.Helper()
		entry.Phase = phase
		if err := f.store.AdvanceStop(ctx, r.OperationID, entry); err != nil {
			t.Fatal(phase, err)
		}
	}
	advance(stop.StopEffectIntent)
	entry.Closure = &stop.StopClosure{
		EffectID: r.StopEffectID, BackendGeneration: r.BackendGeneration,
		RuntimeID: r.RuntimeID, LifecycleID: "33333333-3333-4333-8333-333333333333",
		StopRevision: "1", PreparationRevision: "0",
		ClosureOperationID: "44444444-4444-4444-8444-444444444444",
		ClosureDigest:      strings.Repeat("f", 64),
	}
	advance(stop.StopAcknowledged)
	entry.SettingsIntent = &stop.StopSettingsPlan{
		EffectID: r.SettingsEffectID, ExpectedRevision: r.ExpectedRevision,
		ExpectedDigest: r.SettingsDigest, NextRevision: "2", NextDigest: strings.Repeat("1", 64),
		ComputerGeneration: r.ComputerGeneration, ConnectorGeneration: r.ConnectorGeneration,
		ConsentDigest: r.ConsentDigest,
	}
	advance(stop.StoppedSettingsIntent)
	entry.SettingsAck = &stop.StopSettingsReceipt{
		EffectID: r.SettingsEffectID, Revision: "2",
		DocumentDigest: strings.Repeat("1", 64), ComputerGeneration: r.ComputerGeneration,
		ConnectorGeneration: r.ConnectorGeneration, ConsentDigest: r.ConsentDigest,
	}
	advance(stop.StoppedSettingsAcknowledged)
	advance(stop.StopCleanupIntent)
	entry.CleanupAck = &stop.StopCleanupReceipt{
		EffectID: r.CleanupEffectID, BackendGeneration: r.BackendGeneration,
		RuntimeID: r.RuntimeID, Digest: strings.Repeat("2", 64),
	}
	advance(stop.StopCleanupAcknowledged)
	advance(stop.StopComplete)
	if f.store.activeStopID != "" {
		t.Fatal("known complete chain retained native Stop advancement rights")
	}
	s, err := f.store.StopStatus(ctx)
	if err != nil || s.Restricted || s.Delivery != "not_recorded" {
		t.Fatal("complete historical record was not settled custody", err)
	}
	certificate, err := s.Ledger.Entries[0].Certificate()
	if err != nil || certificate.Request != r ||
		certificate.Closure != *entry.Closure ||
		certificate.Settings != *entry.SettingsAck ||
		certificate.Cleanup != *entry.CleanupAck {
		t.Fatal("original receipts were not retained", err)
	}
	// Even after every original ACK, old schema-1 C4 Begin cannot consume
	// a C7 parent without the accepted schema-2 single-WAL certificate link.
	if _, admitted, err := f.store.BeginTransition(ctx, transitionIntent); err == nil || admitted {
		t.Fatal("known terminal Stop became unlinked C4 child permission")
	}
	next := stopStoreRequest(f, 2)
	if _, first, err := f.store.BeginStop(ctx, next); err != nil || !first ||
		f.store.activeStopID != next.OperationID {
		t.Fatal("known-terminal record permanently blocked an ordinary next command", err)
	}
	reopened := restored(t, f)
	s, err = reopened.StopStatus(ctx)
	if err != nil || reopened.activeStopID != "" || !s.Restricted || len(s.Ledger.Entries) != 2 ||
		s.Ledger.Entries[0].Phase != stop.StopComplete || s.Ledger.Entries[1].Phase != stop.StopAdmissionIntent {
		t.Fatal("reopen lost terminal history or pending next operation", err)
	}
	if _, admitted, err := reopened.BeginTransition(ctx, transitionIntent); err == nil || admitted {
		t.Fatal("unlinked C4 child consumed an original certificate")
	}
}

func TestStopRestoreRequiresExactCurrentFileAndDirectorySync(t *testing.T) {
	for _, kind := range []string{"stop-file-sync", "stop-directory-sync"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			admittedStop(t, f, 1)
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			fileSyncs, directorySyncs := 0, 0
			factory := func(root string) (*disk, error) {
				d, err := openDisk(root)
				if err != nil {
					return nil, err
				}
				d.syncSnapshot = func(fd int) error {
					fileSyncs++
					if kind == "stop-file-sync" && fileSyncs == 2 {
						return unix.EIO
					}
					return unix.Fsync(fd)
				}
				d.syncDirectory = func(fd int) error {
					directorySyncs++
					if kind == "stop-directory-sync" && directorySyncs == 2 {
						return unix.EIO
					}
					return unix.Fsync(fd)
				}
				return d, nil
			}
			reopened, err := openWithDisk(f.root, testBinding, f.clock, false, factory)
			if reopened != nil {
				reopened.Close()
				t.Fatal("failed stop qualification returned usable authority")
			}
			if err == nil || fileSyncs < 1 || directorySyncs < 1 {
				t.Fatal("restore did not reject original stop durability fault", err)
			}
		})
	}
}

func TestStopWitnessAndLedgerHardlinksNeverQualify(t *testing.T) {
	for _, target := range []string{stopWitnessName, stopLedgerName} {
		t.Run(target, func(t *testing.T) {
			f := fixtureState(t)
			admittedStop(t, f, 1)
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(filepath.Join(f.root, target), filepath.Join(f.home, "alias")); err != nil {
				t.Fatal(err)
			}
			if restored, err := Open(f.root, testBinding, f.clock); err == nil {
				restored.Close()
				t.Fatal("a hardlinked protected custody record was accepted")
			}
		})
	}
}

func TestStopLateContextCancellationAfterDurableAdmissionNeverGivesDispatch(t *testing.T) {
	f := fixtureState(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	syncs := 0
	f.store.disk.syncDirectory = func(fd int) error {
		syncs++
		if err := unix.Fsync(fd); err != nil {
			return err
		}
		if syncs == 2 {
			cancel() // first witness is durable; original ledger now exists
		}
		return nil
	}
	_, allowed, err := f.store.BeginStop(ctx, stopStoreRequest(f, 1))
	if allowed || f.store.activeStopID != "" || !errors.Is(err, stop.ErrStopUnknown) || syncs < 2 {
		t.Fatal("late cancellation returned an original Stop effect permit", err)
	}
	if _, _, err := f.store.BeginStop(context.Background(), stopStoreRequest(f, 1)); err == nil {
		t.Fatal("poisoned original retried after cancellation")
	}
	reopened := restored(t, f)
	status, err := reopened.StopStatus(context.Background())
	if err != nil || !status.Restricted || status.Ledger.Entries[0].Phase != stop.StopAdmissionIntent {
		t.Fatal("late cancelled admission lost restrictive custody", err)
	}
}
