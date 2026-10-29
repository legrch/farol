//go:build darwin

package boot

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Actual native profile, owner approval, journal, staging descriptor and
// filesystem publication in a disposable fixture. No Shell, UI or provider.
func TestNativeScratchOwnerPublishesOnceAndObservesAfterReopen(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	runtime.mutations.recoveryReserved = true
	if result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || result != nil || runtime.mutations.operations[id] != nil {
		t.Fatal("recovery reservation admitted scratch")
	}
	runtime.mutations.recoveryReserved = false
	// A prior unconfirmed attempt must not admit another filesystem effect.
	runtime.mutations.operations["earlier"] = &settingsMutationOperation{stageScratch: true, pending: true}
	if result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || result != nil || runtime.mutations.operations[id] != nil {
		t.Fatal("unconfirmed previous operation admitted a scratch attempt")
	}
	delete(runtime.mutations.operations, "earlier") // Only the test's synthetic ledger entry.
	result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication)
	if err != nil || result == nil || result.Phase != string(state.Completed) || result.Publication != "durable" || result.Receipt == nil || !result.Receipt.Directory.Valid() {
		t.Fatalf("scratch: %#v %v ledger-entries=%d scratch-admitted=%v", result, err, len(runtime.mutations.operations), runtime.mutations.operations[id] != nil)
	}
	if _, err := os.Stat(filepath.Join(workspace, result.Scratch.Leaf)); err != nil {
		t.Fatal(err)
	}
	if repeated, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || repeated != nil {
		t.Fatal("original operation repeated")
	}
	if _, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, "another-workspace", result.ComputerGeneration); err == nil {
		t.Fatal("observation accepted a different workspace")
	}
	if _, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration+1); err == nil {
		t.Fatal("observation accepted a different generation")
	}
	observed, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || observed.Phase != result.Phase || observed.Scratch != result.Scratch || observed.Receipt.Directory != result.Receipt.Directory {
		t.Fatalf("original observation: %#v %v", observed, err)
	}
	terminal := preparedTerminal(t, runtime)
	if err := recordNativeTerminal(context.Background(), launch.Profile, terminal, func(_ wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode = "open"
	launch.HostLifetimeID, launch.ChildLaunchID = "host-2", "child-2"
	launch.PreviousHostDrainConfirmed = true
	next, err := NewNativeRuntime(context.Background(), launch, "generation-2")
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	observed, err = next.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || observed.Phase != result.Phase || observed.Scratch != result.Scratch || observed.Receipt.Directory != result.Receipt.Directory {
		t.Fatalf("reopened observation: %#v %v", observed, err)
	}
	if repeated, err := next.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || repeated != nil {
		t.Fatal("reopened runtime repeated the original operation")
	}
	after, err := next.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || after == nil || after.Scratch != result.Scratch || after.Receipt == nil || after.Receipt.Directory != result.Receipt.Directory {
		t.Fatalf("original record changed after refused replay: %#v %v", after, err)
	}
}
