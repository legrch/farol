package execution

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	stdruntime "runtime"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"github.com/legrch/farol/modules/release/infra/repos/rejection"
)

// Journal persistence and disposable filesystem observations are real. Rejection
// here is a symbolic port, not record durability or installation authority.
type rejectionFixture struct {
	calls    int
	expected port.HelperIdentity
	record   func(context.Context) error
}

func (f *rejectionFixture) Record(ctx context.Context, expected port.HelperIdentity) error {
	f.calls++
	f.expected = expected
	if f.record != nil {
		return f.record(ctx)
	}
	return nil
}

func installationFixture(t *testing.T) (*compositionFixture, *rejectionFixture) {
	t.Helper()
	f := newCompositionFixture(t)
	rejection := &rejectionFixture{}
	f.config.Rejection = rejection
	return f, rejection
}
func installScope(f *compositionFixture, ctx context.Context, fn func(port.HelperInstallationRuntime) error) error {
	return withInstallation(ctx, f.config, func(ctx context.Context) error { return ctx.Err() }, fn)
}

func TestPrepareCreatesOnlyOriginalAbsentJournalAndAllowsFollowingPhase(t *testing.T) {
	f, rejection := installationFixture(t)
	var escaped port.HelperInstallationRuntime
	err := installScope(f, context.Background(), func(native port.HelperInstallationRuntime) error {
		escaped = native
		if err := native.Prepare(context.Background()); err != nil {
			return err
		}
		f.physical(t, f.repo, "prepared")
		return native.WritePhase(context.Background(), "new_installed")
	})
	must(t, err)
	f.physical(t, f.repo, "new_installed")
	f.borrowed(t)
	if rejection.calls != 0 || f.owner.retained() != nil {
		t.Fatal("preparation invoked rejection or retained a completed write")
	}
	classified(t, escaped.Prepare(context.Background()), "runtime_closed", false)
	f.physical(t, f.repo, "new_installed")
}

func TestPrepareNeverAdoptsExistingOrInvalidJournal(t *testing.T) {
	for _, kind := range []string{"matching", "different", "invalid", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			f, rejection := installationFixture(t)
			data := f.encoded(t, "prepared")
			code := "operation_exists"
			switch kind {
			case "different":
				data = f.encoded(t, "completed")
			case "invalid":
				data, code = []byte("invalid persisted bytes"), "journal_invalid"
			case "oversized":
				data, code = make([]byte, 8193), "journal_invalid"
			}
			f.put(t, data)
			err := installScope(f, context.Background(), func(native port.HelperInstallationRuntime) error {
				return native.Prepare(context.Background())
			})
			classified(t, err, code, false)
			after, err := os.ReadFile(filepath.Join(f.path, "journal.json"))
			must(t, err)
			if string(after) != string(data) || f.owner.retained() != nil || rejection.calls != 0 {
				t.Fatal("existing journal adopted, modified or classified as a write")
			}
		})
	}
}

func TestPrepareFinalFenceCannotClearConfirmedPersistence(t *testing.T) {
	f, _ := installationFixture(t)
	cause := &port.HelperRecoveryFailure{Code: "slot_changed", Phase: "refused"}
	original := f.config.Reverify
	f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
		if err := original(ctx, request); err != nil {
			return err
		}
		if _, err := os.Stat(filepath.Join(f.path, "journal.json")); err == nil {
			return cause
		}
		return nil
	}
	err := installScope(f, context.Background(), func(native port.HelperInstallationRuntime) error {
		return native.Prepare(context.Background())
	})
	classified(t, err, "slot_changed", true)
	if !errors.Is(err, cause) || f.owner.retained() == nil {
		t.Fatal("post-write refusal lost persistence or original cause")
	}
	f.physical(t, f.repo, "prepared")
	called := false
	err = installScope(f, context.Background(), func(port.HelperInstallationRuntime) error { called = true; return nil })
	classified(t, err, "recovery_attempt_unknown", true)
	if called {
		t.Fatal("fresh runtime cleared original owner unknown")
	}
}

