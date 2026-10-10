package catalogue_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/catalogue"
	taskport "github.com/legrch/farol/modules/task/app/port"
	taskservice "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	progress "github.com/legrch/farol/modules/task/infra/clients/provider"
)

type inferenceBuilder struct {
	calls  int
	change func()
	err    error
}

func (b *inferenceBuilder) Prepare(_ context.Context, input catalogue.InferenceInput) (catalogue.InferencePrepared, error) {
	b.calls++
	if b.change != nil {
		b.change()
	}
	if b.err != nil {
		return catalogue.InferencePrepared{}, b.err
	}
	// Controlled request builder; not the unintegrated INFERENCE service.
	body, err := json.Marshal(struct {
		Model  string `json:"model"`
		Effort string `json:"effort"`
		Input  string `json:"input"`
	}{input.Pin.Model, input.Pin.Effort, input.Text})
	return catalogue.InferencePrepared{Pin: input.Pin, Body: body}, err
}
func loaded(t *testing.T, backend selection.Backend) (*catalogue.Cache, selection.Scope) {
	t.Helper()
	raw := planJSON
	if backend == selection.CodexTask {
		raw = appJSON
	}
	s := read(t, backend, raw)
	c := &catalogue.Cache{}
	c.Activate(s.Scope)
	ticket := c.Begin()
	s.Epoch = ticket.Epoch()
	s, err := catalogue.WithEvidence(s, catalogue.Evidence{Scope: s.Scope, Epoch: s.Epoch, Models: map[string]selection.Capabilities{"fixture-model": caps()}})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Complete(ticket, s, nil); err != nil {
		t.Fatal(err)
	}
	return c, s.Scope
}

func TestInferenceMappingUsesOneExactPinAndNeverRetriesBuilder(t *testing.T) {
	c, s := loaded(t, selection.PlanInference)
	b := &inferenceBuilder{}
	request := selection.Request{Slug: "fixture-model", Effort: "deliberate"}
	out, err := catalogue.PrepareInference(context.Background(), c, s, 11, request, "fixture input", b)
	if err != nil {
		t.Fatal(err)
	}
	if out.Pin.Model != "fixture-model" || out.Pin.Effort != "deliberate" || out.Pin.Route.Billing != selection.Plan || out.Pin.AccountID != s.AccountID || b.calls != 1 {
		t.Fatal("lost binding in controlled inference consumer")
	}
	var body map[string]string
	if json.Unmarshal(out.Body, &body) != nil || body["model"] != out.Pin.Model || body["effort"] != out.Pin.Effort {
		t.Fatal("serialized request changed selected model")
	}
	if _, err := catalogue.PrepareInference(context.Background(), c, s, 100, request, "fixture", b); err == nil || b.calls != 1 {
		t.Fatal("stale request reached builder")
	}
	wrong := s
	wrong.Route.Billing = selection.API
	if _, err := catalogue.PrepareInference(context.Background(), c, wrong, 11, request, "fixture", b); err == nil || b.calls != 1 {
		t.Fatal("plan->API mismatch reached builder")
	}
	b.err = errors.New("private builder refusal")
	if _, err := catalogue.PrepareInference(context.Background(), c, s, 11, request, "fixture", b); err != catalogue.Unavailable || b.calls != 2 {
		t.Fatal("builder failure retried or leaked")
	}
}

func TestAccountSwitchWhilePreparingInferenceSuppressesOldRequest(t *testing.T) {
	c, s := loaded(t, selection.PlanInference)
	other := s
	other.AccountID = "fixture-account-B"
	b := &inferenceBuilder{change: func() { c.Activate(other) }}
	if _, err := catalogue.PrepareInference(context.Background(), c, s, 11, selection.Request{Slug: "fixture-model"}, "fixture", b); err == nil || b.calls != 1 {
		t.Fatal("account switch during request assembly returned old consent")
	}
}

func TestInferencePreparationHonorsCancellation(t *testing.T) {
	c, s := loaded(t, selection.PlanInference)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b := &inferenceBuilder{}
	if _, err := catalogue.PrepareInference(ctx, c, s, 11, selection.Request{Slug: "fixture-model"}, "fixture", b); err == nil || b.calls != 0 {
		t.Fatal("cancelled preparation reached builder")
	}
	ctx, cancel = context.WithCancel(context.Background())
	b.change = cancel
	if _, err := catalogue.PrepareInference(ctx, c, s, 11, selection.Request{Slug: "fixture-model"}, "fixture", b); err == nil || b.calls != 1 {
		t.Fatal("cancelled builder result accepted")
	}
}

