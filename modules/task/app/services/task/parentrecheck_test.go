package task

// CPU policy fixtures: real Task Service/Owner and atomic memory journal; no
// native persistence, CLI/provider operation or actual parent Chat qualification.
import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	providerclient "github.com/legrch/farol/modules/task/infra/clients/provider"
	"github.com/legrch/farol/modules/task/infra/intent"
	taskrepo "github.com/legrch/farol/modules/task/infra/repos/task"
)

type parentWindowAuthority struct {
	*fakeAuthority
	parent       task.Parent
	withdrawn    bool
	parentChecks int
}

func (a *parentWindowAuthority) RecheckParent(_ context.Context, parent task.Parent) error {
	a.parentChecks++
	if a.withdrawn || parent != a.parent {
		return task.ErrState
	}
	return nil
}

type parentWindowProvider struct {
	*fakeProvider
	afterSupports func()
	supports      int
}

func (p *parentWindowProvider) Supports(ctx context.Context, b task.Binding) (task.Capabilities, error) {
	p.supports++
	caps, err := p.fakeProvider.Supports(ctx, b)
	if p.afterSupports != nil {
		p.afterSupports()
	}
	return caps, err
}

type parentWindowJournal struct {
	*fakeJournal
	afterAdmit, afterFinish func()
	admits                  int
}

func (j *parentWindowJournal) Admit(ctx context.Context, i task.Intent, revision uint64, prepared task.Task) (*port.Admission, error) {
	j.admits++
	out, err := j.fakeJournal.Admit(ctx, i, revision, prepared)
	if j.afterAdmit != nil {
		j.afterAdmit()
	}
	return out, err
}
func (j *parentWindowJournal) Finish(ctx context.Context, id string, r task.Receipt, next task.Task) error {
	err := j.fakeJournal.Finish(ctx, id, r, next)
	if j.afterFinish != nil {
		j.afterFinish()
	}
	return err
}

type parentWindowFixture struct {
	service   *Service
	journal   *parentWindowJournal
	authority *parentWindowAuthority
	provider  *parentWindowProvider
	route     *taskrepo.Route
	kind      task.Provider
	action    task.Action
}

