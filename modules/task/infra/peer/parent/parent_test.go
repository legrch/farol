package parent

// CPU contract doubles only: no actual Chat owner construction, native root,
// storage, provider, process or delivery qualification is exercised here.
import (
	"context"
	"errors"
	"sync"
	"testing"

	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/task/domain"
)

type currentDouble struct {
	calls int
	check func(context.Context, func(*chatct.TaskBinding) error) error
}

func (d *currentDouble) WithCurrent(ctx context.Context, inspect func(*chatct.TaskBinding) error) error {
	d.calls++
	return d.check(ctx, inspect)
}
func selection() Selection {
	return Selection{Parent: task.Parent{ThreadID: "external-parent-thread", TurnID: "external-parent-turn"},
		Binding: Binding{OwnerID: "owner", SessionID: "chat-session", TaskID: "chat-task", TaskEpoch: 7, ParticipantID: "chat-participant", TurnID: "chat-turn"}}
}
func projection(s Selection) *chatct.TaskBinding {
	b := s.Binding
	return &chatct.TaskBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
}
func requirePeer(t *testing.T, d current, s Selection) *Peer {
	t.Helper()
	p, err := newPeer(d, s)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func requireError(t *testing.T, got, want error) {
	t.Helper()
	if !errors.Is(got, want) {
		t.Fatalf("got %v; want %v", got, want)
	}
}

func TestTrustedAssociationIsExplicitAndEveryCheckIsFresh(t *testing.T) {
	selected := selection()
	active := true
	d := &currentDouble{check: func(_ context.Context, inspect func(*chatct.TaskBinding) error) error {
		if !active {
			return inspect(nil)
		}
		return inspect(projection(selection()))
	}}
	p := requirePeer(t, d, selected)
	if d.calls != 0 {
		t.Fatal("constructor observed owner")
	}
	selected.Parent.ThreadID = "changed-after-selection"
	selected.Binding.TaskEpoch++
	if err := p.RecheckParent(context.Background(), selection().Parent); err != nil {
		t.Fatal(err)
	}
	active = false
	requireError(t, p.RecheckParent(context.Background(), selection().Parent), task.ErrState)
	if d.calls != 2 {
		t.Fatal("positive parent check was cached")
	}
}
func TestForeignParentStopsBeforeOwner(t *testing.T) {
	d := &currentDouble{check: func(context.Context, func(*chatct.TaskBinding) error) error {
		t.Fatal("foreign parent inspected")
		return nil
	}}
	p := requirePeer(t, d, selection())
	for _, requested := range []task.Parent{{}, {ThreadID: "foreign", TurnID: selection().Parent.TurnID}, {ThreadID: selection().Parent.ThreadID, TurnID: "foreign"}, {ThreadID: selection().Binding.TaskID, TurnID: selection().Binding.TurnID}} {
		requireError(t, p.RecheckParent(context.Background(), requested), task.ErrIdentity)
	}
	if d.calls != 0 {
		t.Fatal("parent IDs selected an owner")
	}
}
func TestEveryChatBindingComponentIsRequired(t *testing.T) {
	changes := []struct {
		name   string
		change func(*chatct.TaskBinding)
	}{
		{"owner", func(b *chatct.TaskBinding) { b.OwnerID = "foreign" }},
		{"session", func(b *chatct.TaskBinding) { b.SessionID = "foreign" }},
		{"task", func(b *chatct.TaskBinding) { b.TaskID = "foreign" }},
		{"epoch", func(b *chatct.TaskBinding) { b.TaskEpoch++ }},
		{"participant", func(b *chatct.TaskBinding) { b.ParticipantID = "foreign" }},
		{"turn", func(b *chatct.TaskBinding) { b.TurnID = "foreign" }},
		{"incomplete", func(b *chatct.TaskBinding) { b.OwnerID = "" }},
	}
	for _, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			d := &currentDouble{check: func(_ context.Context, inspect func(*chatct.TaskBinding) error) error {
				b := projection(selection())
				change.change(b)
				return inspect(b)
			}}
			requireError(t, requirePeer(t, d, selection()).RecheckParent(context.Background(), selection().Parent), task.ErrIdentity)
			if d.calls != 1 {
				t.Fatal("check retried")
			}
		})
	}
}
func TestOwnerCallbackProtocolCannotInventSuccess(t *testing.T) {
	cases := []struct {
		name  string
		check func(context.Context, func(*chatct.TaskBinding) error) error
		want  error
	}{
		{"absent", func(_ context.Context, f func(*chatct.TaskBinding) error) error { return f(nil) }, task.ErrState},
		{"missing callback", func(context.Context, func(*chatct.TaskBinding) error) error { return nil }, task.ErrUnavailable},
		{"duplicate callback", func(_ context.Context, f func(*chatct.TaskBinding) error) error {
			_ = f(projection(selection()))
			_ = f(projection(selection()))
			return nil
		}, task.ErrUnavailable},
		{"swallowed inactive", func(_ context.Context, f func(*chatct.TaskBinding) error) error { _ = f(nil); return nil }, task.ErrState},
		{"swallowed mismatch", func(_ context.Context, f func(*chatct.TaskBinding) error) error {
			b := projection(selection())
			b.TurnID = "stale"
			_ = f(b)
			return nil
		}, task.ErrIdentity},
		{"late owner failure", func(_ context.Context, f func(*chatct.TaskBinding) error) error {
			_ = f(projection(selection()))
			return errors.New("raw diagnostic")
		}, task.ErrUnavailable},
		{"classified mismatch", func(context.Context, func(*chatct.TaskBinding) error) error {
			return &chatct.Failure{Code: "CHAT_ADMISSION_MISMATCH"}
		}, task.ErrIdentity},
		{"classified cancellation", func(context.Context, func(*chatct.TaskBinding) error) error {
			return &chatct.Failure{Code: "CHAT_ADMISSION_CANCELLED"}
		}, context.Canceled},
		{"raw owner error", func(context.Context, func(*chatct.TaskBinding) error) error { return errors.New("raw diagnostic") }, task.ErrUnavailable},
		{"unsettled", func(context.Context, func(*chatct.TaskBinding) error) error {
			return &chatct.Failure{Code: "CHAT_ADMISSION_UNSETTLED"}
		}, task.ErrUnavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := &currentDouble{check: c.check}
			requireError(t, requirePeer(t, d, selection()).RecheckParent(context.Background(), selection().Parent), c.want)
			if d.calls != 1 {
				t.Fatal("owner failure retried")
			}
		})
	}
}
func TestCancellationBeforeInsideAndAfterCallback(t *testing.T) {
	for _, stage := range []string{"before", "inside", "after"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			d := &currentDouble{check: func(_ context.Context, f func(*chatct.TaskBinding) error) error {
				if stage == "inside" {
					cancel()
				}
				_ = f(projection(selection()))
				if stage == "after" {
					cancel()
				}
				return nil
			}}
			p := requirePeer(t, d, selection())
			if stage == "before" {
				cancel()
			}
			requireError(t, p.RecheckParent(ctx, selection().Parent), context.Canceled)
			if stage == "before" && d.calls != 0 || stage != "before" && d.calls != 1 {
				t.Fatal("cancelled check observed or retried unexpectedly")
			}
		})
	}
}
func TestInvalidConstructionAndMissingFacadeRefuse(t *testing.T) {
	if _, err := New(nil, selection()); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	if _, err := newPeer(nil, selection()); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	invalid := []Selection{selection(), selection(), selection(), selection(), selection(), selection(), selection(), selection()}
	invalid[0].Parent.ThreadID = ""
	invalid[1].Parent.TurnID = ""
	invalid[2].Binding.OwnerID = ""
	invalid[3].Binding.SessionID = ""
	invalid[4].Binding.TaskID = ""
	invalid[5].Binding.TaskEpoch = 0
	invalid[6].Binding.ParticipantID = ""
	invalid[7].Binding.TurnID = ""
	for _, s := range invalid {
		_, err := New(&chatct.Current{}, s)
		requireError(t, err, task.ErrInvalid)
	}
	p, err := New(&chatct.Current{}, selection())
	if err != nil {
		t.Fatal(err)
	}
	requireError(t, p.RecheckParent(context.Background(), selection().Parent), task.ErrUnavailable)
	var missing *Peer
	requireError(t, missing.RecheckParent(context.Background(), selection().Parent), task.ErrUnavailable)
	requireError(t, p.RecheckParent(nil, selection().Parent), task.ErrUnavailable)
}
func TestConcurrentChecksHaveNoSharedPositiveState(t *testing.T) {
	p := requirePeer(t, concurrentCurrent{}, selection())
	var group sync.WaitGroup
	for i := 0; i < 16; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := p.RecheckParent(context.Background(), selection().Parent); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
}

type concurrentCurrent struct{}

func (concurrentCurrent) WithCurrent(_ context.Context, f func(*chatct.TaskBinding) error) error {
	return f(projection(selection()))
}
