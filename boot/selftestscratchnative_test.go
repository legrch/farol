//go:build darwin

package boot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

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
	runtime.mutations.computer.effects.Lock()
	refused := make(chan bool, 1)
	go func() {
		result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication)
		refused <- err != nil && result == nil
	}()
	select {
	case ok := <-refused:
		runtime.mutations.computer.effects.Unlock()
		if !ok || runtime.mutations.operations[id] != nil {
			t.Fatal("recovery reservation admitted scratch")
		}
	case <-time.After(time.Second):
		runtime.mutations.computer.effects.Unlock()
		<-refused
		t.Fatal("scratch waited on recovery effects")
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

// A whole-run reservation stays held after the native creation receipt. This
// fixture contains no Shell and is removed only by its disposable test owner.
func TestNativeScratchRetainsWholeRunFenceAfterPublication(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || out != nil {
		t.Fatal("unbound creator crossed the run fence")
	}
	result, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || result == nil || result.Phase != string(state.Completed) || result.Publication != "durable" {
		t.Fatal("bound native scratch failed", result, err)
	}
	if err := run.abandonUnstarted(); err == nil {
		t.Fatal("published scratch was released without cleanup")
	}
	if runtime.mutations.selfTestRun != run || runtime.mutations.stagePending {
		t.Fatal("whole-run fence ended with staging")
	}
	observed, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || observed == nil || observed.Scratch != result.Scratch || observed.Receipt == nil || result.Receipt == nil || observed.Receipt.Directory != result.Receipt.Directory {
		t.Fatal("bound run lost original result", observed, err)
	}
}

func TestNativeRunCloseJoinsApprovalBeforeScratchAdmission(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	runtime.ingress.effects.Lock()
	returned := make(chan error, 1)
	go func() {
		_, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
		returned <- err
	}()
	deadline := time.After(time.Second)
	for {
		runtime.mutations.mu.Lock()
		active := run.active
		runtime.mutations.mu.Unlock()
		if active {
			break
		}
		select {
		case <-deadline:
			runtime.ingress.effects.Unlock()
			<-returned
			t.Fatal("scratch call did not enter its original lifetime")
		case <-time.After(time.Millisecond):
		}
	}
	runtime.mutations.closeSelfTestStageAdmission()
	joined := make(chan struct{})
	go func() { runtime.mutations.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("close did not join the approval refresh")
	case <-time.After(20 * time.Millisecond):
	}
	runtime.ingress.effects.Unlock()
	if err := <-returned; err == nil {
		t.Fatal("cancelled run reached scratch admission")
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not observe the original call's return")
	}
	runtime.mutations.mu.Lock()
	record, activeRun := runtime.mutations.operations[id], runtime.mutations.selfTestRun
	runtime.mutations.mu.Unlock()
	if record != nil || activeRun != nil {
		t.Fatal("cancelled pre-admission run did not release cleanly")
	}
}

func TestNativeStandaloneScratchJoinsApprovalBeforeAdmission(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime.ingress.effects.Lock()
	returned := make(chan error, 1)
	go func() {
		_, err := runtime.mutations.createSelfTestScratch(ctx, id, ws, publication)
		returned <- err
	}()
	deadline := time.After(time.Second)
	for {
		runtime.mutations.mu.Lock()
		active := runtime.mutations.scratchPreflight != nil
		runtime.mutations.mu.Unlock()
		if active {
			break
		}
		select {
		case <-deadline:
			runtime.ingress.effects.Unlock()
			<-returned
			t.Fatal("standalone call did not reserve preflight")
		case <-time.After(time.Millisecond):
		}
	}
	if run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws); err == nil || run != nil {
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("run crossed standalone preflight")
	}
	runtime.mutations.closeSelfTestStageAdmission()
	cancel()
	joined := make(chan struct{})
	go func() { runtime.mutations.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("close did not join standalone refresh")
	case <-time.After(20 * time.Millisecond):
	}
	runtime.ingress.effects.Unlock()
	if err := <-returned; err == nil {
		t.Fatal("cancelled standalone call reached admission")
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not join standalone return")
	}
	runtime.mutations.mu.Lock()
	record, pending := runtime.mutations.operations[id], runtime.mutations.scratchPreflight
	runtime.mutations.mu.Unlock()
	if record != nil || pending != nil {
		t.Fatal("cancelled standalone preflight left an operation")
	}
}
