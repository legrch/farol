package admission_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	admissionsvc "github.com/legrch/farol/modules/chat/app/services/admission"
	admissionct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// currentFixture supplies an injected synchronous owner for contract conformance.
// Its persistence flag is synthetic; it proves no journal, native qualification,
// provider admission, cross-module adapter or boot integration.
type currentFixture struct {
	mu    sync.Mutex
	fixed port.TurnBinding
	view  *port.CurrentTurn
	err   error
}

func (f *currentFixture) Binding() port.TurnBinding { return f.fixed }
func (f *currentFixture) WithCurrent(_ context.Context, inspect func(*port.CurrentTurn) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	if f.view == nil {
		return inspect(nil)
	}
	independent := *f.view
	return inspect(&independent)
}

func reader(t *testing.T) (*currentFixture, *admissionct.Current) {
	t.Helper()
	fixed := port.TurnBinding{ProfileID: "fixture-profile", BackendGeneration: "fixture-backend",
		OwnerID: "fixture-owner", SessionID: "fixture-session", TaskID: "fixture-task",
		TaskEpoch: 17, ParticipantID: "fixture-participant", TurnID: "fixture-turn",
		OperationID: "fixture-operation", TurnGeneration: 3}
	q, err := turn.NewQueue(fixed.ProfileID, fixed.BackendGeneration)
	if err != nil {
		t.Fatal(err)
	}
	view, err := q.Admit(turn.Identity{ProfileID: fixed.ProfileID, OwnerID: fixed.OwnerID,
		SessionID: fixed.SessionID, TaskID: fixed.TaskID, TurnID: fixed.TurnID,
		OperationID: fixed.OperationID, Generation: fixed.TurnGeneration}, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	owner := &currentFixture{fixed: fixed,
		view: &port.CurrentTurn{Binding: fixed, Turn: view, Persistence: port.Committed}}
	service, err := admissionsvc.New(owner)
	if err != nil {
		t.Fatal(err)
	}
	return owner, admissionct.New(service)
}

func TestPublishedBindingIsIndependentUnderTheSameOwnerGate(t *testing.T) {
	owner, current := reader(t)
	want := admissionct.TaskBinding{OwnerID: "fixture-owner", SessionID: "fixture-session",
		TaskID: "fixture-task", TaskEpoch: 17, ParticipantID: "fixture-participant", TurnID: "fixture-turn"}
	for n := 0; n < 2; n++ {
		calls := 0
		err := current.WithCurrent(context.Background(), func(binding *admissionct.TaskBinding) error {
			calls++
			if owner.mu.TryLock() {
				owner.mu.Unlock()
				t.Fatal("public callback escaped the owning gate")
			}
			if binding == nil || *binding != want {
				t.Fatal("binding mapping", binding)
			}
			binding.OwnerID, binding.ParticipantID, binding.TaskEpoch = "consumer-owner", "consumer-participant", 18
			return nil
		})
		if err != nil || calls != 1 {
			t.Fatal(err, calls)
		}
	}
	// The captured route remains fixed when the live owner changes its binding.
	owner.view.Binding.TaskEpoch++
	err := current.WithCurrent(context.Background(), func(*admissionct.TaskBinding) error {
		t.Fatal("rebound task epoch became current for the old route")
		return nil
	})
	requireFailure(t, err, "CHAT_ADMISSION_MISMATCH")
}

func TestKnownAbsenceAndConsumerRejectionRemainDistinct(t *testing.T) {
	owner, current := reader(t)
	owner.view = nil
	calls := 0
	err := current.WithCurrent(context.Background(), func(binding *admissionct.TaskBinding) error {
		calls++
		if binding != nil {
			t.Fatal("absence became a binding")
		}
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatal(err, calls)
	}
	consumer := errors.New("fixed Computer lease rejection")
	if err := current.WithCurrent(context.Background(), func(*admissionct.TaskBinding) error { return consumer }); err != consumer {
		t.Fatal("consumer policy rejection was replaced", err)
	}
}

func TestUnsettledAndUnavailableOwnerErrorsAreClassifiedWithoutInspection(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*currentFixture)
	}{
		{"pending journal", "CHAT_ADMISSION_UNSETTLED", func(f *currentFixture) { f.view.Persistence = port.PendingCommit }},
		{"unknown effect", "CHAT_ADMISSION_UNSETTLED", func(f *currentFixture) { f.view.Turn.Phase = turn.Unknown }},
		{"foreign participant", "CHAT_ADMISSION_MISMATCH", func(f *currentFixture) { f.view.Binding.ParticipantID = "foreign" }},
		{"invalid lifecycle", "CHAT_ADMISSION_INVALID", func(f *currentFixture) { f.view.Turn.Phase = "provider-ready" }},
		{"private owner diagnostic", "CHAT_ADMISSION_UNAVAILABLE", func(f *currentFixture) { f.err = errors.New("private journal path and data") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			owner, current := reader(t)
			test.change(owner)
			err := current.WithCurrent(context.Background(), func(*admissionct.TaskBinding) error {
				t.Fatal("failed owner exposed current admission")
				return nil
			})
			requireFailure(t, err, test.code)
		})
	}
}

func TestCancelledOrInvalidPublicReaderDoesNotInspect(t *testing.T) {
	_, current := reader(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	inspect := func(*admissionct.TaskBinding) error { t.Fatal("invalid inspection"); return nil }
	requireFailure(t, current.WithCurrent(ctx, inspect), "CHAT_ADMISSION_CANCELLED")
	requireFailure(t, current.WithCurrent(nil, inspect), "CHAT_ADMISSION_INVALID")
	requireFailure(t, current.WithCurrent(context.Background(), nil), "CHAT_ADMISSION_INVALID")
	requireFailure(t, admissionct.New(nil).WithCurrent(context.Background(), inspect), "CHAT_ADMISSION_INVALID")
	var absent *admissionct.Current
	requireFailure(t, absent.WithCurrent(context.Background(), inspect), "CHAT_ADMISSION_INVALID")
}

func requireFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *admissionct.Failure
	if !errors.As(err, &failure) || failure.Code != code || failure.Source != "task-admission" || failure.Retry != "never" || err.Error() != code {
		t.Fatal("unclassified or unsafe failure", err)
	}
}
