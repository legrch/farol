package admission

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	taskct "github.com/legrch/farol/modules/task/contracts/admission"
)

// These are injected published-contract doubles, not real Chat/Task owners.
// Their gates/persistence errors prove adapter mapping/protocol only. They do
// not prove actual admission, no-IO owner entry, a journal or production wiring.
type sourceFixture[T any] struct {
	gate       sync.Mutex
	binding    *T
	failure    error
	callbacks  int
	swallow    bool
	afterError error
	before     func()
	entries    int
}

func (f *sourceFixture[T]) WithCurrent(_ context.Context, inspect func(*T) error) error {
	f.gate.Lock()
	defer f.gate.Unlock()
	f.entries++
	if f.failure != nil {
		return f.failure
	}
	if f.before != nil {
		f.before()
	}
	for range f.callbacks {
		var out *T
		if f.binding != nil {
			copy := *f.binding
			out = &copy
		}
		if err := inspect(out); err != nil && !f.swallow {
			return err
		}
	}
	return f.afterError
}
func (f *sourceFixture[T]) absent() {
	f.gate.Lock()
	defer f.gate.Unlock()
	f.binding = nil
}
func (f *sourceFixture[T]) fail(err error) {
	f.gate.Lock()
	defer f.gate.Unlock()
	f.failure = err
}
func (f *sourceFixture[T]) protocol(calls int, swallow bool) {
	f.callbacks, f.swallow = calls, swallow
}
func (f *sourceFixture[T]) after(err error)       { f.afterError = err }
func (f *sourceFixture[T]) onEntry(before func()) { f.before = before }
func (f *sourceFixture[T]) mutex() *sync.Mutex    { return &f.gate }
func (f *sourceFixture[T]) calls() int            { return f.entries }

type control interface {
	absent()
	fail(error)
	protocol(int, bool)
	after(error)
	onEntry(func())
	mutex() *sync.Mutex
	calls() int
}
type peerFixture struct {
	peer                              port.CurrentTaskAdmission
	owner                             control
	mismatch, unsettled, cancellation error
}

