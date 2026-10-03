package task

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/domain"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

func retainedEvent(t task.Task, n uint64) task.ExecutionEvent {
	return task.ExecutionEvent{RunID: t.ID, DispatchID: t.DispatchID, EventID: "event", StreamID: "stream", Generation: 1, SourceSequence: n, TimestampMillis: 100, Kind: task.ToolStarted, Source: task.RuntimeEvidence, Reference: t.Reference, ItemID: "item"}
}
func TestFilesystemExecutionMetadataRestartsWithoutTouchingAdmissionOrReceipts(t *testing.T) {
	j, m := filesystemFixture(t)
	next := filesystemLaunch(t, j, task.Codex)
	before, _ := j.Read(filesystemCtx, next.ID)
	if err := j.RecordEvent(filesystemCtx, retainedEvent(next, 1)); err != nil {
		t.Fatal(err)
	}
	after, _ := j.Read(filesystemCtx, next.ID)
	if *after != *before {
		t.Fatal("metadata changed task/admission")
	}
	again, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	op, _ := again.Lookup(filesystemCtx, next.DispatchID)
	if len(op.Events.Events) != 1 || op.Receipt.Lifecycle != task.Running {
		t.Fatal(op)
	}
	originalWrites := m.writes
	if err := again.RecordEvent(filesystemCtx, retainedEvent(next, 1)); err != nil || m.writes != originalWrites {
		t.Fatal("duplicate republished", err)
	}
	terminal := filesystemComplete(t, again)
	if err := again.RecordEvent(filesystemCtx, retainedEvent(terminal, 2)); !errors.Is(err, task.ErrState) {
		t.Fatal("late metadata reopened terminal", err)
	}
	if strings.Contains(string(m.data), "PRIVATE_TRANSCRIPT") {
		t.Fatal("transcript retained")
	}
}
func TestFilesystemEventPublicationUnknownKeepsExistingEffectFence(t *testing.T) {
	j, m := filesystemFixture(t)
	next := filesystemLaunch(t, j, task.Codex)
	m.failAfter = true
	if err := j.RecordEvent(filesystemCtx, retainedEvent(next, 1)); !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
	if err := j.RecordEvent(filesystemCtx, retainedEvent(next, 2)); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("unknown retried", err)
	}
	op, err := j.Lookup(filesystemCtx, next.DispatchID)
	if err != nil || len(op.Events.Events) != 1 {
		t.Fatal("published metadata lost", op, err)
	}
}

type blockingEventStore struct {
	*Filesystem
	entered, release chan struct{}
}

func (s *blockingEventStore) RecordEvent(ctx context.Context, e task.ExecutionEvent) error {
	close(s.entered)
	<-s.release
	return s.Filesystem.RecordEvent(ctx, e)
}
func executionOwner(t *testing.T, store port.AdmissionJournal) (*Owner, *Route, *tasksvc.Service) {
	t.Helper()
	o, err := New(store, "task")
	if err != nil {
		t.Fatal(err)
	}
	r, err := o.Select(port.CurrentBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "farol-turn"})
	if err != nil {
		t.Fatal(err)
	}
	s, err := tasksvc.NewOwned(r, filesystemAuthority{filesystemBinding(task.Codex)}, map[task.Provider]port.Provider{task.Codex: filesystemProvider{filesystemReference(task.Codex, "create")}}, nil, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Create(filesystemCtx, tasksvc.CreateRequest{OperationID: "create", TaskID: "task", Message: "bounded fixture", Selection: port.Selection{Provider: task.Codex, ProjectID: "project", WorkspaceID: "writer", ModelAlias: "selected", Effort: "high"}})
	if err != nil {
		t.Fatal(err)
	}
	return o, r, s
}
func TestExecutionMetadataPreservesSelectedProjectionAndCannotUndoFence(t *testing.T) {
	for _, fence := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "fenced"}[fence], func(t *testing.T) {
			j, _ := filesystemFixture(t)
			store := &blockingEventStore{Filesystem: j, entered: make(chan struct{}), release: make(chan struct{})}
			_, route, s := executionOwner(t, store)
			before, _ := j.Read(filesystemCtx, "task")
			event := retainedEvent(before.Task, 1)
			done := make(chan error, 1)
			go func() { done <- s.RecordExecution(filesystemCtx, event) }()
			<-store.entered
			if fence {
				route.Fence()
			}
			close(store.release)
			err := <-done
			if !fence && err != nil || fence && !errors.Is(err, task.ErrUnknown) {
				t.Fatal(err)
			}
			after, _ := j.Read(filesystemCtx, "task")
			if *after != *before {
				t.Fatal("metadata changed admission")
			}
			var active bool
			err = route.WithCurrent(filesystemCtx, func(b *port.CurrentBinding) error { active = b != nil; return nil })
			if !fence && (err != nil || !active) || fence && (err == nil || active) {
				t.Fatal("incorrect projection", active, err)
			}
			if fence {
				if err := route.RecordEvent(filesystemCtx, event); !errors.Is(err, task.ErrUnavailable) {
					t.Fatal("fenced metadata retried", err)
				}
			}
		})
	}
}
func TestExecutionRetainedReadAcrossEpochNeverIssuesAdmission(t *testing.T) {
	j, _ := filesystemFixture(t)
	o, old, s := executionOwner(t, j)
	_, err := s.Result(filesystemCtx, tasksvc.ResultRequest{TaskID: "task"})
	if err != nil {
		t.Fatal(err)
	}
	selection := old.Selection()
	selection.TaskEpoch++
	selection.TurnID = "later-turn"
	current, err := o.Select(selection)
	if err != nil {
		t.Fatal(err)
	}
	service, err := tasksvc.NewOwned(current, filesystemAuthority{filesystemBinding(task.Codex)}, nil, nil, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	out, err := service.Execution(filesystemCtx, tasksvc.ExecutionRequest{TaskID: "task", DispatchID: "create", Limit: 2, IncludeResult: true})
	if err != nil || !out.Retained || out.Result != "final" {
		t.Fatal(out, err)
	}
	if _, err := current.Lookup(filesystemCtx, "create"); !errors.Is(err, task.ErrIdentity) {
		t.Fatal("old dispatch became current", err)
	}
	if err := current.WithCurrent(filesystemCtx, func(b *port.CurrentBinding) error {
		if b != nil {
			t.Fatal("read activated newer epoch")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	selection.ParticipantID = "foreign"
	foreign, _ := o.Select(selection)
	if _, err := foreign.LookupRetained(filesystemCtx, "create"); !errors.Is(err, task.ErrIdentity) {
		t.Fatal("foreign retained access", err)
	}
}
