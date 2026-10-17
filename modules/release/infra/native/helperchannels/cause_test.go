package helperchannels

import (
	"context"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

type causeRaw struct {
	syscall.RawConn
	after func() error
}

func (r causeRaw) Control(fn func(uintptr)) error {
	err := r.RawConn.Control(fn)
	return errors.Join(err, r.after())
}

// Moving only this private fixture boundary makes timer-delivery lag
// deterministic. No production clock, environment or runtime knob is changed.
type causeDeadline struct {
	context.Context
	at *time.Time
}

func (c causeDeadline) Deadline() (time.Time, bool) { return *c.at, true }

type causeOperation struct {
	owner *owned
	run   func(context.Context, time.Time) ([]byte, error)
	retry func() error
	close func() error
}

func causeStream(t *testing.T, kind string) causeOperation {
	t.Helper()
	if kind == "request" {
		input, _ := pipe(t)
		r := takeRequest(t, input)
		copy := *r
		return causeOperation{r.state.input, r.Read, func() error { _, err := copy.Read(context.Background(), time.Now().Add(time.Second)); return err }, copy.Close}
	}
	_, ack := pipe(t)
	input, _ := pipe(t)
	c := take(t, ack, input)
	copy := *c
	if kind == "ack" {
		return causeOperation{c.state.ack, func(ctx context.Context, until time.Time) ([]byte, error) {
			return nil, c.Emit(ctx, until, []byte("ack"))
		}, func() error { return copy.Emit(context.Background(), time.Now().Add(time.Second), []byte("retry")) }, copy.Close}
	}
	return causeOperation{c.state.continuation, c.AwaitContinue, func() error {
		_, err := copy.AwaitContinue(context.Background(), time.Now().Add(time.Second))
		return err
	}, copy.Close}
}

func checkCause(t *testing.T, err error, causes ...error) *Failure {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) {
		t.Fatalf("unclassified failure: %v", err)
	}
	for _, cause := range causes {
		if !errors.Is(err, cause) {
			t.Fatalf("lost original cause %T behind %s", cause, err)
		}
	}
	if strings.Contains(err.Error(), "CANARY") || strings.Contains(err.Error(), "/private/") {
		t.Fatal("private cause entered closed text")
	}
	return f
}

func TestNativeCancellationAndCleanupCauses(t *testing.T) {
	for _, kind := range []string{"ack", "continue", "request"} {
		for _, boundary := range []string{"native", "control", "both"} {
			for _, late := range []bool{false, true} {
				t.Run(kind+"/"+boundary+"/late="+map[bool]string{true: "yes", false: "no"}[late], func(t *testing.T) {
					op := causeStream(t, kind)
					nativeErr := &os.PathError{Op: "native", Path: "/private/NATIVE-CANARY", Err: unix.EIO}
					controlErr := errors.New("CONTROL-CANARY")
					cleanupErr := &os.PathError{Op: "close", Path: "/private/CLEANUP-CANARY", Err: unix.EBADF}
					cancelCause := errors.New("CANCEL-CANARY")
					base, cancel := context.WithCancelCause(context.Background())
					defer cancel(nil)
					at := time.Now().Add(time.Hour)
					var ctx context.Context = base
					if late {
						ctx = causeDeadline{base, &at}
					}
					trigger := func() {
						if late {
							at = time.Now().Add(-time.Second)
						} else {
							cancel(cancelCause)
						}
					}
					calls, closes := 0, 0
					ioFault := func(int, []byte) (int, error) {
						calls++
						if boundary == "control" {
							return 0, unix.EAGAIN
						}
						trigger()
						return 0, nativeErr
					}
					op.owner.read, op.owner.write = ioFault, ioFault
					if boundary != "native" {
						op.owner.raw = causeRaw{op.owner.raw, func() error { trigger(); return controlErr }}
					}
					op.owner.closeFile = func() error { closes++; return errors.Join(op.owner.file.Close(), cleanupErr) }
					data, err := op.run(ctx, time.Now().Add(time.Minute))
					f := checkCause(t, err, cleanupErr)
					if boundary != "control" {
						checkCause(t, err, nativeErr, unix.EIO)
						var exact *os.PathError
						if !errors.As(err, &exact) || exact != nativeErr {
							t.Fatal("original typed native error replaced")
						}
					}
					if boundary != "native" {
						checkCause(t, err, controlErr)
					}
					if late {
						checkCause(t, err, context.DeadlineExceeded)
					} else {
						checkCause(t, err, context.Canceled, cancelCause)
					}
					if data != nil || !f.CleanupUnconfirmed || f.Uncertain != (kind == "ack") {
						t.Fatal("cleanup accepted bytes or lost uncertainty classification")
					}
					if !errors.Is(op.retry(), err) || op.close() != err || op.close() != err {
						t.Fatal("copy/reuse/Close lost terminal error")
					}
					if calls != 1 || closes != 1 {
						t.Fatalf("renewed attempt or repeated close: IO=%d close=%d", calls, closes)
					}
				})
			}
		}
	}
}

