package boot

import (
	"context"
	"math"
	"sync"
	"testing"

	computerport "github.com/legrch/farol/modules/computer/app/port"
)

// Pure concurrency doubles; no filesystem, approval, journal or live admission.
type activationCurrent struct{ calls int }

func (c *activationCurrent) WithCurrent(_ context.Context, inspect func(*computerport.TaskBinding) error) error {
	c.calls++
	return inspect(&computerport.TaskBinding{})
}
func TestActivationNeverRevivesAnOldLease(t *testing.T) {
	g := new(activationFence)
	current := new(activationCurrent)
	first, err := g.deactivate()
	if err != nil {
		t.Fatal(err)
	}
	old := &activatedAdmission{guard: g, fence: first, current: current}
	inspect := func(*computerport.TaskBinding) error { return nil }
	if old.WithCurrent(context.Background(), inspect) == nil {
		t.Fatal("inactive route admitted")
	}
	if err := g.activate(first); err != nil {
		t.Fatal(err)
	}
	if err := old.WithCurrent(context.Background(), inspect); err != nil {
		t.Fatal(err)
	}
	second, err := g.deactivate()
	if err != nil {
		t.Fatal(err)
	}
	if g.activate(first) == nil {
		t.Fatal("stale activation")
	}
	if err := g.activate(second); err != nil {
		t.Fatal(err)
	}
	if old.WithCurrent(context.Background(), inspect) == nil || current.calls != 1 {
		t.Fatal("reactivation revived prior lease")
	}
	fresh := &activatedAdmission{guard: g, fence: second, current: current}
	if err := fresh.WithCurrent(context.Background(), inspect); err != nil {
		t.Fatal(err)
	}
}
func TestActivationSerializesWithdrawalWithCurrentDisclosure(t *testing.T) {
	g := new(activationFence)
	fence, _ := g.deactivate()
	_ = g.activate(fence)
	a := &activatedAdmission{guard: g, fence: fence, current: new(activationCurrent)}
	entered, release, withdone, deactivated := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		defer close(withdone)
		_ = a.WithCurrent(context.Background(), func(*computerport.TaskBinding) error { close(entered); <-release; return nil })
	}()
	<-entered
	go func() { defer wait.Done(); _, _ = g.deactivate(); close(deactivated) }()
	select {
	case <-deactivated:
		t.Fatal("withdrawal crossed current callback")
	default:
	}
	close(release)
	<-withdone
	<-deactivated
	wait.Wait()
	if a.WithCurrent(context.Background(), func(*computerport.TaskBinding) error { return nil }) == nil {
		t.Fatal("withdrawn route disclosed")
	}
}
func TestActivationExhaustionAndInvalidCallbacksFailClosed(t *testing.T) {
	g := &activationFence{revision: math.MaxUint64, active: true}
	if _, err := g.deactivate(); err == nil || g.active || !g.exhausted {
		t.Fatal("exhaustion")
	}
	if g.activate(math.MaxUint64) == nil {
		t.Fatal("exhausted activation")
	}
	var a *activatedAdmission
	if a.WithCurrent(context.Background(), func(*computerport.TaskBinding) error { return nil }) == nil {
		t.Fatal("nil gate")
	}
}
