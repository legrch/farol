package admission

// This owner fixture models the required synchronous lifecycle gate. It is not
// a production Task owner, durable journal or native Computer qualification.
import (
	"context"
	"errors"
	"sync"
	"testing"

	admissioncap "github.com/legrch/farol/modules/task/app/capabilities/admission"
	"github.com/legrch/farol/modules/task/app/port"
)

type owner struct {
	mu          sync.Mutex
	current     *port.CurrentBinding
	unavailable bool
}

func (o *owner) WithCurrent(_ context.Context, inspect func(*port.CurrentBinding) error) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.unavailable {
		return errors.New("private persistence diagnostics")
	}
	return inspect(o.current)
}
func selected() port.CurrentBinding {
	return port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "coding-task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn"}
}
func contract(t *testing.T, o port.CurrentTaskAdmission) *Contract {
	t.Helper()
	controller, err := admissioncap.New(o, selected())
	if err != nil {
		t.Fatal(err)
	}
	return New(controller)
}
func failure(t *testing.T, err error, code string) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("failure: %v, want %s", err, code)
	}
}

func TestCurrentAdmissionIsAnIndependentExactProjection(t *testing.T) {
	b := selected()
	o := &owner{current: &b}
	c := contract(t, o)
	consumerErr := errors.New("consumer refusal")
	err := c.WithCurrent(context.Background(), func(out *Binding) error {
		if out == nil || out.TaskID != b.TaskID || out.TaskEpoch != b.TaskEpoch || out.TurnID != b.TurnID || out.SessionID != "authority-session" {
			t.Fatalf("binding: %+v", out)
		}
		out.TaskID = "changed by consumer"
		return consumerErr
	})
	if err != consumerErr || b != selected() {
		t.Fatalf("callback alias/error: %+v %v", b, err)
	}
}

func TestRevocationAndUnknownPersistenceNeverExposeCachedAdmission(t *testing.T) {
	b := selected()
	o := &owner{current: &b}
	c := contract(t, o)
	if err := c.WithCurrent(context.Background(), func(out *Binding) error {
		if out == nil {
			t.Fatal("missing current")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	o.mu.Lock()
	o.current = nil
	o.mu.Unlock()
	if err := c.WithCurrent(context.Background(), func(out *Binding) error {
		if out != nil {
			t.Fatal("stale positive")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// A lifecycle owner's unsettled durable transition must fence the binding,
	// regardless of a previously positive projection held by the consumer.
	o.mu.Lock()
	o.unavailable = true
	o.mu.Unlock()
	failure(t, c.WithCurrent(context.Background(), func(*Binding) error { t.Fatal("unavailable owner inspected"); return nil }), "TASK_UNAVAILABLE")
}

func TestChangedBindingCannotSelectAnotherTaskOrTurn(t *testing.T) {
	for _, change := range []func(*port.CurrentBinding){
		func(b *port.CurrentBinding) { b.OwnerID = "other" },
		func(b *port.CurrentBinding) { b.SessionID = "provider-session" },
		func(b *port.CurrentBinding) { b.TaskID = "other" },
		func(b *port.CurrentBinding) { b.TaskEpoch++ },
		func(b *port.CurrentBinding) { b.ParticipantID = "other" },
		func(b *port.CurrentBinding) { b.TurnID = "later-turn" },
	} {
		b := selected()
		change(&b)
		c := contract(t, &owner{current: &b})
		failure(t, c.WithCurrent(context.Background(), func(*Binding) error { t.Fatal("foreign binding inspected"); return nil }), "TASK_IDENTITY_MISMATCH")
	}
}

func TestOwnerSerializesInspectionAgainstRevocation(t *testing.T) {
	b := selected()
	o := &owner{current: &b}
	c := contract(t, o)
	entered, release, inspected, revoked := make(chan struct{}), make(chan struct{}), make(chan error, 1), make(chan struct{})
	go func() {
		inspected <- c.WithCurrent(context.Background(), func(out *Binding) error {
			if out == nil {
				t.Error("missing selected binding")
			}
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	go func() {
		o.mu.Lock()
		o.current = nil
		o.mu.Unlock()
		close(revoked)
	}()
	close(release)
	if err := <-inspected; err != nil {
		t.Fatal(err)
	}
	<-revoked
	if err := c.WithCurrent(context.Background(), func(out *Binding) error {
		if out != nil {
			t.Fatal("revoked binding survived")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

type brokenOwner struct {
	calls       int
	ignoreError bool
}

func (o brokenOwner) WithCurrent(_ context.Context, inspect func(*port.CurrentBinding) error) error {
	b := selected()
	for range o.calls {
		if err := inspect(&b); err != nil && !o.ignoreError {
			return err
		}
	}
	return nil
}
func TestBrokenOwnerAndCancelledCallerFailClosed(t *testing.T) {
	for _, calls := range []int{0, 2} {
		c := contract(t, brokenOwner{calls: calls})
		actual := 0
		failure(t, c.WithCurrent(context.Background(), func(*Binding) error { actual++; return nil }), "TASK_UNAVAILABLE")
		if actual > 1 {
			t.Fatalf("consumer called %d times", actual)
		}
	}
	consumerErr := errors.New("consumer refused")
	c := contract(t, brokenOwner{calls: 1, ignoreError: true})
	if err := c.WithCurrent(context.Background(), func(*Binding) error { return consumerErr }); err != consumerErr {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	failure(t, c.WithCurrent(ctx, func(*Binding) error { t.Fatal("cancelled inspection"); return nil }), "TASK_REQUEST_CANCELLED")
	failure(t, New(nil).WithCurrent(context.Background(), func(*Binding) error { return nil }), "TASK_UNAVAILABLE")
	if controller, err := admissioncap.New(nil, selected()); controller != nil || err == nil {
		t.Fatal("missing owner admitted")
	}
	if controller, err := admissioncap.New(&owner{}, port.CurrentBinding{}); controller != nil || err == nil {
		t.Fatal("invalid selection admitted")
	}
}