func TestConfigurePreservesSyscallAndControlCauses(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "regular")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	raw, err := file.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	controlErr := &os.PathError{Op: "control", Path: "/private/CONTROL-CANARY", Err: unix.EIO}
	o := &owned{file: file, connect: func() (syscall.RawConn, error) { return causeRaw{raw, func() error { return controlErr }}, nil }}
	err = configure(o, false)
	if !errors.Is(err, controlErr) || !errors.Is(err, unix.EINVAL) {
		t.Fatal("configure discarded one native boundary cause")
	}
	connectErr := errors.New("CONNECT-CANARY")
	o.connect = func() (syscall.RawConn, error) { return nil, connectErr }
	if !errors.Is(configure(o, false), connectErr) {
		t.Fatal("SyscallConn cause lost")
	}
}

func TestNativeFailureRetainedAfterSuccessfulCleanup(t *testing.T) {
	for _, kind := range []string{"ack", "continue", "request"} {
		t.Run(kind, func(t *testing.T) {
			op := causeStream(t, kind)
			cause := &os.PathError{Op: "native", Path: "/private/NATIVE-CANARY", Err: unix.EIO}
			calls, closes := 0, 0
			fault := func(int, []byte) (int, error) { calls++; return 0, cause }
			op.owner.read, op.owner.write = fault, fault
			op.owner.closeFile = func() error { closes++; return op.owner.file.Close() }
			data, err := op.run(context.Background(), time.Now().Add(time.Second))
			f := checkCause(t, err, cause)
			if data != nil || f.CleanupUnconfirmed || f.Uncertain {
				t.Fatal("native observation failure misclassified")
			}
			if !errors.Is(op.retry(), err) || op.close() != err || op.close() != err || calls != 1 || closes != 1 {
				t.Fatal("terminal native error or one-shot custody lost")
			}
		})
	}
}

func TestPanicPreservesOwnedCleanup(t *testing.T) {
	for _, kind := range []string{"ack", "continue", "request"} {
		t.Run(kind, func(t *testing.T) {
			op := causeStream(t, kind)
			fault := func(int, []byte) (int, error) { panic("private fixture panic") }
			op.owner.read, op.owner.write = fault, fault
			closes := 0
			op.owner.closeFile = func() error { closes++; return op.owner.file.Close() }
			func() {
				defer func() {
					if recover() == nil {
						t.Fatal("panic not propagated")
					}
				}()
				_, _ = op.run(context.Background(), time.Now().Add(time.Second))
			}()
			if closes != 1 {
				t.Fatal("panic skipped owned cleanup")
			}
			if op.retry() == nil {
				t.Fatal("panic renewed consumed attempt")
			}
			_ = op.close()
			if closes != 1 {
				t.Fatal("Close repeated panic cleanup")
			}
		})
	}
}
