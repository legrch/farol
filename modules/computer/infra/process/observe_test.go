package process

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure value/measurement doubles only. No filesystem, process, shell,
// qualification, timer, admission, app, profile or provider is exercised.
func observationSelection() processsvc.ObservedWorkspace {
	return processsvc.ObservedWorkspace{WorkspaceID: "code", Root: "/workspace/code", RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}
}

func TestWorkspaceObservationPureFixedSelectionAndEveryCall(t *testing.T) {
	selected := observationSelection()
	original := selected
	calls := 0
	w, err := newObservationWorkspace(selected, func(_ context.Context, root port.Root) (port.Root, error) {
		calls++
		if root != (port.Root{Path: original.Root, Device: "1", Inode: "2"}) {
			t.Fatal("measurement selected replacement values", root)
		}
		return root, nil
	})
	if err != nil || calls != 0 {
		t.Fatal("construction observed the host", err)
	}
	selected.Root = "/replacement"
	selected.RootIdentity.Inode = "3"
	for i := 0; i < 3; i++ {
		out, err := w.ObserveWorkspace(context.Background())
		if err != nil || out == nil || *out != original || calls != i+1 {
			t.Fatal("observation was cached or rebound", out, err)
		}
		out.WorkspaceID = "replacement"
		out.RootIdentity.Inode = "4"
	}
	if w.selected != original {
		t.Fatal("returned value aliased original selection")
	}
}

func TestWorkspaceObservationPureBoundaryFailuresRefuseWithoutRetry(t *testing.T) {
	for _, mode := range []string{"error", "empty", "path", "device", "inode", "cancel-during"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			w, err := newObservationWorkspace(observationSelection(), func(_ context.Context, root port.Root) (port.Root, error) {
				calls++
				switch mode {
				case "error":
					return port.Root{}, errors.New("private native detail /private/root")
				case "empty":
					return port.Root{}, nil
				case "path":
					root.Path = "/replacement"
				case "device":
					root.Device = "3"
				case "inode":
					root.Inode = "3"
				case "cancel-during":
					cancel()
				}
				return root, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			out, err := w.ObserveWorkspace(ctx)
			var failure *processsvc.NativeFailure
			if out != nil || !errors.As(err, &failure) || failure.Unknown || err.Error() != "PROCESS_NATIVE_UNAVAILABLE" || calls != 1 {
				t.Fatal("bad measurement accepted/leaked/retried", out, err, calls)
			}
		})
	}
}

func TestWorkspaceObservationPureInvalidInputAndCancelledBeforeMeasure(t *testing.T) {
	for _, change := range []func(*processsvc.ObservedWorkspace){
		func(s *processsvc.ObservedWorkspace) { s.WorkspaceID = "" },
		func(s *processsvc.ObservedWorkspace) { s.WorkspaceID = "body/path" },
		func(s *processsvc.ObservedWorkspace) { s.Root = "/" },
		func(s *processsvc.ObservedWorkspace) { s.Root = "relative" },
		func(s *processsvc.ObservedWorkspace) { s.Root = "/workspace/../other" },
		func(s *processsvc.ObservedWorkspace) { s.RootIdentity.Device = "" },
		func(s *processsvc.ObservedWorkspace) { s.RootIdentity.Device = "01" },
		func(s *processsvc.ObservedWorkspace) { s.RootIdentity.Inode = "-1" },
		func(s *processsvc.ObservedWorkspace) { s.RootIdentity.Inode = "18446744073709551616" },
	} {
		selected := observationSelection()
		change(&selected)
		calls := 0
		w, err := newObservationWorkspace(selected, func(_ context.Context, root port.Root) (port.Root, error) { calls++; return root, nil })
		if w != nil || err == nil || calls != 0 {
			t.Fatal("invalid original selection accepted", selected, err)
		}
	}
	if w, err := newObservationWorkspace(observationSelection(), nil); w != nil || err == nil {
		t.Fatal("missing boundary accepted")
	}
	calls := 0
	w, err := newObservationWorkspace(observationSelection(), func(_ context.Context, root port.Root) (port.Root, error) { calls++; return root, nil })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, ctx := range []context.Context{nil, ctx} {
		if out, err := w.ObserveWorkspace(ctx); out != nil || err == nil || calls != 0 {
			t.Fatal("cancelled/absent context measured workspace", out, err)
		}
	}
	var absent *WorkspaceObservation
	if out, err := absent.ObserveWorkspace(context.Background()); out != nil || err == nil {
		t.Fatal("nil producer observed")
	}
}

func TestWorkspaceObservationPurePublicAPIHasNoExecutionOrPathSelector(t *testing.T) {
	shape := reflect.TypeOf((*WorkspaceObservation)(nil))
	if shape.NumMethod() != 1 || shape.Method(0).Name != "ObserveWorkspace" || shape.Method(0).Type.NumIn() != 2 {
		t.Fatal("producer exposes request path, admission or execution controls")
	}
	for _, field := range []string{"lease", "deadline", "clock", "process", "command", "policy", "qualification"} {
		if _, ok := shape.Elem().FieldByName(field); ok {
			t.Fatal("producer retains execution/policy state", field)
		}
	}
}