// A real existing Task service/facade consumes the catalogue mapping below.
// The ports deliberately prove no workspace authority, journal admission,
// provider activation, live entitlement or mutation; only Resolve is invoked.
type unusedJournal struct{ taskport.Journal }
type taskAuthority struct {
	cache    *catalogue.Cache
	scope    selection.Scope
	resolved selection.Resolved
	mapping  catalogue.TaskMapping
	binding  task.Binding
}

func (a *taskAuthority) Resolve(_ context.Context, s taskport.Selection) (task.Binding, error) {
	if s.Provider != task.Codex || s.ModelAlias != a.mapping.ModelAlias || s.Effort != a.mapping.Pin.Effort || s.ProjectID != a.binding.ProjectID || s.WorkspaceID != a.binding.WorkspaceID {
		return task.Binding{}, task.ErrIdentity
	}
	if err := a.Recheck(context.Background(), a.binding); err != nil {
		return task.Binding{}, err
	}
	return a.binding, nil
}
func (a *taskAuthority) Recheck(_ context.Context, b task.Binding) error {
	if b != a.binding || b.Model != a.mapping.Pin.Model {
		return task.ErrIdentity
	}
	s, err := a.cache.Current()
	if err != nil {
		return task.ErrUnavailable
	}
	if selection.RecheckBeforeStart(a.resolved, s, a.scope, 11) != nil {
		return task.ErrIdentity
	}
	return nil
}
func (*taskAuthority) RecheckParent(context.Context, task.Parent) error { return task.ErrIdentity }

type taskProvider struct {
	binding  task.Binding
	supports int
	err      error
}

func (p *taskProvider) Supports(_ context.Context, b task.Binding) (task.Capabilities, error) {
	p.supports++
	if b != p.binding {
		return task.Capabilities{}, task.ErrIdentity
	}
	return task.Capabilities{Create: true}, p.err
}
func (*taskProvider) Dispatch(context.Context, taskport.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	panic("no fixture provider effects authorized")
}
func (*taskProvider) Observe(context.Context, task.Binding, task.Reference) (taskport.Observation, error) {
	panic("no fixture observation authorized")
}

func TestTaskFacingMappingComposesExistingTaskResolveContract(t *testing.T) {
	c, s := loaded(t, selection.CodexTask)
	snapshot, _ := c.Current()
	r, err := selection.Resolve(snapshot, s, 11, selection.Request{Slug: "fixture-model", Requirements: selection.Requirements{Text: true}})
	if err != nil {
		t.Fatal(err)
	}
	m, err := catalogue.MapTask(r, "friendly")
	if err != nil {
		t.Fatal(err)
	}
	b := task.Binding{Provider: task.Codex, ProfileID: "fixture-profile", HostID: "fixture-host", ProjectID: "fixture-project", WorkspaceID: "fixture-writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: m.ModelAlias, Model: m.Pin.Model, Effort: m.Pin.Effort, ConfigDigest: "fixture-config"}
	a := &taskAuthority{cache: c, scope: s, resolved: r, mapping: m, binding: b}
	p := &taskProvider{binding: b}
	service, err := taskservice.New(&unusedJournal{}, a, map[task.Provider]taskport.Provider{task.Codex: p}, nil, func([]byte) string { return "fixture-digest" }, progress.NewProgress)
	if err != nil {
		t.Fatal(err)
	}
	facade, err := control.New(service)
	if err != nil {
		t.Fatal(err)
	}
	request := control.ResolveRequest{Selection: control.Selection{Provider: control.Codex, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: m.ModelAlias, Effort: m.Pin.Effort}}
	out, err := facade.Resolve(context.Background(), request)
	if err != nil || out.Binding.Model != m.Pin.Model || out.Binding.ModelAlias != "friendly" || out.Binding.Effort != m.Pin.Effort || p.supports != 1 {
		t.Fatalf("real Task resolve lost pin: %+v %v", out, err)
	}
	p.err = task.ErrUnsupported
	if _, err := facade.Resolve(context.Background(), request); err == nil || p.supports != 2 {
		t.Fatal("provider refusal caused fallback/retry")
	}
	other := s
	other.AccountID = "fixture-account-B"
	c.Activate(other)
	if _, err := facade.Resolve(context.Background(), request); err == nil || p.supports != 2 {
		t.Fatal("account switch reached provider")
	}
	if r.Pin().AccountID != s.AccountID || r.Pin().Model != "fixture-model" {
		t.Fatal("original immutable operation pin changed")
	}
}
