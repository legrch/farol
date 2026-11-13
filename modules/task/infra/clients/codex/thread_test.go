package codex

// Controlled pipe/journal evidence only: no provider, process, credentials,
// native socket or filesystem qualification is exercised by these tests.
import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/contracts/observation"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	providerevents "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

func selectedReadSelection(c *Client) selectedthread.Selection {
	b := c.selection.Binding
	root := func(r task.Root) control.Root {
		return control.Root{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	return selectedthread.Selection{Binding: control.Binding{Provider: control.Codex, ProfileID: b.ProfileID,
		HostID: b.HostID, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, Project: root(b.Project), Writer: root(b.Writer),
		ModelAlias: b.ModelAlias, Model: b.Model, Effort: b.Effort, ConfigDigest: b.ConfigDigest},
		Reference: control.Reference{ThreadID: "thread-exact", TurnID: "turn-exact"}}
}

func readFailureCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *selectedthread.Failure
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func noReadEffects(t *testing.T, f *pipeFixture) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, q := range f.requests {
		switch q.method {
		case "initialize", "thread/read", "thread/turns/list", "thread/items/list":
		default:
			t.Fatalf("selected read invoked %s", q.method)
		}
	}
}

func TestSelectedThreadReadIsInertExactAndResultOptIn(t *testing.T) {
	c, f := newFixture(t)
	c.dispatchRecheck = nil // Source-compatible reads do not require effects.
	selected := selectedReadSelection(c)
	checks := 0
	r, err := NewSelectedThreadReader(c, selected, func(_ context.Context, got selectedthread.Selection) error {
		checks++
		if got != selected {
			t.Fatal("selection changed", got)
		}
		return nil
	})
	if err != nil || checks != 0 || f.checks.Load() != 0 || f.launches.Load() != 0 {
		t.Fatal("construction performed IO", err)
	}
	for _, include := range []bool{false, true} {
		out, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: include})
		if err != nil || out.Selection != selected || out.Lifecycle != control.Completed || out.Source != "stored" || out.Snapshot != "non_atomic" || out.Retained || out.ResultEvidence != "provider_history" {
			t.Fatal(out, err)
		}
		want := ""
		if include {
			want = "source-only final"
		}
		if out.Text != want {
			t.Fatal("result opt-in failed", out)
		}
	}
	if checks < 4 || f.launches.Load() != 1 || len(f.seen("thread/read")) != 4 {
		t.Fatal("missing post-read checks or replaced connection", checks, f.launches.Load())
	}
	for _, q := range f.seen("thread/read") {
		if !equals(q.params, "threadId", selected.Reference.ThreadID) || string(q.params["includeTurns"]) != "false" {
			t.Fatal("unbound thread read", q.params)
		}
	}
	for _, q := range f.seen("thread/items/list") {
		if !equals(q.params, "threadId", selected.Reference.ThreadID) || !equals(q.params, "turnId", selected.Reference.TurnID) {
			t.Fatal("unbound item read", q.params)
		}
	}
	noReadEffects(t, f)
}

func TestSelectedThreadReadRejectsCrossedSelectionWithoutIO(t *testing.T) {
	for _, field := range []string{"provider", "profile", "host", "project", "writer", "physical-project", "physical-writer", "git", "model", "effort", "config", "session", "invocation", "partial", "malformed"} {
		t.Run(field, func(t *testing.T) {
			c, f := newFixture(t)
			s := selectedReadSelection(c)
			switch field {
			case "provider":
				s.Binding.Provider = control.Claude
			case "profile":
				s.Binding.ProfileID = "foreign"
			case "host":
				s.Binding.HostID = "foreign"
			case "project":
				s.Binding.ProjectID = "foreign"
			case "writer":
				s.Binding.WorkspaceID = "foreign"
			case "physical-project":
				s.Binding.Project.Inode = "foreign"
			case "physical-writer":
				s.Binding.Writer.Inode = "foreign"
			case "git":
				s.Binding.Writer.GitCommonDirectory = "/foreign/.git"
			case "model":
				s.Binding.Model = "foreign"
			case "effort":
				s.Binding.Effort = "foreign"
			case "config":
				s.Binding.ConfigDigest = strings.Repeat("f", 64)
			case "session":
				s.Reference.SessionID = "foreign"
			case "invocation":
				s.Reference.InvocationID = "foreign"
			case "partial":
				s.Reference.TurnID = ""
			case "malformed":
				s.Reference.ThreadID = "foreign/path"
			}
			_, err := NewSelectedThreadReader(c, s, func(context.Context, selectedthread.Selection) error { t.Fatal("constructor recheck"); return nil })
			readFailureCode(t, err, "TASK_IDENTITY_MISMATCH")
			if f.checks.Load() != 0 || f.launches.Load() != 0 {
				t.Fatal("crossed selection inspected host")
			}
		})
	}
}

