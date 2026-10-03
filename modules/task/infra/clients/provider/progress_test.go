package provider

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
)

func TestConcurrentRecordsAndCompletionShareOneGate(t *testing.T) {
	// The intentionally unprotected counter must be race-free through the
	// production gate; this is callback serialization proof, not provider proof.
	count := 0
	p := NewProgress(func(context.Context, task.Reference) error { count++; return nil })
	var jobs sync.WaitGroup
	for range 32 {
		jobs.Go(func() {
			if err := p.Record(context.Background(), task.Reference{ThreadID: "thread"}); err != nil {
				t.Errorf("record: %v", err)
			}
		})
	}
	jobs.Wait()
	if err := p.Close(func() error {
		if count != 32 {
			t.Errorf("completion saw %d callbacks", count)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := p.Record(context.Background(), task.Reference{}); !errors.Is(err, task.ErrUnknown) {
		t.Fatalf("late callback: %v", err)
	}
	if err := p.Close(func() error { t.Fatal("second completion"); return nil }); !errors.Is(err, task.ErrUnknown) {
		t.Fatalf("second close: %v", err)
	}
}

func TestCloseWaitsForRecorderAndFencesItsFailure(t *testing.T) {
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	lostAck := errors.New("publication acknowledgement lost")
	p := NewProgress(func(context.Context, task.Reference) error {
		close(entered)
		<-release
		return lostAck
	})
	go func() { done <- p.Record(context.Background(), task.Reference{}) }()
	<-entered
	closing := make(chan error, 1)
	go func() {
		closing <- p.Close(func() error { t.Error("completion ignored failed publication"); return nil })
	}()
	close(release)
	if err := <-done; !errors.Is(err, lostAck) {
		t.Fatal(err)
	}
	if err := <-closing; !errors.Is(err, lostAck) {
		t.Fatal(err)
	}
}

func TestFailuresAreStickyAndOperationsAreIndependent(t *testing.T) {
	count := 0
	p := NewProgress(func(context.Context, task.Reference) error { count++; return task.ErrIdentity })
	for range 2 {
		if err := p.Record(context.Background(), task.Reference{}); !errors.Is(err, task.ErrIdentity) {
			t.Fatal(err)
		}
	}
	if count != 1 {
		t.Fatalf("failed recorder called %d times", count)
	}
	if err := p.Close(func() error { t.Fatal("failed operation completed"); return nil }); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
	other := NewProgress(func(context.Context, task.Reference) error { return nil })
	if err := other.Close(func() error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestCancelledProgressDoesNotEnterRecorder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p := NewProgress(func(context.Context, task.Reference) error { t.Fatal("cancelled recorder entered"); return nil })
	if err := p.Record(ctx, task.Reference{}); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := p.Close(func() error { t.Fatal("cancelled operation completed"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
