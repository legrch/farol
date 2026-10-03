package task

// Real Task service/owner and shipping invocation/parser; only provider output
// and memory journal are scripted. No CLI/process/model/native boundary runs.
import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	claudeclient "github.com/legrch/farol/modules/task/infra/clients/claude"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
)

type queuedModelAuthority struct {
	mu                     sync.Mutex
	configured, authorized task.Binding
	denied                 bool
	resolves               int
}

func (a *queuedModelAuthority) Resolve(context.Context, port.Selection) (task.Binding, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.resolves++
	return a.configured, nil
}
func (a *queuedModelAuthority) Recheck(_ context.Context, b task.Binding) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.denied || b != a.authorized {
		return task.ErrState
	}
	return nil
}
func (a *queuedModelAuthority) RecheckParent(context.Context, task.Parent) error { return nil }

type scriptedClaudeProvider struct {
	selected  *claudeclient.Selected
	calls     int
	lostAck   bool
	arguments []string
	observed  claudeclient.ObservedModel
	current   func() (*port.CurrentBinding, error)
	admitted  *port.CurrentBinding
}

func (p *scriptedClaudeProvider) Supports(_ context.Context, b task.Binding) (task.Capabilities, error) {
	if b != p.selected.Binding() {
		return task.Capabilities{}, task.ErrIdentity
	}
	return task.Capabilities{Create: true, Resume: true}, nil
}
func (p *scriptedClaudeProvider) Dispatch(c context.Context, d port.Dispatch, record func(task.Reference) error) (task.Receipt, error) {
	inv, err := p.selected.Build(d)
	if err != nil {
		return task.Receipt{}, err
	}
	// Independent fixture input oracle for the shipping serialized invocation.
	args := inv.Arguments()
	if len(args) != 14 || args[0] != "--print" || args[2] != "stream-json" || args[6] != "--model" || args[7] != "fixture-model-a" || args[8] != "--permission-mode" || args[9] != "default" || args[12] != "--effort" || args[13] != "high" || string(inv.Input()) != "bounded task\n" {
		return task.Receipt{}, errors.New("SCRIPTED_CLAUDE_INVOCATION_REFUSED")
	}
	p.admitted, err = p.current()
	if err != nil || p.admitted == nil {
		return task.Receipt{}, task.ErrState
	}
	p.calls++
	p.arguments = args
	if p.lostAck {
		return task.Receipt{State: task.Uncertain}, nil
	}
	parser, _ := claudeclient.NewStream(inv.Expected())
	// The reported model comes from this provider-boundary script, not echoing DTO.
	raw := `{"type":"system","subtype":"init","session_id":"12345678-1234-1234-1234-123456789abc","cwd":"/fixture/writer","model":"fixture-model-a","permissionMode":"default"}` + "\n"
	if _, err := parser.Feed([]byte(raw)); err != nil {
		return task.Receipt{}, err
	}
	p.observed = parser.Snapshot().Observed
	ref := task.Reference{SessionID: p.observed.SessionID, InvocationID: d.Intent.OperationID}
	if err := record(ref); err != nil {
		return task.Receipt{State: task.Uncertain}, err
	}
	return task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, nil
}
func (p *scriptedClaudeProvider) Observe(context.Context, task.Binding, task.Reference) (port.Observation, error) {
	return port.Observation{}, task.ErrUnsupported
}
func queuedClaude(t *testing.T, j port.AdmissionJournal) (*Service, *queuedModelAuthority, *scriptedClaudeProvider) {
	t.Helper()
	_, r := ownerRoute(t, j)
	b := binding(task.Claude)
	b.Model = "fixture-model-a"
	b.Writer.Path = "/fixture/writer"
	a := &queuedModelAuthority{configured: b, authorized: b}
	selection := r.Selection()
	scope := task.AdmissionBinding{OwnerID: selection.OwnerID, SessionID: selection.SessionID, TaskID: selection.TaskID, TaskEpoch: selection.TaskEpoch, ParticipantID: selection.ParticipantID, TurnID: selection.TurnID}
	selected, err := claudeclient.NewSelection(claudeclient.Selection{Binding: b, Scope: scope, RuntimeID: "fixture-runtime", AdmissionID: "authority-correlation", SessionID: "12345678-1234-1234-1234-123456789abc", ReportedModel: "fixture-model-a", Efforts: []claudeclient.EffortMapping{{Requested: "high", Argument: "high"}}, ExactResume: true})
	if err != nil {
		t.Fatal(err)
	}
	p := &scriptedClaudeProvider{selected: selected, current: func() (*port.CurrentBinding, error) { return current(r) }}
	s, err := NewOwned(r, a, map[task.Provider]port.Provider{task.Claude: p}, nil, intent.Fingerprint, providerclient.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	return s, a, p
}
func TestClaudeSelectionAcrossDispatchBarrierRetainsModelOrBlocksBeforeEffect(t *testing.T) {
	for _, denied := range []bool{false, true} {
		t.Run(map[bool]string{false: "still-authorized", true: "revoked"}[denied], func(t *testing.T) {
			base := journal()
			j := &blockedJournal{fakeJournal: base, admit: true, entered: make(chan struct{}), release: make(chan struct{})}
			s, a, p := queuedClaude(t, j)
			done := make(chan error, 1)
			var out *CreateResponse
			go func() { var err error; out, err = s.Create(ctx, request(task.Claude)); done <- err }()
			await(t, j.entered)
			a.mu.Lock()
			a.configured.Model = "fixture-model-b"
			a.configured.ConfigDigest = "config-b"
			a.denied = denied
			a.mu.Unlock()
			close(j.release)
			if err := awaitError(t, done); err != nil {
				t.Fatal(err)
			}
			if denied {
				if p.calls != 0 || out.Receipt.State != task.Rejected {
					t.Fatal("stale readiness reached provider", out, p.calls)
				}
			} else {
				if p.calls != 1 || p.arguments[7] != "fixture-model-a" || p.observed.Model != "fixture-model-a" || p.observed.Evidence != "provider_reported" || p.admitted.TaskEpoch != 1 {
					t.Fatal("queued selection silently changed", p)
				}
			}
			if a.resolves != 1 {
				t.Fatal("settings re-resolved after wait")
			}
			snapshot, _ := base.Read(ctx, "task-1")
			if snapshot.Task.Binding.Model != "fixture-model-a" {
				t.Fatal("historical binding rewritten")
			}
		})
	}
}
func TestClaudeUnknownDoesNotReresolveOrSendInputUnderNewModel(t *testing.T) {
	j := journal()
	s, a, p := queuedClaude(t, j)
	p.lostAck = true
	first, err := s.Create(ctx, request(task.Claude))
	if err != nil || first.Receipt.State != task.Uncertain {
		t.Fatal(first, err)
	}
	a.mu.Lock()
	a.configured.Model = "fixture-model-b"
	a.mu.Unlock()
	again, err := s.Create(ctx, request(task.Claude))
	if err != nil || again.Receipt.State != task.Uncertain || p.calls != 1 || a.resolves != 1 {
		t.Fatal("lost ACK retried/resolved", again, err)
	}
	if _, err := s.Control(ctx, MutationRequest{OperationID: "resume-after-unknown", TaskID: "task-1", Message: "bounded task", Action: task.Resume}); err == nil {
		t.Fatal("unknown resume admitted")
	}
	if _, err := s.Control(ctx, MutationRequest{OperationID: "active-input", TaskID: "task-1", Message: "steer", Action: task.Message}); err == nil {
		t.Fatal("active input admitted")
	}
	if p.calls != 1 {
		t.Fatal("unknown repaired through another operation")
	}
	if p.observed.Evidence != "" {
		t.Fatal("configured model became observed after lost reply")
	}
}

func TestKnownRunningClaudeRefusesActiveInputBeforeAnotherFixtureSubmission(t *testing.T) {
	s, _, p := queuedClaude(t, journal())
	out, err := s.Create(ctx, request(task.Claude))
	if err != nil || out.Receipt.State != task.Known {
		t.Fatal(out, err)
	}
	_, err = s.Control(ctx, MutationRequest{OperationID: "active-input", TaskID: "task-1", Message: "steer", Action: task.Message})
	if !errors.Is(err, task.ErrUnsupported) || p.calls != 1 {
		t.Fatal("active input became another invocation", err, p.calls)
	}
}
func TestUnknownRequestedModelAliasOrEffortStartsNoFixtureSubmission(t *testing.T) {
	for _, field := range []string{"alias", "effort"} {
		t.Run(field, func(t *testing.T) {
			s, _, p := queuedClaude(t, journal())
			req := request(task.Claude)
			if field == "alias" {
				req.Selection.ModelAlias = "unknown-alias"
			} else {
				req.Selection.Effort = "unsupported-effort"
			}
			if _, err := s.Create(ctx, req); err == nil || p.calls != 0 {
				t.Fatal("unresolved request reached provider", err, p.calls)
			}
		})
	}
}
