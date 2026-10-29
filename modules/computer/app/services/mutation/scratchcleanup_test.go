package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type cleanupStore struct {
	*testStore
	cleanup           *state.ScratchCleanupState
	admissions, saves int
	admitErr, saveErr error
	admitHook         func()
}

func (s *cleanupStore) AdmitScratchCleanup(_ context.Context, r *state.ScratchCleanupState) (port.ScratchCleanupAdmission, error) {
	s.admissions++
	if s.admitHook != nil {
		s.admitHook()
	}
	if s.admitErr != nil {
		return port.ScratchCleanupAdmission{}, s.admitErr
	}
	if s.cleanup != nil {
		return port.ScratchCleanupAdmission{Status: port.MutationExisting, Record: s.cleanup}, nil
	}
	s.cleanup = r
	return port.ScratchCleanupAdmission{Status: port.MutationAdmitted, Record: r}, nil
}
func (s *cleanupStore) LoadScratchCleanup(_ context.Context, _ state.ScratchCleanupBinding) (*state.ScratchCleanupState, error) {
	return s.cleanup, nil
}
func (s *cleanupStore) SaveScratchCleanup(_ context.Context, r *state.ScratchCleanupState) error {
	s.saves++
	if s.saveErr != nil {
		return s.saveErr
	}
	s.cleanup = r
	return nil
}

type cleanupNative struct {
	calls int
	run   func(context.Context, port.ScratchCleanupRequest) error
}

func (n *cleanupNative) RemoveEmptyScratch(ctx context.Context, r port.ScratchCleanupRequest) error {
	n.calls++
	if n.run != nil {
		return n.run(ctx, r)
	}
	if err := r.BeforePublish(ctx); err != nil {
		return err
	}
	return r.WithPublication(ctx, func() error { return nil })
}

func cleanupFixture(t *testing.T) (ownerFixture, *cleanupStore, *cleanupNative) {
	t.Helper()
	f := newOwnerFixture(t)
	f.selected.OperationID = "00000000-0000-4000-8000-000000000001"
	leaf := state.ScratchPath(f.selected.OperationID)
	b := state.Binding{Identity: f.selected.identity(), WorkspaceID: "work", ComputerGeneration: 7, RelativePath: leaf, RequestDigest: strings.Repeat("a", 64), Scratch: state.ScratchBinding{RunID: f.selected.OperationID, Root: "/work", Leaf: leaf, RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}}
	p, err := state.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	f.store.record, err = p.Complete(state.Receipt{Operation: state.ScratchKind, RelativePath: leaf, Directory: state.DirectoryIdentity{Device: "7", Inode: "44"}})
	if err != nil {
		t.Fatal(err)
	}
	store := &cleanupStore{testStore: f.store}
	f.service, err = NewForOwnerExecution(context.Background(), f.selected, f.source, store, f.native, ownerDigest{}, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	return f, store, &cleanupNative{}
}

func TestScratchCleanupOneAttemptAndStoredObservation(t *testing.T) {
	for _, mode := range []string{"completed", "refused", "unknown", "save lost", "admission lost", "existing prepared"} {
		t.Run(mode, func(t *testing.T) {
			f, store, native := cleanupFixture(t)
			if mode == "refused" {
				native.run = func(context.Context, port.ScratchCleanupRequest) error {
					return authority.Fail("WORKSPACE_MUTATION_CONFLICT", "native-workspace")
				}
			}
			if mode == "unknown" {
				native.run = func(context.Context, port.ScratchCleanupRequest) error { return errors.New("lost native outcome") }
			}
			if mode == "save lost" {
				store.saveErr = errors.New("lost save acknowledgement")
			}
			if mode == "admission lost" {
				store.admitErr = errors.New("lost admission acknowledgement")
			}
			if mode == "existing prepared" {
				store.cleanup, _ = state.NewScratchCleanup(f.store.record)
			}
			out, err := f.service.CleanupScratch(context.Background(), "work", native)
			if mode == "admission lost" {
				requireCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			} else {
				if err != nil || out == nil {
					t.Fatalf("result %#v %v", out, err)
				}
				want := "completed"
				if mode == "refused" {
					want = "failed"
				}
				if mode == "unknown" || mode == "existing prepared" {
					want = "outcome_unknown"
				}
				if out.Phase != want {
					t.Fatalf("phase %#v", out)
				}
				if mode == "save lost" && out.Publication != "memory_only" {
					t.Fatal("lost save reported durable")
				}
			}
			_, _ = f.service.CleanupScratch(context.Background(), "work", native)
			wantNative, wantSave := 1, 1
			if mode == "admission lost" || mode == "existing prepared" {
				wantNative, wantSave = 0, 0
			}
			if store.admissions != 1 || store.saves != wantSave || native.calls != wantNative {
				t.Fatalf("repeated cleanup: admissions %d saves %d calls %d", store.admissions, store.saves, native.calls)
			}
			_, err = f.service.CleanupScratch(context.Background(), "other", native)
			requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
			if mode == "save lost" || mode == "existing prepared" || mode == "completed" {
				restarted, e := NewForOwnerExecution(context.Background(), f.selected, f.source, store, f.native, ownerDigest{}, &sync.Mutex{}, f.clock)
				if e != nil {
					t.Fatal(e)
				}
				observed, e := restarted.CleanupScratch(context.Background(), "work", native)
				if e != nil || observed == nil || (mode != "completed" && observed.Phase != "outcome_unknown") || native.calls != wantNative || store.saves != wantSave {
					t.Fatalf("restarted %#v %v", observed, e)
				}
			}
		})
	}
}

func TestScratchCleanupRechecksOwnerAndExcludesConcurrentAttempt(t *testing.T) {
	f, store, native := cleanupFixture(t)
	native.run = func(ctx context.Context, r port.ScratchCleanupRequest) error {
		_, err := f.service.CleanupScratch(ctx, "work", native)
		requireCode(t, err, "COMPUTER_MUTATION_IN_PROGRESS")
		f.source.approval.Generation++
		return r.BeforePublish(ctx)
	}
	out, err := f.service.CleanupScratch(context.Background(), "work", native)
	if err != nil || out.Phase != "failed" || store.saves != 1 || native.calls != 1 {
		t.Fatalf("result %#v %v", out, err)
	}
}

func TestScratchCleanupRejectsUnconfirmedCreationAndChangedRoot(t *testing.T) {
	for _, mode := range []string{"prepared", "unknown", "root changed", "revoked after admission"} {
		t.Run(mode, func(t *testing.T) {
			f, store, native := cleanupFixture(t)
			if mode == "prepared" || mode == "unknown" {
				original := f.store.record.Binding()
				f.store.record, _ = state.NewPrepared(original)
				if mode == "unknown" {
					f.store.record, _ = f.store.record.Refuse(state.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
				}
			}
			if mode == "root changed" {
				f.source.approval.Workspaces[0].RootIdentity.Inode = "3"
			}
			if mode == "revoked after admission" {
				store.admitHook = func() { f.source.approval.Generation++ }
			}
			out, err := f.service.CleanupScratch(context.Background(), "work", native)
			if mode == "revoked after admission" {
				if err != nil || out == nil || out.Phase != "failed" || store.saves != 1 {
					t.Fatalf("result %#v %v", out, err)
				}
			} else if err == nil {
				t.Fatalf("invalid creation or authority accepted: %#v", out)
			}
			if native.calls != 0 {
				t.Fatal("cleanup executed without current authority and completed creation")
			}
			if mode != "revoked after admission" && store.admissions != 0 {
				t.Fatal("unauthorized admission")
			}
		})
	}
}
