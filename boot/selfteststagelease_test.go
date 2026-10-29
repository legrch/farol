package boot

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// Controlled native callback and in-memory ledger only; not a filesystem,
// process, desktop, or installed-runtime witness.
func TestStageLeaseJoinsNativeBeforeReleaseAndPreventsReplay(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	lifetime, cancel := context.WithCancel(context.Background())
	defer cancel()
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: lifetime, operations: map[string]*settingsMutationOperation{id: {stageScratch: true, pending: true, path: mutation.ScratchPath(id)}}}
	lease, err := ledger.beginSelfTestStage(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	entered, releaseRun, runDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	lease.runNative = func(ctx context.Context, _ func(context.Context, int, NativeRoot) error) error {
		close(entered)
		<-releaseRun
		return ctx.Err()
	}
	go func() { runDone <- lease.run(func(context.Context, int, NativeRoot) error { return nil }) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("run not entered")
	}
	cancel()
	select {
	case <-lease.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("cancellation not delivered")
	}
	released := make(chan struct{})
	go func() { lease.release(); close(released) }()
	ledger.closeSelfTestStageAdmission()
	waited := make(chan struct{})
	go func() { ledger.waitSelfTestStage(); close(waited) }()
	select {
	case <-released:
		t.Fatal("released during native run")
	case <-waited:
		t.Fatal("wait finished during native run")
	default:
	}
	if _, err := ledger.beginSelfTestStage(context.Background(), id); err == nil {
		t.Fatal("same operation admitted twice")
	}
	close(releaseRun)
	if err := <-runDone; err != context.Canceled {
		t.Fatalf("lost original cancellation: %v", err)
	}
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("release did not join run")
	}
	select {
	case <-waited:
	case <-time.After(time.Second):
		t.Fatal("ledger did not join release")
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); lease.release() }()
	}
	wg.Wait()
	if err := lease.run(func(context.Context, int, NativeRoot) error { return nil }); err == nil {
		t.Fatal("released lease ran again")
	}
}

func TestStageLeaseKeepsGateAfterRunUntilTerminalSaveFinishes(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: map[string]*settingsMutationOperation{id: {stageScratch: true, pending: true, path: mutation.ScratchPath(id)}}}
	lease, err := ledger.beginSelfTestStage(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	lease.runNative = func(context.Context, func(context.Context, int, NativeRoot) error) error { return nil }
	if err := lease.run(func(context.Context, int, NativeRoot) error { return nil }); err != nil {
		t.Fatal(err)
	}
	ledger.closeSelfTestStageAdmission()
	waited := make(chan struct{})
	go func() { ledger.waitSelfTestStage(); close(waited) }()
	select {
	case <-waited:
		t.Fatal("gate released before terminal save")
	default:
	}
	lease.release()
	select {
	case <-waited:
	case <-time.After(time.Second):
		t.Fatal("gate did not close")
	}
}
