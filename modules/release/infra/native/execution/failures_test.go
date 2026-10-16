package execution

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/appidentity"
	"github.com/legrch/farol/modules/release/infra/native/apptree"
	"github.com/legrch/farol/modules/release/infra/native/installmove"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

func TestOpaqueFailuresNeverInheritNestedRefusal(t *testing.T) {
	f := newFixture(t)
	known := &port.HelperRecoveryFailure{Code: "path_type", Phase: "refused"}
	for _, cause := range []error{
		fmt.Errorf("opaque: %w", known), errors.Join(known, errors.New("cleanup")),
		errors.Join(context.Canceled, errors.New("unknown query outcome")),
		&port.HelperRecoveryFailure{Code: "private\nvalue", Phase: "refused"},
		&port.HelperRecoveryFailure{Code: "path_type", Phase: "private"},
		(*port.HelperRecoveryFailure)(nil),
	} {
		f.journal.read = func(context.Context) (*port.JournalView, error) { return nil, cause }
		err := f.with(context.Background(), func(r port.HelperRecoveryRuntime) error { _, err := r.ReadPhase(context.Background()); return err })
		var failure *port.HelperRecoveryFailure
		if !errors.As(err, &failure) || !failure.Internal || failure.Code != "internal" {
			t.Fatalf("opaque dependency downgraded: %#v", err)
		}
		if !errors.Is(err, cause) {
			t.Fatal("exact provenance lost")
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatal("private dependency leaked")
		}
	}
}
func TestInspectedRecordFailuresRemainKnown(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		cause error
		code  string
	}{{records.Invalid, "journal_invalid"}, {records.Oversized, "journal_invalid"}, {records.EncodingInvalid, "journal_invalid"}, {records.BindingMismatch, "journal_mismatch"}} {
		f.journal.read = func(context.Context) (*port.JournalView, error) { return nil, tc.cause }
		err := f.with(context.Background(), func(r port.HelperRecoveryRuntime) error { _, err := r.ReadPhase(context.Background()); return err })
		var failure *port.HelperRecoveryFailure
		if !errors.As(err, &failure) || failure.Internal || failure.Uncertain || failure.Code != tc.code || !errors.Is(err, tc.cause) {
			t.Fatal("record classification/provenance changed", err)
		}
	}
}
func TestNativeEntriesRetainMutationAndUnreadability(t *testing.T) {
	for _, kind := range []string{"replaced", "closed-parent"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			stage := filepath.Join(f.operation, "staged.app")
			must(t, os.Mkdir(stage, 0700))
			calls := 0
			f.config.Reverify = func(context.Context, port.HelperRequest) error {
				calls++
				// Initial With fence, then Entries fence, then its complete first scan.
				if calls == 3 {
					if kind == "replaced" {
						must(t, os.Rename(stage, stage+".preserved"))
						must(t, os.Mkdir(stage, 0700))
					} else {
						must(t, f.config.Files.Operation.Close())
					}
				}
				return nil
			}
			err := f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
				entries, err := r.Entries(context.Background())
				if entries != (port.HelperRecoveryEntries{}) {
					t.Fatal("failed scan returned partial entries")
				}
				return err
			})
			if err == nil {
				t.Fatal("changed/unreadable namespace accepted")
			}
			if kind == "replaced" {
				classified(t, err, "entry_replaced", false)
			}
		})
	}
}
func TestOriginalDeadlineAndAttemptAreNeverRenewed(t *testing.T) {
	f := newFixture(t)
	f.config.Until = time.Now().Add(40 * time.Millisecond)
	ctx := laggingContext{Context: context.Background(), until: f.config.Until}
	err := f.with(ctx, func(r port.HelperRecoveryRuntime) error {
		time.Sleep(time.Until(f.config.Until) + time.Millisecond)
		err := r.Rename(context.Background(), port.Staged, port.App, port.HelperIdentity{Device: "1", Inode: "2"})
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("fresh caller renewed original budget")
		}
		classified(t, r.Rename(context.Background(), port.Staged, port.App, port.HelperIdentity{Device: "1", Inode: "2"}), "recovery_attempt_unknown", true)
		return err
	})
	if err == nil || f.unknown == nil {
		t.Fatal("original consumed attempt/unknown not retained")
	}
}
func TestNativeExchangeReadsBackBothIdentities(t *testing.T) {
	f := newFixture(t)
	must(t, os.Mkdir(filepath.Join(f.apps, "Farol.app"), 0700))
	must(t, os.Mkdir(filepath.Join(f.operation, "previous.app"), 0700))
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		before, err := r.Entries(context.Background())
		must(t, err)
		err = r.Exchange(context.Background(), port.App, port.Previous, before.App.Identity, before.Previous.Identity)
		// Linux filesystems may lack exchange. The known refusal remains a
		// refusal, with zero claim of native qualification on that host.
		if e, ok := err.(*port.HelperRecoveryFailure); ok && e.Code == "exchange_unsupported" && !e.Internal && !e.Uncertain {
			t.Skip("native exchange unsupported")
		}
		must(t, err)
		after, err := r.Entries(context.Background())
		must(t, err)
		if after.App.Identity != before.Previous.Identity || after.Previous.Identity != before.App.Identity {
			t.Fatal("exchange identity readback differs")
		}
		return nil
	}))
}
func TestOnlyPureIdentityAndVerifierRefusalsCanBeNegative(t *testing.T) {
	for _, e := range []error{&appidentity.Error{Code: appidentity.Canceled}, &appidentity.Error{Code: appidentity.InvalidInput}, fmt.Errorf("opaque: %w", &appidentity.Error{Code: appidentity.BuildMismatch}), errors.Join(&apptree.Error{Code: apptree.CodeDigest}, errors.New("cleanup")), &installmove.Failure{Code: "source_replaced"}} {
		if pureIdentityRefusal(e) {
			t.Fatal("non-policy error accepted as identity refusal")
		}
	}
}

func TestProductionRenameRefusalOnUnsupportedHosts(t *testing.T) {
	if goruntime.GOOS == "darwin" {
		t.Skip("portable refusal requires a non-Darwin host; native Darwin success is tested separately")
	}
	f := newCompositionFixture(t)
	must(t, os.Mkdir(filepath.Join(f.path, "staged.app"), 0700))
	before := compositionSnapshot(t, f.root)
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		entries, err := r.Entries(context.Background())
		must(t, err)
		err = r.Rename(context.Background(), port.Staged, port.App, entries.Staged.Identity)
		classified(t, err, "rename_unsupported", false)
		var failure *port.HelperRecoveryFailure
		if !errors.As(err, &failure) || failure.Internal {
			t.Fatal("unsupported production rename classification changed")
		}
		return nil
	}))
	if f.owner.retained() != nil {
		t.Fatal("known unsupported call invented an effect")
	}
	f.unchanged(t, before)
}
