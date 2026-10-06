package process

import (
	"context"
	"errors"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// These tests construct only Child/done in memory. They never spawn, wait an OS
// process, inspect a PID, signal, probe, schedule a timer or use a provider.
func TestChildCompletionExistingDoneChannel(t *testing.T) {
	done := make(chan struct{})
	c := &Child{done: done}
	result := make(chan error, 1)
	go func() { result <- c.WaitForCompletion(context.Background()) }()
	select {
	case err := <-result:
		t.Fatal("completion returned before notification", err)
	default:
	}
	close(done)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := c.WaitForCompletion(context.Background()); err != nil || c.finished || c.waited || c.drained {
		t.Fatal("done observation invented root/output/cleanup facts", err)
	}
}

func TestChildCompletionContextCancellation(t *testing.T) {
	c := &Child{done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- c.WaitForCompletion(ctx) }()
	cancel()
	if err := <-result; err == nil {
		t.Fatal("cancelled notification became success")
	}
	close(c.done)
	if err := c.WaitForCompletion(ctx); err == nil {
		t.Fatal("closed done overrode an already cancelled context")
	}
}

func TestChildCompletionMissingNotificationFailsClosed(t *testing.T) {
	for _, c := range []*Child{nil, {}} {
		var failure *processsvc.NativeFailure
		if err := c.WaitForCompletion(context.Background()); !errors.As(err, &failure) || !failure.Unknown {
			t.Fatal("missing notification did not remain unknown", err)
		}
	}
	if err := (&Child{done: make(chan struct{})}).WaitForCompletion(nil); err == nil {
		t.Fatal("nil context accepted")
	}
}

type completionLateContext struct {
	context.Context
	calls int
}

func (c *completionLateContext) Err() error {
	c.calls++
	if c.calls > 1 {
		return context.Canceled
	}
	return nil
}

func TestChildCompletionLateContextAfterDoneRefuses(t *testing.T) {
	done := make(chan struct{})
	close(done)
	ctx := &completionLateContext{Context: context.Background()}
	if err := (&Child{done: done}).WaitForCompletion(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("late cancellation after completion escaped", err)
	}
}
