//go:build darwin

package boot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"golang.org/x/sys/unix"
)

// Real retained descriptors on a disposable empty profile. No publication,
// process, installed profile, or live connector is involved.
func TestNativeComputerStageOwnerJoinsOriginalDescriptor(t *testing.T) {
	parent, err := filepath.Abs(filepath.Join("..", "_output", "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(parent, "stage-owner-native-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !t.Failed() {
			if err := os.RemoveAll(root); err != nil {
				t.Error(err)
			}
		} else {
			t.Log("retained fixture", root)
		}
	})
	for _, name := range []string{"computer", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	var stat unix.Stat_t
	if err := unix.Lstat(root, &stat); err != nil {
		t.Fatal(err)
	}
	q, err := QualifyProfile(ProfileBinding{ProfileID: "stage-test", Root: root, Device: uint64(stat.Dev), Inode: stat.Ino})
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	o, err := newComputerStageOwner(q)
	if err != nil {
		t.Fatal(err)
	}
	connector, _, journal, native, _ := connectorProcessFixture(t)
	ledger := connector.mutations
	ledger.stageOwner = o
	ledger.stageLifetime = context.Background()
	calledBefore := false
	if err := ledger.withSelfTestStage(context.Background(), func(context.Context, int, NativeRoot) error { calledBefore = true; return nil }, func(err error) error { return err }); err == nil || calledBefore {
		t.Fatal("unknown history admitted")
	}
	ledger.stageBaseline = true
	ledger.operations["old-process"] = &settingsMutationOperation{pending: true, process: &connectorProcessOperation{}}
	if err := ledger.withSelfTestStage(context.Background(), func(context.Context, int, NativeRoot) error { calledBefore = true; return nil }, func(err error) error { return err }); err == nil || calledBefore {
		t.Fatal("pending process admitted")
	}
	delete(ledger.operations, "old-process")
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	finishEntered, finishRelease := make(chan struct{}), make(chan struct{})
	go func() {
		returned <- ledger.withSelfTestStage(context.Background(), func(_ context.Context, fd int, selected NativeRoot) error {
			var actual unix.Stat_t
			if err := unix.Fstat(fd, &actual); err != nil {
				return err
			}
			flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
			if err != nil || flags&unix.FD_CLOEXEC == 0 {
				return profileFailure(ProfileRefused)
			}
			if uint64(actual.Dev) != selected.Device || actual.Ino != selected.Inode {
				return profileFailure(ProfileRefused)
			}
			close(entered)
			<-release
			return nil
		}, func(err error) error { close(finishEntered); <-finishRelease; return err })
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("attempt did not enter")
	}
	ledger.mu.Lock()
	recovery := ledger.recoveryDispositionLocked(false)
	ledger.mu.Unlock()
	if recovery != "pending_operation" {
		t.Fatal("recovery ignored active staging", recovery)
	}
	if started, err := connector.startProcess(context.Background(), connector.current, "racing-operation", "racing-call", native.selectLaunch); err == nil || started != nil || journal.selections != 0 || journal.reserves != 0 || native.selects != 0 || native.spawns != 0 {
		t.Fatal("process raced past staging gate", err)
	}
	calledConcurrent := false
	if err := o.run(context.Background(), func(context.Context, int, NativeRoot) error { calledConcurrent = true; return nil }); err == nil || calledConcurrent {
		t.Fatal("concurrent attempt admitted")
	}
	ledger.closeSelfTestStageAdmission()
	calledAfterClose := false
	if err := ledger.withSelfTestStage(context.Background(), func(context.Context, int, NativeRoot) error { calledAfterClose = true; return nil }, func(err error) error { return err }); err == nil || calledAfterClose {
		t.Fatal("closing ledger admitted stage")
	}
	closed := make(chan error, 1)
	go func() { closed <- o.Close() }()
	closedAgain := make(chan error, 1)
	go func() { closedAgain <- o.Close() }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		o.mu.Lock()
		closing := o.closed
		o.mu.Unlock()
		if closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("close did not begin")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-closed:
		t.Fatal("closed before callback returned", err)
	default:
	}
	close(release)
	select {
	case <-finishEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("finalization did not begin")
	}
	waited := make(chan struct{})
	go func() { ledger.waitSelfTestStage(); close(waited) }()
	select {
	case <-waited:
		t.Fatal("terminal persistence was not joined")
	default:
	}
	close(finishRelease)
	if err := <-returned; err != nil {
		t.Fatal(err)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if err := <-closedAgain; err != nil {
		t.Fatal(err)
	}
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("stage join did not finish")
	}
	called := false
	if err := o.run(context.Background(), func(context.Context, int, NativeRoot) error { called = true; return nil }); err == nil || called {
		t.Fatal("closed owner admitted attempt")
	}
	cancelOwner, err := newComputerStageOwner(q)
	if err != nil {
		t.Fatal(err)
	}
	lifetime, cancelLifetime := context.WithCancel(context.Background())
	cancelLedger := &SettingsMutationIngress{stageBaseline: true, stageOwner: cancelOwner, stageLifetime: lifetime, operations: make(map[string]*settingsMutationOperation)}
	cancelEntered, cancelResult := make(chan struct{}), make(chan error, 1)
	go func() {
		cancelResult <- cancelLedger.withSelfTestStage(context.Background(), func(ctx context.Context, _ int, _ NativeRoot) error {
			close(cancelEntered)
			<-ctx.Done()
			return ctx.Err()
		}, func(err error) error { return err })
	}()
	select {
	case <-cancelEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("cancellable callback did not start")
	}
	cancelLifetime()
	select {
	case err := <-cancelResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("runtime cancellation lost", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runtime cancellation did not reach callback")
	}
	cancelLedger.closeSelfTestStageAdmission()
	if err := cancelOwner.Close(); err != nil {
		t.Fatal(err)
	}
	cancelLedger.waitSelfTestStage()
	failedClose, err := newComputerStageOwner(q)
	if err != nil {
		t.Fatal(err)
	}
	failedClose.release = func(fd int) error {
		if err := closeStageDescriptor(fd); err != nil {
			return err
		}
		return profileFailure(ProfileCleanupUnknown) // Closed fixture fd; inject lost close acknowledgement.
	}
	if err := failedClose.run(context.Background(), func(context.Context, int, NativeRoot) error { return nil }); err == nil {
		t.Fatal("close failure hidden")
	}
	called = false
	if err := failedClose.run(context.Background(), func(context.Context, int, NativeRoot) error { called = true; return nil }); err == nil || called {
		t.Fatal("uncertain cleanup admitted another attempt")
	}
	if err := failedClose.Close(); err == nil {
		t.Fatal("cleanup uncertainty was lost")
	}
	second, err := newComputerStageOwner(q)
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "computer")
	drift, err := newComputerStageOwner(q)
	if err != nil {
		t.Fatal(err)
	}
	called = false
	err = drift.run(context.Background(), func(context.Context, int, NativeRoot) error {
		called = true
		if err := os.Rename(state, state+"-old"); err != nil {
			return err
		}
		return os.Mkdir(state, 0700)
	})
	if err == nil || !called {
		t.Fatal("profile drift after callback was hidden")
	}
	if err := drift.Close(); err != nil {
		t.Fatal(err)
	}
	called = false
	if err := second.run(context.Background(), func(context.Context, int, NativeRoot) error { called = true; return nil }); err == nil || called {
		t.Fatal("replaced qualified state admitted")
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

// Actual runtime Close waits for the same test attempt and finalization before
// releasing the qualified profile. The callback has no publication effects.
func TestNativeRuntimeCloseJoinsStageFinalization(t *testing.T) {
	parent, err := filepath.Abs(filepath.Join("..", "_output", "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(parent, "stage-runtime-native-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !t.Failed() {
			if err := os.RemoveAll(root); err != nil {
				t.Error(err)
			}
		} else {
			t.Log("retained fixture", root)
		}
	})
	for _, name := range []string{"computer", "chat", "task"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	var st unix.Stat_t
	if err := unix.Lstat(root, &st); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "computer", "mutations"), 0700); err != nil {
		t.Fatal(err)
	}
	q, err := QualifyProfile(ProfileBinding{ProfileID: "stage-runtime", Root: root, Device: uint64(st.Dev), Inode: st.Ino})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := newComputerStageOwner(q)
	if err != nil {
		t.Fatal(err)
	}
	computer, _, err := q.Roots()
	if err != nil {
		t.Fatal(err)
	}
	journal, err := mutationrepo.New(context.Background(), mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID})
	if err != nil {
		t.Fatal(err)
	}
	lifetime, cancel := context.WithCancel(context.Background())
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: owner, stageLifetime: lifetime, operations: make(map[string]*settingsMutationOperation)}
	runtime := &NativeRuntime{profile: q, stageOwner: owner, mutations: ledger, mutationStore: journal, cancel: cancel}
	entered, nativeRelease, finalEntered, finalRelease := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	attempt := make(chan error, 1)
	go func() {
		attempt <- ledger.withSelfTestStage(context.Background(), func(context.Context, int, NativeRoot) error { close(entered); <-nativeRelease; return nil }, func(err error) error { close(finalEntered); <-finalRelease; return err })
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native callback did not enter")
	}
	closed := make(chan error, 1)
	go func() { closed <- runtime.Close() }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ledger.mu.Lock()
		closing := ledger.stageClosed
		ledger.mu.Unlock()
		if closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runtime did not close admission")
		}
		time.Sleep(time.Millisecond)
	}
	close(nativeRelease)
	select {
	case <-finalEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("finalization did not enter")
	}
	select {
	case err := <-closed:
		t.Fatal("runtime closed before terminal finalization", err)
	default:
	}
	if _, _, err := q.Roots(); err != nil {
		t.Fatal("profile closed before finalization", err)
	}
	selection := mutationrepo.SettledSelection{OwnerID: "owner", ProfileID: "stage-runtime", ComputerID: "computer"}
	if ok, err := journal.InspectStagingProcesses(context.Background(), selection); err != nil || !ok {
		t.Fatal("journal closed before finalization", err)
	}
	close(finalRelease)
	if err := <-attempt; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runtime close did not return")
	}
	if _, _, err := q.Roots(); err == nil {
		t.Fatal("runtime left profile open")
	}
	if _, err := journal.InspectStagingProcesses(context.Background(), selection); err == nil {
		t.Fatal("runtime left journal open")
	}
}
