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

type fileCleanupStore struct {
	*cleanupStore
	record *state.ScratchFileCleanupState
}

func (s *fileCleanupStore) AdmitScratchFileCleanup(_ context.Context, r *state.ScratchFileCleanupState) (port.ScratchFileCleanupAdmission, error) {
	s.admissions++
	if s.admitErr != nil {
		return port.ScratchFileCleanupAdmission{}, s.admitErr
	}
	if s.record != nil {
		return port.ScratchFileCleanupAdmission{Status: port.MutationExisting, Record: s.record}, nil
	}
	s.record = r
	return port.ScratchFileCleanupAdmission{Status: port.MutationAdmitted, Record: r}, nil
}
func (s *fileCleanupStore) LoadScratchFileCleanup(_ context.Context, _ state.ScratchFileInventory) (*state.ScratchFileCleanupState, error) {
	return s.record, nil
}
func (s *fileCleanupStore) SaveScratchFileCleanup(_ context.Context, r *state.ScratchFileCleanupState) error {
	s.saves++
	if s.saveErr != nil {
		return s.saveErr
	}
	s.record = r
	return nil
}

type fileCleanupHold struct{ bad bool }

func (h *fileCleanupHold) Check(state.DirectoryIdentity) error {
	if h.bad {
		return errors.New("lost custody")
	}
	return nil
}
func (*fileCleanupHold) Close() error { return nil }

type fileCleanupNative struct {
	calls int
	err   error
}

func (n *fileCleanupNative) RemoveScratchFile(ctx context.Context, r port.ScratchFileCleanupRequest) error {
	n.calls++
	if n.err != nil {
		return n.err
	}
	if err := r.BeforePublish(ctx); err != nil {
		return err
	}
	return r.WithPublication(ctx, func() error { return nil })
}

func TestScratchFileCleanupOneAttempt(t *testing.T) {
	for _, mode := range []string{"completed", "refused", "unknown", "save lost", "admission lost", "existing prepared", "lost custody"} {
		t.Run(mode, func(t *testing.T) {
			f, old, _ := cleanupFixture(t)
			store := &fileCleanupStore{cleanupStore: old}
			var err error
			f.service, err = NewForOwnerExecution(context.Background(), f.selected, f.source, store, f.native, ownerDigest{}, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			b := state.Binding{Identity: state.Identity{Scope: state.ScopeConnector, OperationID: "file-op", OwnerID: f.selected.OwnerID, ProfileID: f.selected.ProfileID, ComputerID: f.selected.ComputerID}, ComputerGeneration: 7, WorkspaceID: "work", RelativePath: f.store.record.Binding().RelativePath + "/check.txt", RequestDigest: strings.Repeat("b", 64), Connector: state.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2, SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "call", TaskEpoch: 3, Generation: 4, Operation: state.WriteKind}}
			prepared, err := state.NewPrepared(b)
			if err != nil {
				t.Fatal(err)
			}
			file, err := prepared.Complete(state.Receipt{Operation: state.WriteKind, RelativePath: b.RelativePath, AfterSHA256: strings.Repeat("c", 64)})
			if err != nil {
				t.Fatal(err)
			}
			inventory, err := state.NewScratchFileInventory(f.store.record, file, state.DirectoryIdentity{Device: "7", Inode: "45"})
			if err != nil {
				t.Fatal(err)
			}
			dirHold, fileHold, native := &fileCleanupHold{}, &fileCleanupHold{}, &fileCleanupNative{}
			if mode == "refused" {
				native.err = authority.Fail("WORKSPACE_MUTATION_CONFLICT", "native-workspace")
			}
			if mode == "unknown" {
				native.err = errors.New("lost native outcome")
			}
			if mode == "save lost" {
				store.saveErr = errors.New("lost save")
			}
			if mode == "admission lost" {
				store.admitErr = errors.New("lost admission")
			}
			if mode == "existing prepared" {
				store.record, _ = state.RestoreScratchFileCleanup(*inventory, state.Prepared, nil)
			}
			if mode == "lost custody" {
				fileHold.bad = true
			}
			out, err := f.service.CleanupScratchFile(context.Background(), "work", *inventory, dirHold, fileHold, native)
			if mode == "admission lost" || mode == "lost custody" {
				if err == nil || out != nil {
					t.Fatal("expected refusal", out, err)
				}
			} else {
				if err != nil || out == nil {
					t.Fatal(out, err)
				}
				want := "completed"
				if mode == "refused" {
					want = "failed"
				}
				if mode == "unknown" || mode == "existing prepared" {
					want = "outcome_unknown"
				}
				if out.Phase != want || (mode == "save lost" && out.Publication != "memory_only") {
					t.Fatal("incorrect outcome", out)
				}
			}
			_, _ = f.service.CleanupScratchFile(context.Background(), "work", *inventory, dirHold, fileHold, native)
			wantCall := 1
			if mode == "admission lost" || mode == "existing prepared" || mode == "lost custody" {
				wantCall = 0
			}
			if native.calls != wantCall || store.admissions > 1 || store.saves > 1 {
				t.Fatal("repeated effect", native.calls, store.admissions, store.saves)
			}
			changed := *inventory
			changed.File.Inode = "46"
			_, err = f.service.CleanupScratchFile(context.Background(), "work", changed, dirHold, fileHold, native)
			requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
			_, err = f.service.CleanupScratch(context.Background(), "work", &cleanupNative{})
			requireCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT")
		})
	}
}
