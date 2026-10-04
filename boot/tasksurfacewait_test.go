package boot

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	"github.com/legrch/farol/transport/desktop"
)

// One controlled parent-gate wait exercises actual Root/profile/address-map
// lifetimes. The wait deliberately stalls a CPU owner; no host process is probed.
func TestTaskSurfaceSelectionWaitAllowsReadAndClosePreventsPublication(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	ctx := context.Background()
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(ctx, f.input)
	if err != nil {
		t.Fatal(err)
	}
	methods := s.Methods()
	create := desktop.Request{RequestID: "create-request", OperationID: "create", Body: json.RawMessage(taskSurfaceBody(t, h, wire.TaskCreate{Message: "original"}))}
	if out, err := methods["task.create"].Handle(ctx, create); err != nil || out == nil || out.Status != "ok" {
		t.Fatal(out, err)
	}
	current, err := f.parent.handle.Admission()
	if err != nil {
		t.Fatal(err)
	}
	held, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	holderDone := make(chan error, 1)
	go func() {
		holderDone <- current.WithCurrent(ctx, func(*chatct.TaskBinding) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	selected := make(chan error, 1)
	in := f.input
	in.Scope.TaskEpoch = 2
	in.Scope.TurnID = "late-selection"
	go func() {
		value, err := s.SelectCodex(ctx, in)
		if err == nil || value != nil {
			selected <- errors.New("closed profile published a late selected handle")
			return
		}
		selected <- nil
	}()
	if err = taskSurfaceWaitForSelectionGate(); err != nil {
		t.Fatal(err)
	}
	read := desktop.Request{RequestID: "read-request", Body: json.RawMessage(taskSurfaceBody(t, h, wire.TaskOperationRequest{OperationId: "create"}))}
	readDone := make(chan error, 1)
	go func() {
		out, err := methods["task.operation.status"].Handle(ctx, read)
		if err == nil && (out == nil || out.Status != "ok") {
			err = errors.New("existing operation read was not available")
		}
		readDone <- err
	}()
	select {
	case err := <-readDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("selection held the address map during its parent wait")
	}
	if err = f.profile.Close(ctx); err != nil {
		t.Fatal(err)
	}
	// Release through a nested helper so the deferred close above remains the
	// only close: selection completion is checked by a cleanup registered now.
	t.Cleanup(func() {
		if err := <-holderDone; err != nil {
			t.Error(err)
		}
		select {
		case err := <-selected:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("closed selection did not finish")
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.handles) != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 {
			t.Error("late selection published a handle or another provider effect")
		}
	})
}

func taskSurfaceWaitForSelectionGate() error {
	deadline := time.Now().Add(2 * time.Second)
	buffer := make([]byte, 1<<20)
	for time.Now().Before(deadline) {
		for _, stack := range strings.Split(string(buffer[:runtime.Stack(buffer, true)]), "\n\n") {
			if strings.Contains(stack, "boot.(*TaskSurface).SelectCodex") &&
				strings.Contains(stack, "modules/chat/infra/gate.(*Mutex).Lock") &&
				strings.Contains(stack, "[sync.Mutex.Lock]") {
				return nil
			}
		}
		runtime.Gosched()
	}
	return errors.New("selected Task facade did not reach the held parent gate")
}

func TestTaskSurfaceForeignHandleAndMethodIdentityCannotQualifyProvider(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	s, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	h, err := s.SelectCodex(context.Background(), f.input)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		surface *TaskSurface
		method  string
		op      string
		body    string
	}{
		{foreign, "task.create", "other-surface", taskSurfaceBody(t, h, wire.TaskCreate{Message: "foreign handle"})},
		{s, "task.resolve", "forbidden-read-effect", taskSurfaceBody(t, h, nil)},
		{s, "task.create", "", taskSurfaceBody(t, h, wire.TaskCreate{Message: "missing stable effect id"})},
	} {
		out, err := sample.surface.Methods()[sample.method].Handle(context.Background(), desktop.Request{RequestID: "request", OperationID: sample.op, Body: json.RawMessage(sample.body)})
		if err == nil && out != nil && out.Status == "ok" {
			t.Fatal("foreign handle/method acquired provider authority")
		}
	}
	if f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("invalid address/effect reached qualification or admission")
	}
}
