package helperchannels

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Close failures below are deterministic lost-result seams after an actual
// successful close. They are not physically induced native Close failures.
func TestSuccessfulStreamsRejectUnconfirmedCleanup(t *testing.T) {
	for _, kind := range []string{"ack", "continue", "request"} {
		t.Run(kind, func(t *testing.T) {
			input, producer := pipe(t)
			_, ack := pipe(t)
			var owner *owned
			var run func() ([]byte, error)
			var close func() error
			until := time.Now().Add(time.Second)
			if kind == "request" {
				r := takeRequest(t, input)
				owner, close = r.state.input, r.Close
				run = func() ([]byte, error) { return r.Read(context.Background(), until) }
			} else {
				c := take(t, ack, input)
				close = c.Close
				if kind == "ack" {
					owner = c.state.ack
					run = func() ([]byte, error) { return nil, c.Emit(context.Background(), until, []byte("ack")) }
				} else {
					owner = c.state.continuation
					run = func() ([]byte, error) { return c.AwaitContinue(context.Background(), until) }
				}
			}
			if _, err := producer.Write([]byte("complete")); err != nil {
				t.Fatal(err)
			}
			if err := producer.Close(); err != nil {
				t.Fatal(err)
			}
			cause := &os.PathError{Op: "close", Path: "/private/CLEANUP-CANARY", Err: unix.EIO}
			calls := 0
			owner.closeFile = func() error { calls++; return errors.Join(owner.file.Close(), cause) }
			data, err := run()
			f := checkCause(t, err, cause)
			if data != nil || !f.CleanupUnconfirmed || calls != 1 {
				t.Fatal("unconfirmed cleanup returned success/data or retried")
			}
			if close() != err || close() != err || calls != 1 {
				t.Fatal("Close did not retain the exact terminal cleanup failure")
			}
		})
	}
}

func TestCloseRetainsBothOwnersAndConstructorCauses(t *testing.T) {
	_, ack := pipe(t)
	cont, _ := pipe(t)
	c := take(t, ack, cont)
	a, b := errors.New("ACK-CANARY"), errors.New("CONT-CANARY")
	ackCloses, contCloses := 0, 0
	c.state.ack.closeFile = func() error { ackCloses++; return errors.Join(ack.Close(), a) }
	c.state.continuation.closeFile = func() error { contCloses++; return errors.Join(cont.Close(), b) }
	err := c.Close()
	f := checkCause(t, err, a, b)
	if !f.Uncertain || !f.CleanupUnconfirmed || c.Close() != err || ackCloses != 1 || contCloses != 1 {
		t.Fatal("dual cleanup provenance lost or close repeated")
	}
	_, used := pipe(t)
	if err := used.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = Take(used, nil)
	f = checkCause(t, err, os.ErrClosed)
	if !f.Uncertain || !f.CleanupUnconfirmed {
		t.Fatal("constructor cleared cleanup uncertainty")
	}
	_, err = TakeRequest(used)
	checkCause(t, err, os.ErrClosed)
}

func TestGuardKeepsConcurrentCancellationAndAbsoluteDeadline(t *testing.T) {
	op := causeStream(t, "request")
	ctx, cancel := context.WithCancelCause(context.Background())
	cause := errors.New("CANCEL-CANARY")
	cancel(cause)
	data, err := op.run(ctx, time.Now().Add(-time.Second))
	checkCause(t, err, cause, context.Canceled, context.DeadlineExceeded)
	if data != nil || !errors.Is(op.retry(), err) {
		t.Fatal("bounds failure returned bytes or renewed its attempt")
	}
}

func TestJoinedFailureRetainsOriginalUncertainty(t *testing.T) {
	cause := errors.New("CLEANUP-CANARY")
	prior := cleanupFailure("ack_close", true, nil, cause)
	err := failure("continue_read", false, errors.Join(errors.New("NATIVE-CANARY"), prior))
	f := checkCause(t, err, prior, cause)
	if !f.Uncertain || !f.CleanupUnconfirmed {
		t.Fatal("joined cause cleared original uncertainty")
	}
}

func TestClosePreservesOtherChannelPrimaryFailure(t *testing.T) {
	for _, failingClose := range []string{"ack", "continue"} {
		t.Run(failingClose, func(t *testing.T) {
			_, ack := pipe(t)
			cont, _ := pipe(t)
			c := take(t, ack, cont)
			a, b, cleanup := errors.New("ACK-NATIVE-CANARY"), errors.New("CONT-NATIVE-CANARY"), errors.New("CLEANUP-CANARY")
			c.state.ack.write = func(int, []byte) (int, error) { return 0, a }
			c.state.continuation.read = func(int, []byte) (int, error) { return 0, b }
			owner := c.state.ack
			if failingClose == "continue" {
				owner = c.state.continuation
			}
			owner.closeFile = func() error { return errors.Join(owner.file.Close(), cleanup) }
			until := time.Now().Add(time.Second)
			ackErr := c.Emit(context.Background(), until, []byte("ack"))
			_, contErr := c.AwaitContinue(context.Background(), until)
			err := c.Close()
			checkCause(t, err, ackErr, contErr, a, b, cleanup)
		})
	}
}