func TestInstallationScopeRequiresRepositoryAndActualRouteBorrow(t *testing.T) {
	f := newCompositionFixture(t)
	called := false
	err := WithInstallation(context.Background(), f.config, func(port.HelperInstallationRuntime) error { called = true; return nil })
	classified(t, err, "internal", false)
	rejection := &rejectionFixture{}
	f.config.Rejection = rejection
	err = WithInstallation(context.Background(), f.config, func(port.HelperInstallationRuntime) error { called = true; return nil })
	if err == nil || called || rejection.calls != 0 {
		t.Fatal("raw descriptors or missing repository supplied installation authority")
	}
	view, err := f.repo.Read(context.Background())
	must(t, err)
	if view == nil || view.Value != nil || f.owner.retained() != nil {
		t.Fatal("refused scope changed original journal owner")
	}
	f.borrowed(t)
}

func TestRejectedTargetUsesCapturedPortOnceAndRetainsLaterFailure(t *testing.T) {
	for _, kind := range []string{"complete", "repeat", "canceled", "opaque", "callback", "final-fence"} {
		t.Run(kind, func(t *testing.T) {
			f, rejection := installationFixture(t)
			expected := port.HelperIdentity{Device: "1", Inode: "42"}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			cause := errors.New("symbolic record result lost")
			if kind == "canceled" {
				cancel()
			}
			if kind == "opaque" {
				rejection.record = func(context.Context) error { return cause }
			}
			if kind == "final-fence" {
				original := f.config.Reverify
				f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
					if rejection.calls != 0 {
						return &port.HelperRecoveryFailure{Code: "lease_changed", Phase: "refused", Cause: cause}
					}
					return original(ctx, request)
				}
			}
			err := installScope(f, context.Background(), func(native port.HelperInstallationRuntime) error {
				err := native.RejectTarget(ctx, expected)
				if err != nil {
					return err
				}
				if kind == "repeat" {
					return native.RejectTarget(context.Background(), expected)
				}
				if kind == "callback" {
					return cause
				}
				return nil
			})
			if kind == "complete" {
				must(t, err)
			} else if err == nil {
				t.Fatal("incomplete rejection returned success")
			}
			unknown := kind != "complete" && kind != "canceled"
			if (f.owner.retained() != nil) != unknown || rejection.calls != map[bool]int{true: 0, false: 1}[kind == "canceled"] {
				t.Fatal("record attempt or original-owner retention differs")
			}
			if kind != "canceled" && rejection.expected != expected {
				t.Fatal("fixed failed-tree comparison identity changed")
			}
			if kind == "opaque" || kind == "callback" || kind == "final-fence" {
				if !errors.Is(err, cause) {
					t.Fatal("record/callback/fence cause lost")
				}
			}
			f.borrowed(t)
		})
	}
}

