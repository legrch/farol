package mutation

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Injected native and journal owners; no actual directory or runtime is created.
func TestOwnerScratchCreatesOnceAndObservesOriginalAfterRestart(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(map[bool]string{false: "completed", true: "unknown"}[interrupted], func(t *testing.T) {
			f := newOwnerFixture(t)
			f.selected.OperationID = "00000000-0000-4000-8000-000000000001"
			stage := &stagedTestNative{testNative: f.native}
			service, err := NewForOwnerExecution(context.Background(), f.selected, f.source, f.store, stage, ownerDigest{}, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			dir := state.DirectoryIdentity{Device: "7", Inode: "44"}
			f.native.run = func(_ context.Context, request port.MutationRequest) (*port.MutationReceipt, error) {
				r := &port.MutationReceipt{Operation: string(state.ScratchKind), RelativePath: request.Operation.Path(), Directory: dir}
				if interrupted {
					return r, errors.New("unconfirmed result")
				}
				return r, nil
			}
			first, err := service.CreateScratch(context.Background(), "work")
			if err != nil || first == nil || !first.Scratch.Valid() || first.Scratch.RunID != f.selected.OperationID {
				t.Fatalf("create: %#v %v", first, err)
			}
			want := string(state.Completed)
			if interrupted {
				want = string(state.OutcomeUnknown)
			}
			if first.Phase != want || f.native.calls != 1 || f.store.saves != 1 {
				t.Fatalf("unexpected original: %#v", first)
			}
			again, err := service.CreateScratch(context.Background(), "work")
			if err != nil || again.Phase != want || f.native.calls != 1 || f.store.saves != 1 {
				t.Fatalf("repeated: %#v %v", again, err)
			}
			observer, err := NewOwnerObserver(f.selected, f.store)
			if err != nil {
				t.Fatal(err)
			}
			observed, err := observer.Observe(context.Background(), OwnerObservation{WorkspaceID: "work", RelativePath: first.Scratch.Leaf})
			if err != nil || observed.Phase != want || observed.Scratch != first.Scratch || f.native.calls != 1 {
				t.Fatalf("readback: %#v %v", observed, err)
			}
			if interrupted && (observed.Failure == nil || observed.Failure.Directory != dir) {
				t.Fatal("unknown identity lost")
			}
		})
	}
}
