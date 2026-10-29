//go:build darwin

package boot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

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
	entered, release, returned := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		returned <- o.run(context.Background(), func(fd int, selected NativeRoot) error {
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
		})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("attempt did not enter")
	}
	calledConcurrent := false
	if err := o.run(context.Background(), func(int, NativeRoot) error { calledConcurrent = true; return nil }); err == nil || calledConcurrent {
		t.Fatal("concurrent attempt admitted")
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
	if err := <-returned; err != nil {
		t.Fatal(err)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if err := <-closedAgain; err != nil {
		t.Fatal(err)
	}
	called := false
	if err := o.run(context.Background(), func(int, NativeRoot) error { called = true; return nil }); err == nil || called {
		t.Fatal("closed owner admitted attempt")
	}
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
	if err := failedClose.run(context.Background(), func(int, NativeRoot) error { return nil }); err == nil {
		t.Fatal("close failure hidden")
	}
	called = false
	if err := failedClose.run(context.Background(), func(int, NativeRoot) error { called = true; return nil }); err == nil || called {
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
	err = drift.run(context.Background(), func(int, NativeRoot) error {
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
	if err := second.run(context.Background(), func(int, NativeRoot) error { called = true; return nil }); err == nil || called {
		t.Fatal("replaced qualified state admitted")
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}