func TestInstallationComposesActualJournalAndRejectionWithSameOwner(t *testing.T) {
	if stdruntime.GOOS != "darwin" {
		t.Skip("actual rejection publication is Darwin-only; Linux production refuses")
	}
	for _, finalRefusal := range []bool{false, true} {
		t.Run(map[bool]string{false: "completed-record", true: "post-record-fence"}[finalRefusal], func(t *testing.T) {
			f := newCompositionFixture(t)
			failed := filepath.Join(f.path, "failed.app")
			must(t, os.Mkdir(failed, 0755))
			must(t, os.WriteFile(filepath.Join(failed, "unverified-target"), []byte("not an accepted app tree"), 0600))
			file, err := os.Open(failed)
			must(t, err)
			identity := compositionIdentity(t, file)
			must(t, file.Close())
			expected := port.HelperIdentity{Device: identity.Device, Inode: identity.Inode}
			repo, err := rejection.New(context.Background(), f.config.Files.Operation, f.owner.directory, operation(f.config.Request), f.owner, f.config.Until)
			must(t, err)
			t.Cleanup(func() { must(t, repo.Close()) })
			f.config.Rejection = repo
			cause := &port.HelperRecoveryFailure{Code: "slot_changed", Phase: "refused"}
			original := f.config.Reverify
			f.config.Reverify = func(ctx context.Context, request port.HelperRequest) error {
				if err := original(ctx, request); err != nil {
					return err
				}
				if _, err := os.Stat(filepath.Join(f.path, "rejected-target.json")); err == nil && finalRefusal {
					return cause
				}
				return nil
			}
			err = installScope(f, context.Background(), func(native port.HelperInstallationRuntime) error {
				if err := native.Prepare(context.Background()); err != nil {
					return err
				}
				return native.RejectTarget(context.Background(), expected)
			})
			if finalRefusal {
				classified(t, err, "slot_changed", true)
				if !errors.Is(err, cause) || f.owner.retained() == nil {
					t.Fatal("actual record acknowledgement lost original-owner uncertainty")
				}
			} else {
				must(t, err)
				if f.owner.retained() != nil {
					t.Fatal("completed persistence manufactured uncertainty")
				}
			}
			// This is native repository composition, not apply/rollback policy:
			// no tree is attested or exchanged and no terminal phase is invented.
			view := f.physical(t, f.repo, "prepared")
			data, err := os.ReadFile(filepath.Join(f.path, "rejected-target.json"))
			must(t, err)
			value, err := records.DecodeRejectedTarget(data, f.record("prepared").Operation)
			must(t, err)
			if value.Device != expected.Device || value.Inode != expected.Inode {
				t.Fatal("record does not bind the actual failed directory")
			}
			if finalRefusal {
				_, err = f.repo.CompareAndSwap(context.Background(), view.Revision, *view.Value)
				if !errors.Is(err, port.JournalUnknown) {
					t.Fatal("same journal owner cleared post-record uncertainty")
				}
			}
			f.borrowed(t)
		})
	}
}

// The predecessor at dee61f94 reads a strict /1 journal without a note field.
// Exercise actual journal persistence, including all source launch/rollback and
// interrupted phases that an old app can encounter. This is schema compatibility,
// not an installed predecessor startup or receipt reconciliation witness.
func TestQuitDiagnosticKeepsEveryJournalPhasePredecessorCompatible(t *testing.T) {
	f, _ := installationFixture(t)
	f.config.QuitNote = "predecessor_drain_unconfirmed"
	phases := []string{}
	f.config.PhaseLog = func(phase, code string) { phases = append(phases, phase+":"+code) }
	err := installScope(f, context.Background(), func(native port.HelperInstallationRuntime) error {
		if err := native.Prepare(context.Background()); err != nil {
			return err
		}
		requirePredecessorCompatibleJournal(t, f.path, "prepared")
		for _, phase := range []string{"predecessor_saved", "new_installed", "verified", "launch_requested", "completed", "rollback_started", "rolled_back", "rollback_launch_requested", "rollback_completed", "cancelled", "cancel_launch_requested", "cancel_completed"} {
			if err := native.WritePhase(context.Background(), phase); err != nil {
				return err
			}
			requirePredecessorCompatibleJournal(t, f.path, phase)
		}
		return nil
	})
	must(t, err)
	if len(phases) != 13 || phases[0] != "prepared:predecessor_drain_unconfirmed" {
		t.Fatal("drain note was not preserved in diagnostics", phases)
	}
}

func requirePredecessorCompatibleJournal(t *testing.T, root, phase string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "journal.json"))
	must(t, err)
	var predecessor struct {
		Schema string `json:"schema"`
		records.Operation
		Phase string `json:"phase"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&predecessor); err != nil {
		t.Fatalf("%s cannot be read by the strict predecessor: %v", phase, err)
	}
	if predecessor.Phase != phase || predecessor.Schema != "farol.installed-update-journal/1" {
		t.Fatal(predecessor)
	}
}