func selected() port.TaskBinding {
	return port.TaskBinding{Identity: authority.Identity{OwnerID: "owner",
		SessionID: "authority-session", TaskID: "selected-task", TaskEpoch: 9007199254740993},
		ParticipantID: "participant", TurnID: "selected-turn"}
}
func peer(t *testing.T, kind string) peerFixture {
	t.Helper()
	b := selected()
	switch kind {
	case "chat":
		current := chatct.TaskBinding{OwnerID: b.OwnerID, SessionID: b.SessionID,
			TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
		owner := &sourceFixture[chatct.TaskBinding]{binding: &current, callbacks: 1}
		return peerFixture{peer: &Chat{current: owner}, owner: owner,
			mismatch:     &chatct.Failure{Code: "CHAT_ADMISSION_MISMATCH", Source: "task-admission", Retry: "never"},
			unsettled:    &chatct.Failure{Code: "CHAT_ADMISSION_UNSETTLED", Source: "task-admission", Retry: "never"},
			cancellation: &chatct.Failure{Code: "CHAT_ADMISSION_CANCELLED", Source: "task-admission", Retry: "never"}}
	case "task":
		current := taskct.Binding{OwnerID: b.OwnerID, SessionID: b.SessionID,
			TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}
		owner := &sourceFixture[taskct.Binding]{binding: &current, callbacks: 1}
		return peerFixture{peer: &Task{current: owner}, owner: owner,
			mismatch:     &taskct.Failure{Code: "TASK_IDENTITY_MISMATCH"},
			unsettled:    &taskct.Failure{Code: "TASK_UNAVAILABLE"},
			cancellation: &taskct.Failure{Code: "TASK_REQUEST_CANCELLED"}}
	default:
		t.Fatal("unknown fixture route")
		return peerFixture{}
	}
}
func requireFailure(t *testing.T, err error, code, source string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != code || f.Source != source || f.Retry != "never" {
		t.Fatalf("want %s/%s/never, got %v", code, source, err)
	}
}

func TestPublishedBindingCopiesEveryFieldUnderTheSelectedGate(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		t.Run(kind, func(t *testing.T) {
			f := peer(t, kind)
			for range 2 {
				err := f.peer.WithCurrent(context.Background(), func(b *port.TaskBinding) error {
					if f.owner.mutex().TryLock() {
						f.owner.mutex().Unlock()
						t.Fatal("inspection escaped the source owner gate")
					}
					if b == nil || *b != selected() {
						t.Fatal("mapping lost owner/session/task/epoch/participant/turn", b)
					}
					*b = port.TaskBinding{}
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if f.owner.calls() != 2 {
				t.Fatal("current source was cached")
			}
		})
	}
}

func TestKnownAbsenceAndUnsettledOwnerNeverReusePreviousPositive(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		t.Run(kind, func(t *testing.T) {
			f := peer(t, kind)
			if err := f.peer.WithCurrent(context.Background(), func(b *port.TaskBinding) error {
				if b == nil {
					t.Fatal("missing first fixture binding")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			f.owner.absent()
			if err := f.peer.WithCurrent(context.Background(), func(b *port.TaskBinding) error {
				if b != nil {
					t.Fatal("cached positive survived revocation")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			f.owner.fail(f.unsettled)
			requireFailure(t, f.peer.WithCurrent(context.Background(), func(*port.TaskBinding) error {
				t.Fatal("unsettled owner became absent or positive")
				return nil
			}), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
		})
	}
}

func TestOwnerFailuresUseExistingClosedComputerVocabulary(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		for _, failure := range []string{"mismatch", "unsettled", "cancelled", "raw", "future"} {
			t.Run(kind+"/"+failure, func(t *testing.T) {
				f := peer(t, kind)
				code, source := "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"
				err := errors.New("private owner persistence diagnostic")
				switch failure {
				case "mismatch":
					err, code, source = f.mismatch, "AUTHORITY_TASK_MISMATCH", "task-grant"
				case "unsettled":
					err = f.unsettled
				case "cancelled":
					err, code, source = f.cancellation, "WORKSPACE_REQUEST_CANCELLED", "native-workspace"
				case "future":
					if kind == "chat" {
						err = &chatct.Failure{Code: "FUTURE_OWNER_CODE", Source: "private", Retry: "later"}
					} else {
						err = &taskct.Failure{Code: "FUTURE_OWNER_CODE"}
					}
				}
				f.owner.fail(fmt.Errorf("wrapped owner failure: %w", err))
				requireFailure(t, f.peer.WithCurrent(context.Background(), func(*port.TaskBinding) error {
					t.Fatal("failed owner inspected")
					return nil
				}), code, source)
			})
		}
	}
}

func TestConsumerRejectionsRemainOriginalIncludingUnknown(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		for _, absent := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/absent=%v", kind, absent), func(t *testing.T) {
				f := peer(t, kind)
				if absent {
					f.owner.absent()
				}
				f.owner.protocol(2, true)
				f.owner.after(errors.New("later source failure"))
				unknown := fmt.Errorf("retained uncertainty: %w",
					authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
				if got := f.peer.WithCurrent(context.Background(), func(*port.TaskBinding) error {
					return unknown
				}); got != unknown {
					t.Fatal("original consumer unknown replaced", got)
				}
			})
		}
	}
}

func TestBrokenProtocolOrFailureAfterInspectionCannotBecomeSuccess(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		for _, calls := range []int{0, 2} {
			t.Run(fmt.Sprintf("%s/calls=%d", kind, calls), func(t *testing.T) {
				f := peer(t, kind)
				f.owner.protocol(calls, true)
				inspected := 0
				requireFailure(t, f.peer.WithCurrent(context.Background(), func(*port.TaskBinding) error {
					inspected++
					return nil
				}), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
				if inspected > 1 {
					t.Fatal("consumer was called twice")
				}
			})
		}
		t.Run(kind+"/late owner failure", func(t *testing.T) {
			f := peer(t, kind)
			f.owner.after(errors.New("private post-inspection failure"))
			requireFailure(t, f.peer.WithCurrent(context.Background(), func(*port.TaskBinding) error {
				return nil
			}), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
		})
	}
}

func TestCancellationAndInvalidInspectionNeverAdmit(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		for _, stage := range []string{"before", "at owner entry", "after inspection"} {
			t.Run(kind+"/"+stage, func(t *testing.T) {
				f := peer(t, kind)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if stage == "before" {
					cancel()
				}
				if stage == "at owner entry" {
					f.owner.onEntry(cancel)
				}
				requireFailure(t, f.peer.WithCurrent(ctx, func(*port.TaskBinding) error {
					if stage != "after inspection" {
						t.Fatal("cancelled caller inspected")
					}
					cancel()
					return nil
				}), "WORKSPACE_REQUEST_CANCELLED", "native-workspace")
				if stage == "before" && f.owner.calls() != 0 {
					t.Fatal("cancelled caller entered owner")
				}
			})
		}
		f := peer(t, kind)
		requireFailure(t, f.peer.WithCurrent(nil, func(*port.TaskBinding) error {
			t.Fatal("nil context inspected")
			return nil
		}), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
		requireFailure(t, f.peer.WithCurrent(context.Background(), nil),
			"COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
		if f.owner.calls() != 0 {
			t.Fatal("invalid call entered owner")
		}
	}
}

func TestProductionConstructorsRequirePublishedOwnersButCreateNoAdmission(t *testing.T) {
	if out, err := NewChat(nil); out != nil || err == nil {
		t.Fatal("nil Chat source constructed")
	}
	if out, err := NewTask(nil); out != nil || err == nil {
		t.Fatal("nil Task source constructed")
	}
	// Non-nil published contracts without app owners can be wrapped, but cannot
	// provide positive admission. Tests do not import neighbor app/domain/infra.
	chat, err := NewChat(chatct.New(nil))
	if err != nil {
		t.Fatal(err)
	}
	task, err := NewTask(taskct.New(nil))
	if err != nil {
		t.Fatal(err)
	}
	var nilChat *Chat
	var nilTask *Task
	for _, current := range []port.CurrentTaskAdmission{chat, task, nilChat, nilTask, &Chat{}, &Task{}} {
		requireFailure(t, current.WithCurrent(context.Background(), func(*port.TaskBinding) error {
			t.Fatal("construction became positive authority")
			return nil
		}), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
}