func parentWindowSetup(t *testing.T, kind task.Provider, action task.Action) *parentWindowFixture {
	t.Helper()
	_, _, baseAuthority, baseProvider, delivery := setup(kind)
	f := &parentWindowFixture{journal: &parentWindowJournal{fakeJournal: journal()},
		authority: &parentWindowAuthority{fakeAuthority: baseAuthority, parent: request(kind).Parent},
		provider:  &parentWindowProvider{fakeProvider: baseProvider}, kind: kind, action: action}
	owner, route := ownerRoute(t, f.journal)
	f.route = route
	selectService := func() {
		var err error
		f.service, err = NewOwned(f.route, f.authority, map[task.Provider]port.Provider{kind: f.provider}, delivery, intent.Fingerprint, providerclient.NewProgress)
		if err != nil {
			t.Fatal(err)
		}
	}
	selectService()
	if action != task.Create {
		create(t, f.service, kind)
		complete(t, f.service)
		var err error
		f.route, err = owner.Select(selection(2, "fresh-coding-turn"))
		if err != nil {
			t.Fatal(err)
		}
		selectService()
		f.provider.receipt.Reference = reference(kind, "turn-2")
	}
	return f
}
func (f *parentWindowFixture) operationID() string {
	if f.action == task.Create {
		return "create-1"
	}
	return "follow-up"
}
func (f *parentWindowFixture) mutate() (*MutationResponse, error) {
	if f.action == task.Create {
		out, err := f.service.Create(ctx, request(f.kind))
		if out == nil {
			return nil, err
		}
		return &MutationResponse{out.OperationID, out.TaskID, out.Receipt}, err
	}
	if f.action == task.Continue {
		return f.service.ContinueExact(ctx, ContinueExactRequest{"follow-up", "task-1", "next", "create-1"})
	}
	return f.service.ResumeExact(ctx, ResumeExactRequest{"follow-up", "task-1", "next", "create-1"})
}
func parentWindowCases() []struct {
	name   string
	kind   task.Provider
	action task.Action
} {
	return []struct {
		name   string
		kind   task.Provider
		action task.Action
	}{
		{"codex create", task.Codex, task.Create}, {"claude create", task.Claude, task.Create},
		{"codex continue", task.Codex, task.Continue}, {"claude resume", task.Claude, task.Resume},
	}
}
func TestParentWithdrawalBeforeDispatch(t *testing.T) {
	for _, c := range parentWindowCases() {
		t.Run(c.name, func(t *testing.T) {
			for _, window := range []string{"before-supports", "supports", "admit", "before-send"} {
				t.Run(window, func(t *testing.T) {
					f := parentWindowSetup(t, c.kind, c.action)
					sends, admits, supports := f.provider.calls, f.journal.admits, f.provider.supports
					withdraw := func() { f.authority.withdrawn = true }
					switch window {
					case "before-supports":
						withdraw()
					case "supports":
						f.provider.afterSupports = withdraw
					case "admit":
						f.journal.afterAdmit = withdraw
					case "before-send":
						f.service.progress = func(record func(context.Context, task.Reference) error) port.Progress {
							withdraw()
							return providerclient.NewProgress(record)
						}
					}
					out, err := f.mutate()
					if f.provider.calls != sends {
						t.Fatalf("parent withdrawn during %s reached Dispatch: sends=%d before=%d", window, f.provider.calls, sends)
					}
					if window == "before-supports" || window == "supports" {
						if !errors.Is(err, task.ErrState) || out != nil || f.journal.admits != admits {
							t.Fatalf("pre-admission withdrawal: out=%+v err=%v admits=%d", out, err, f.journal.admits)
						}
						if window == "before-supports" && f.provider.supports != supports {
							t.Fatal("withdrawn parent reached Supports")
						}
					} else {
						if err != nil || out == nil || out.Receipt.State != task.Uncertain || f.journal.admits != admits+1 {
							t.Fatalf("post-admission withdrawal: out=%+v err=%v admits=%d", out, err, f.journal.admits)
						}
						op, _ := f.journal.Lookup(ctx, f.operationID())
						if op == nil || op.Settled || op.Intent.Parent != f.authority.parent {
							t.Fatal("withdrawal settled or changed the original intent")
						}
						requireAbsent(t, f.route, true)
						beforeSends, beforeAdmits := f.provider.calls, f.journal.admits
						_, _ = f.mutate()
						opRead, err := f.service.Operation(ctx, OperationRequest{f.operationID()})
						if err != nil || opRead.Receipt.State != task.Uncertain || f.provider.calls != beforeSends || f.journal.admits != beforeAdmits {
							t.Fatal("retained unknown became another admission/send", err)
						}
					}
				})
			}
		})
	}
}
func TestParentWithdrawalBlocksMutationDisclosureButKeepsHistoricalEvidence(t *testing.T) {
	for _, c := range parentWindowCases() {
		t.Run(c.name, func(t *testing.T) {
			for _, window := range []string{"dispatch", "finish"} {
				t.Run(window, func(t *testing.T) {
					f := parentWindowSetup(t, c.kind, c.action)
					sends := f.provider.calls
					f.provider.receipt.Lifecycle, f.provider.receipt.Result = task.Completed, "known child result"
					withdraw := func() { f.authority.withdrawn = true }
					if window == "dispatch" {
						f.provider.dispatch = func(func(task.Reference) error) { withdraw() }
					} else {
						f.journal.afterFinish = withdraw
					}
					out, err := f.mutate()
					if !errors.Is(err, task.ErrState) || out != nil || f.provider.calls != sends+1 {
						t.Fatalf("parent withdrawal disclosed mutation ACK: out=%+v err=%v sends=%d", out, err, f.provider.calls)
					}
					requireAbsent(t, f.route, true)
					op, err := f.service.Operation(ctx, OperationRequest{f.operationID()})
					if err != nil || op.Receipt.State != task.Known || op.Receipt.Result != "known child result" {
						t.Fatal("discarded known durable receipt", op, err)
					}
					reads := f.provider.reads
					result, err := f.service.Result(ctx, ResultRequest{"task-1"})
					if err != nil || !result.Retained || result.Text != "known child result" || f.provider.reads != reads {
						t.Fatal("historical read depends on a live parent or polls again", result, err)
					}
					_, err = f.service.Deliver(ctx, DeliverRequest{"delivery-blocked", "task-1"})
					if !errors.Is(err, task.ErrState) {
						t.Fatal("withdrawn parent delivery was allowed", err)
					}
					_, _ = f.mutate()
					if f.provider.calls != sends+1 {
						t.Fatal("disclosure refusal became retry")
					}
				})
			}
		})
	}
}
func TestParentlessTaskDispatchDoesNotInventParentAuthority(t *testing.T) {
	f := parentWindowSetup(t, task.Codex, task.Create)
	req := request(task.Codex)
	req.Parent = task.Parent{}
	f.authority.withdrawn = true
	out, err := f.service.Create(ctx, req)
	if err != nil || out.Receipt.State != task.Known || f.authority.parentChecks != 0 || f.provider.calls != 1 {
		t.Fatal(out, err, f.authority.parentChecks, f.provider.calls)
	}
}
