package process

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// deadlineWithoutNotification models an earlier deadline before cancellation is delivered.
type deadlineWithoutNotification struct{ deadline time.Time }

func (c deadlineWithoutNotification) Deadline() (time.Time, bool) { return c.deadline, true }
func (deadlineWithoutNotification) Done() <-chan struct{}         { return nil }
func (deadlineWithoutNotification) Err() error                    { return nil }
func (deadlineWithoutNotification) Value(any) any                 { return nil }

// No native command is entered. Process/open qualification belongs to Root.
func TestRelaunchDeterministicBoundsAndDrain(t *testing.T) {
	called := false
	fence := func(context.Context) error { called = true; return nil }
	args := []string{"/usr/bin/open", "-a", "/never-opened.app", "--args", "--farol-installed-update-relaunch={}"}
	if err := Open(context.Background(), time.Now().Add(-time.Second), args, fence); err == nil || called {
		t.Fatal("expired action reached native fence", err)
	}
	for _, size := range []int{0, 4096, 4097} {
		d := &drain{}
		if _, err := d.ReadFrom(strings.NewReader(strings.Repeat("x", size))); err != nil {
			t.Fatal(err)
		}
		if d.complete() != (size <= 4096) {
			t.Fatal("EOF/overflow classification changed", size)
		}
	}

	t.Run("caller_deadline_before_notification", func(t *testing.T) {
		entered := false
		stopBeforeNative := errors.New("fence stops before native dispatch")
		fence := func(context.Context) error { entered = true; return stopBeforeNative }
		ctx := deadlineWithoutNotification{deadline: time.Now().Add(-time.Second)}
		err := Open(ctx, time.Now().Add(time.Minute), args, fence)
		if entered || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expired caller deadline was not refused before fence: entered=%t sentinel=%t err=%v", entered, errors.Is(err, stopBeforeNative), err)
		}
	})
}
