package codex

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	task "github.com/legrch/farol/modules/task/domain"
)

func TestSourceOnlySelectedCreateAndObserve(t *testing.T) {
	c, f := newFixture(t)
	if f.checks.Load() != 0 || f.launches.Load() != 0 {
		t.Fatal("constructor performed host operations")
	}
	caps, err := c.Supports(context.Background(), c.selection.Binding)
	if err != nil || caps != (task.Capabilities{Create: true, Message: true}) {
		t.Fatalf("capabilities: %+v %v", caps, err)
	}
	var refs []task.Reference
	r, err := c.Create(context.Background(), dispatch(c.selection, "operation-one"), func(ref task.Reference) error { refs = append(refs, ref); return nil })
	if err != nil || r.State != task.Known || r.Reference != completeRef() || r.Lifecycle != task.Running {
		t.Fatalf("create: %+v %v", r, err)
	}
	if !reflect.DeepEqual(refs, []task.Reference{{ThreadID: "thread-exact"}, completeRef()}) {
		t.Fatalf("lineage: %+v", refs)
	}
	if f.launches.Load() != 1 || len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 {
		t.Fatal("wrong proxy/effect count")
	}
	start := f.seen("thread/start")[0].params
	turn := f.seen("turn/start")[0].params
	if !equals(start, "projectId", c.selection.Binding.ProjectID) || !equals(start, "cwd", c.selection.Binding.Writer.Path) || !equals(start, "model", c.selection.Binding.Model) {
		t.Fatal("thread route not exact")
	}
	if fallback, ok := boolean(start, "allowProviderModelFallback"); !ok || fallback {
		t.Fatal("model fallback enabled")
	}
	if ephemeral, ok := boolean(start, "ephemeral"); !ok || ephemeral {
		t.Fatal("persistent thread not requested")
	}
	policy, ok := object(turn, "sandboxPolicy")
	network, haveNetwork := boolean(policy, "networkAccess")
	roots, haveRoots := array(policy, "writableRoots", 1)
	if !equals(turn, "threadId", "thread-exact") || !equals(turn, "effort", "high") || !ok || !haveNetwork || network || !haveRoots || string(roots[0]) != `"/fixture/writer"` {
		t.Fatal("turn policy not exact")
	}
	o, err := c.Observe(context.Background(), c.selection.Binding, completeRef())
	if err != nil || o.Reference != completeRef() || o.Lifecycle != task.Completed || o.Result != "source-only final" {
		t.Fatalf("observe: %+v %v", o, err)
	}
	if f.launches.Load() != 1 {
		t.Fatal("observation reconnected")
	}
}
func TestSourceOnlyUnsupportedControlsDoNotLaunch(t *testing.T) {
	c, f := newFixture(t)
	d := dispatch(c.selection, "unsupported")
	for _, method := range []task.Action{task.Continue, task.Cancel} {
		var r task.Receipt
		var err error
		switch method {
		case task.Continue:
			r, err = c.Continue(context.Background(), d, nil)
		case task.Cancel:
			r, err = c.Cancel(context.Background(), d, nil)
		}
		if !errors.Is(err, task.ErrUnsupported) || r.State != task.Rejected {
			t.Fatalf("%s: %+v %v", method, r, err)
		}
	}
	if f.launches.Load() != 0 || f.checks.Load() != 0 {
		t.Fatal("unsupported control reached boundary")
	}
}
func TestSourceOnlyRecheckAfterThreadPreventsTurn(t *testing.T) {
	for _, mode := range []string{"physical", "grant", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			valid := true
			now := c.now()
			c.recheck = func(context.Context, task.Binding) error {
				if !valid {
					return task.ErrIdentity
				}
				return nil
			}
			c.now = func() time.Time { return now }
			r, _ := c.Create(context.Background(), dispatch(c.selection, "changed-selection"), func(task.Reference) error {
				switch mode {
				case "physical":
					f.valid.Store(false)
				case "grant":
					valid = false
				case "expiry":
					now = c.selection.ExpiresAt
				}
				return nil
			})
			if r.State != task.Uncertain || r.Reference.ThreadID != "thread-exact" || len(f.seen("turn/start")) != 0 {
				t.Fatalf("changed selection: %+v", r)
			}
		})
	}
}
func TestSourceOnlyOperationFenceRetainsAndRejectsConflict(t *testing.T) {
	c, f := newFixture(t)
	d := dispatch(c.selection, "operation-fence")
	first, _ := c.Create(context.Background(), d, func(task.Reference) error { return nil })
	if first.State != task.Known {
		t.Fatal(first)
	}
	again, _ := c.Create(context.Background(), d, func(task.Reference) error { t.Fatal("replay callback"); return nil })
	if again.State != task.Uncertain {
		t.Fatal(again)
	}
	d.Message = "changed source-only request"
	conflict, _ := c.Create(context.Background(), d, func(task.Reference) error { return nil })
	if conflict.State != task.Rejected || conflict.Code != "CODEX_OPERATION_CONFLICT" {
		t.Fatal(conflict)
	}
	if len(f.seen("thread/start")) != 1 || len(f.seen("turn/start")) != 1 {
		t.Fatal("replayed provider effect")
	}
}
