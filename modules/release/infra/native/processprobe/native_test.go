//go:build darwin || linux

package processprobe

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

func TestNativeCommandHasOnlyFixedObservationAuthority(t *testing.T) {
	out, diagnostic := newDrain(nil), newDrain(nil)
	c := (nativeBoundary{}).prepare(23456, out, diagnostic).(*nativeChild).command
	if c.Path != "/bin/ps" || !reflect.DeepEqual(c.Args, []string{"/bin/ps", "-p", "23456", "-o", "lstart="}) ||
		!reflect.DeepEqual(c.Env, []string{"LANG=C.UTF-8", "PATH=/usr/bin:/bin"}) || c.Dir != "/" || c.Stdin != nil ||
		c.Stdout != out || c.Stderr != diagnostic || c.Cancel != nil || c.WaitDelay != time.Second {
		t.Fatalf("unexpected command authority: %#v", c)
	}
	if c.Process != nil || c.ProcessState != nil {
		t.Fatal("prepare started child")
	}
}

func TestSignalZeroOnlyESRCHProvesAbsence(t *testing.T) {
	for _, err := range []error{nil, syscall.EPERM, syscall.EACCES, syscall.EINVAL, syscall.EINTR} {
		if absenceError(err) {
			t.Fatalf("%v became absence", err)
		}
	}
	if !absenceError(syscall.ESRCH) || !absenceError(fmt.Errorf("wrapped: %w", syscall.ESRCH)) {
		t.Fatal("lost ESRCH")
	}
}

func TestActualFixedPSPortableMechanismOnly(t *testing.T) {
	// This launches only the fixed disposable observation child and observes
	// this test process. Linux does not qualify Darwin tokens, cleanup, updater
	// routing, packages, installation or OTA behavior.
	p := newProbe(os.Getpid(), nativeBoundary{})
	got, err := p.Observe(context.Background(), time.Now().Add(2*time.Second))
	if err != nil || got.Presence != port.ProcessPresent || got.Start == "" {
		t.Fatalf("actual fixed ps: %#v %v", got, err)
	}
	if runtime.GOOS == "linux" {
		if _, err := New(os.Getpid()); err == nil {
			t.Fatal("Linux fixture enabled production constructor")
		}
	}
	t.Logf("portable %s fixed /bin/ps mechanism only; native acceptance remains unqualified", runtime.GOOS)
}