func TestSelectedThreadReadRechecksSelectionBeforeDisclosure(t *testing.T) {
	for _, mode := range []string{"revoked-before", "changed-thread-after", "cancel-after", "private-error"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			selected := selectedReadSelection(c)
			current := selected
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r, err := NewSelectedThreadReader(c, selected, func(_ context.Context, expected selectedthread.Selection) error {
				if mode == "revoked-before" {
					return task.ErrState
				}
				if mode == "private-error" {
					return errors.New("PRIVATE_DIAGNOSTIC")
				}
				if expected != current {
					return task.ErrIdentity
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			f.handle = func(q fixtureRequest) (any, bool) {
				if q.method == "thread/items/list" && mode == "changed-thread-after" {
					current.Reference.ThreadID = "foreign"
				}
				return f.response(q)
			}
			if mode == "cancel-after" {
				r.recheck = func(context.Context, selectedthread.Selection) error {
					if len(f.seen("thread/read")) == 2 {
						cancel()
					}
					return nil
				}
			}
			out, err := r.Read(ctx, selectedthread.Request{IncludeResult: true})
			code := "TASK_IDENTITY_MISMATCH"
			if mode == "revoked-before" {
				code = "TASK_STATE_REFUSED"
			}
			if mode == "private-error" {
				code = "TASK_OBSERVATION_UNKNOWN"
			}
			if mode == "changed-thread-after" {
				// A pre-write selection refusal invalidates this exact proxy
				// through the unchanged transport fence, without history send.
				code = "TASK_OBSERVATION_UNKNOWN"
			}
			if mode == "cancel-after" {
				code = "TASK_REQUEST_CANCELLED"
			}
			readFailureCode(t, err, code)
			if out != nil {
				t.Fatal("denied read disclosed a result", out)
			}
			if (mode == "revoked-before" || mode == "private-error") && f.launches.Load() != 0 {
				t.Fatal("pre-read denial launched a proxy")
			}
			noReadEffects(t, f)
		})
	}
}

func TestSelectedThreadReadKeepsWitnessThroughLastAwaitedCheck(t *testing.T) {
	for _, mode := range []string{"epoch", "lost", "close", "expired", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			var finalChecks int
			r, err := NewSelectedThreadReader(c, selectedReadSelection(c), func(ctx context.Context, _ selectedthread.Selection) error {
				if len(f.seen("thread/read")) != 2 {
					return nil
				}
				finalChecks++
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("unbounded final selection check")
				}
				switch mode {
				case "epoch":
					c.connection.epoch.Add(1)
				case "lost":
					c.connection.fail()
				case "close":
					c.closed.Store(true)
					c.cancel()
				case "expired":
					c.now = func() time.Time { return c.selection.ExpiresAt }
				case "cancel":
					c.cancel()
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			out, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
			if err == nil || out != nil || finalChecks != 1 {
				t.Fatal("stale final witness disclosed", out, err, finalChecks)
			}
			if f.launches.Load() != 1 {
				t.Fatal("invalidated witness replaced client")
			}
			noReadEffects(t, f)
		})
	}
}

// Deadline signals entry into Client.enter before it waits on the held gate.
// This is a controlled context witness, not a timing sleep or host observation.
type readGateContext struct {
	context.Context
	entered chan struct{}
	seen    atomic.Bool
}

func (c *readGateContext) Deadline() (time.Time, bool) {
	if c.seen.CompareAndSwap(false, true) {
		close(c.entered)
	}
	return c.Context.Deadline()
}

func TestSelectedThreadReadRechecksAfterGateAndNativeQualification(t *testing.T) {
	for _, mode := range []string{"gate", "qualification", "binding-guard"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			var revoked atomic.Bool
			r, err := NewSelectedThreadReader(c, selectedReadSelection(c), func(context.Context, selectedthread.Selection) error {
				if revoked.Load() {
					return task.ErrIdentity
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "qualification" {
				f.handle = func(q fixtureRequest) (any, bool) {
					if q.method == "initialize" {
						revoked.Store(true)
					}
					return f.response(q)
				}
			}
			if mode == "binding-guard" {
				guards := 0
				c.recheck = func(context.Context, task.Binding) error {
					guards++
					// Initial native guards and initialize have completed. Revoke
					// during the binding guard immediately before history send.
					if guards == 4 {
						revoked.Store(true)
					}
					return nil
				}
			}
			type reply struct {
				out *selectedthread.Response
				err error
			}
			var got reply
			if mode == "gate" {
				c.gate <- struct{}{}
				ctx := &readGateContext{Context: context.Background(), entered: make(chan struct{})}
				done := make(chan reply, 1)
				go func() { out, err := r.Read(ctx, selectedthread.Request{IncludeResult: true}); done <- reply{out, err} }()
				<-ctx.entered
				revoked.Store(true)
				<-c.gate
				got = <-done
			} else {
				got.out, got.err = r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
			}
			if got.err == nil || got.out != nil {
				t.Fatal("queued selection disclosed", got)
			}
			if len(f.seen("thread/read")) != 0 || len(f.seen("thread/turns/list")) != 0 || len(f.seen("thread/items/list")) != 0 {
				t.Fatal("stale selection read history")
			}
			noReadEffects(t, f)
		})
	}
}

func TestSelectedThreadReadRejectsLateMembershipAndEpochChanges(t *testing.T) {
	for _, field := range []string{"id", "projectId", "cwd", "model", "physical", "epoch"} {
		t.Run(field, func(t *testing.T) {
			c, f := newFixture(t)
			r, err := NewSelectedThreadReader(c, selectedReadSelection(c), func(context.Context, selectedthread.Selection) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			reads := 0
			f.handle = func(q fixtureRequest) (any, bool) {
				v, drop := f.response(q)
				if q.method == "thread/read" {
					reads++
					if reads == 2 && field != "physical" && field != "epoch" {
						v.(map[string]any)["thread"].(map[string]any)[field] = "foreign"
					}
				}
				if q.method == "thread/items/list" && field == "physical" {
					f.valid.Store(false)
				}
				return v, drop
			}
			if field == "epoch" {
				f.beforeReply = func(q fixtureRequest, conn net.Conn, _ *bufio.Reader) error {
					if q.method == "thread/items/list" {
						return sendEvent(conn, "account/updated", map[string]any{})
					}
					return nil
				}
			}
			out, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
			readFailureCode(t, err, "TASK_OBSERVATION_UNKNOWN")
			if out != nil {
				t.Fatal("late changed identity disclosed result", out)
			}
			noReadEffects(t, f)
		})
	}
}

func TestSelectedThreadReadCannotClearUnknownOrReconnect(t *testing.T) {
	for _, mode := range []string{"blocked", "lost"} {
		t.Run(mode, func(t *testing.T) {
			c, f := newFixture(t)
			r, err := NewSelectedThreadReader(c, selectedReadSelection(c), func(context.Context, selectedthread.Selection) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			if mode == "blocked" {
				c.blocked = true
			}
			out, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
			if err != nil || out.Retained {
				t.Fatal(out, err)
			}
			if mode == "lost" {
				c.connection.fail()
				out, err = r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
				readFailureCode(t, err, "TASK_OBSERVATION_UNKNOWN")
				if out != nil || f.launches.Load() != 1 {
					t.Fatal("lost read reconnected", out)
				}
			} else {
				receipt, err := c.Create(context.Background(), dispatch(c.selection, "after-read"), func(task.Reference) error { t.Fatal("read revived mutation"); return nil })
				if err != nil || receipt.State != task.Uncertain || !c.blocked {
					t.Fatal(receipt, err)
				}
			}
			noReadEffects(t, f)
		})
	}
}

func TestSelectedProviderHistoryAndTaskRetainedResultRemainDistinct(t *testing.T) {
	c, f := newFixture(t)
	s, j, a, req := eventService(t, c)
	// Seed an already ACKed Farol-owned task in the controlled journal. T0 must
	// neither create provider work nor adopt the external selection into it.
	i := task.Intent{OperationID: req.OperationID, TaskID: req.TaskID, Action: task.Create, Binding: a.binding, Parent: req.Parent}
	ref := completeRef()
	j.op = &port.Operation{Intent: i, Lineage: ref, Settled: true, Receipt: task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}}
	j.snapshot = &port.Snapshot{Task: task.Task{ID: req.TaskID, Binding: a.binding, Parent: req.Parent, Reference: ref, Lifecycle: task.Running, DispatchID: req.OperationID}, Revision: 1}
	r, err := NewSelectedThreadReader(c, selectedReadSelection(c), func(context.Context, selectedthread.Selection) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	history, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
	if err != nil || history.Retained || history.ResultEvidence != "provider_history" || j.snapshot.Revision != 1 || j.op.Receipt.Lifecycle != task.Running {
		t.Fatal(history, err)
	}
	result, err := s.Result(context.Background(), tasksvc.ResultRequest{TaskID: req.TaskID})
	if err != nil || !result.Retained || result.Text != history.Text || result.Reference != ref {
		t.Fatal(result, err)
	}
	before := len(f.seen("thread/read"))
	_ = c.Close(context.Background())
	// Reconstruct only the service/facade over the same journal; provider is
	// already closed and cannot supply this retained result.
	fresh, err := tasksvc.New(j, a, map[task.Provider]port.Provider{task.Codex: c}, nil, intent.Fingerprint, providerevents.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := observation.New(fresh)
	if err != nil {
		t.Fatal(err)
	}
	for _, include := range []bool{false, true} {
		out, err := retained.Read(context.Background(), observation.Request{TaskID: req.TaskID, DispatchID: req.OperationID, Limit: 1, IncludeResult: include})
		if err != nil || !out.Retained || out.ResultEvidence != "task_journal" || out.Reference.ThreadID != ref.ThreadID || out.Reference.TurnID != ref.TurnID || out.Delivery != "not_observed" {
			t.Fatal(out, err)
		}
		if include && out.Result != history.Text || !include && out.Result != "" {
			t.Fatal("retained result opt-in", out)
		}
	}
	if len(f.seen("thread/read")) != before || f.launches.Load() != 1 {
		t.Fatal("retained read used provider or replacement")
	}
	a.denied = true
	if _, err := retained.Read(context.Background(), observation.Request{TaskID: req.TaskID, DispatchID: req.OperationID, Limit: 1, IncludeResult: true}); err == nil {
		t.Fatal("revoked retained result disclosed")
	}
	noReadEffects(t, f)
}

func TestSelectedThreadReadMissingInputsAndCancelledCall(t *testing.T) {
	c, f := newFixture(t)
	selected := selectedReadSelection(c)
	if _, err := NewSelectedThreadReader(c, selected, nil); err == nil {
		t.Fatal("missing selection recheck accepted")
	}
	if _, err := NewSelectedThreadReader(nil, selected, func(context.Context, selectedthread.Selection) error { return nil }); err == nil {
		t.Fatal("missing original client accepted")
	}
	var calls atomic.Int32
	r, err := NewSelectedThreadReader(c, selected, func(context.Context, selectedthread.Selection) error { calls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Read(nil, selectedthread.Request{}); err == nil {
		t.Fatal("nil context accepted")
	}
	var absent *SelectedThreadReader
	if _, err := absent.Read(context.Background(), selectedthread.Request{}); err == nil {
		t.Fatal("nil reader accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = r.Read(ctx, selectedthread.Request{})
	readFailureCode(t, err, "TASK_REQUEST_CANCELLED")
	if calls.Load() != 0 || f.launches.Load() != 0 {
		t.Fatal("cancelled read called recheck/provider")
	}
}
