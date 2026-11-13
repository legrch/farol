package boot

// Actual publication/current reader/Chat/Task/Codex composition. Only persistence,
// clock and physical provider are controlled CPU boundaries; no native startup.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	sourcect "github.com/legrch/farol/modules/task/contracts/currentsource"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

type taskPublicationStore struct {
	*chatComputerStore
	updates int
	unknown bool
}

func (s *taskPublicationStore) UpdateApproval(ctx context.Context, revision uint64, a authority.Approval) error {
	if ctx.Err() != nil || revision != s.revision {
		return errors.New("controlled stale publication")
	}
	s.updates++
	s.approval, s.revision = a.Clone(), s.revision+1
	s.PutApproval(a)
	if s.unknown {
		return &accessrepo.CommitFailure{Unknown: true}
	}
	return nil
}

type taskPublicationFixture struct {
	f        *taskProfileTestFixture
	selector *TaskSelector
	ingress  *ComputerIngress
	store    *taskPublicationStore
	metadata wire.TaskCodexSource
	input    PublishedCodexTaskSource
	approval json.RawMessage
	sequence int
}

func newTaskPublicationFixture(t *testing.T) *taskPublicationFixture {
	t.Helper()
	f := taskProfileTestSetup(t, false)
	f.task.pipe.selection.ApprovalPolicy = "on-request"
	x := f.task.pipe.selection
	i, store, _, _ := f.chat.computer(t)
	store.clock.now = x.GrantedAt.Add(time.Minute)
	p := &taskPublicationFixture{f: f, ingress: i, store: &taskPublicationStore{chatComputerStore: store}}
	i.store = p.store
	i.publication = nil
	root := func(r task.Root) wire.TaskSourceRoot {
		return wire.TaskSourceRoot{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	effort := x.Binding.Effort
	p.metadata = wire.TaskCodexSource{ProjectId: x.Binding.ProjectID, WorkspaceId: x.Binding.WorkspaceID, Project: root(x.Binding.Project), Writer: root(x.Binding.Writer), ModelAlias: x.Binding.ModelAlias, Model: x.Binding.Model, Effort: &effort, ConfigDigest: x.Binding.ConfigDigest,
		ExecutablePath: x.ExecutablePath, ExecutableSha256: x.ExecutableSHA256, Protocol: x.Protocol, BaseSchemaSha256: strings.Repeat("e", 64), HandoffSchemaSha256: x.SchemaSHA256,
		Followup:   &wire.TaskSourceFollowup{Kind: codexclient.FollowupSchemaKind, Protocol: x.Protocol, BaseSchemaSha256: x.SchemaSHA256, SchemaSha256: strings.Repeat("d", 64)},
		SocketPath: x.SocketPath, ExpectedCodexHome: x.ExpectedCodexHome, Sandbox: x.Sandbox, ApprovalPolicy: x.ApprovalPolicy, GrantedAt: x.GrantedAt.Format(time.RFC3339Nano), ExpiresAt: x.ExpiresAt.Format(time.RFC3339Nano),
		HostGeneration: "3", ComputerGeneration: "7", GrantHostGeneration: "3", GrantComputerGeneration: "7", VerifiedWorkspaceId: x.Binding.WorkspaceID, VerifiedComputerGeneration: "7", Access: "write", ProjectBoundCreateStatus: true}
	var err error
	p.approval, err = json.Marshal(map[string]any{"ownerId": "owner", "computerId": "computer", "generation": 7, "workspaces": []any{map[string]any{"workspaceId": x.Binding.WorkspaceID, "root": x.Binding.Writer.Path, "access": "write", "rootIdentity": map[string]string{"device": x.Binding.Writer.Device, "inode": x.Binding.Writer.Inode}, "gitHistoryApproved": true, "shellVerified": false, "gitMetadata": map[string]string{"gitDirectory": x.Binding.Writer.Path + "/.git", "commonDirectory": x.Binding.Writer.GitCommonDirectory}}}, "excludedPaths": []any{}, "capabilities": []string{"workspace.list", "workspace.read", "workspace.write"}, "network": "none", "commands": "none", "expiresAt": x.ExpiresAt.Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	surface, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	p.selector, err = NewTaskSelector(surface)
	if err != nil {
		t.Fatal(err)
	}
	p.input = PublishedCodexTaskSource{Current: i, HostID: x.Binding.HostID, ScratchRoot: x.ScratchRoot, Verifier: f.task.pipe, Now: func() time.Time { return x.GrantedAt.Add(time.Minute) }, ChatHandle: f.input.ChatHandle, Parent: f.input.Parent}
	return p
}

// These low-level publication/authority fixtures deliberately use controlled
// derived DTOs (including non-Settings IDs). Real owning-service derivation and
// closed raw-facts ingress are covered separately in taskcurrentsource_test.go.
type fixtureTaskSource struct{ result *sourcect.Response }

func (f fixtureTaskSource) Resolve(context.Context, sourcect.Request) (*sourcect.Response, error) {
	return f.result, nil
}
func (p *taskPublicationFixture) sourceFacts(t *testing.T, source *wire.TaskCodexSource, read *wire.TaskCodexReadSelection) *wire.TaskCurrentSourceFacts {
	t.Helper()
	status := "absent"
	if source != nil || read != nil {
		status = "available"
	}
	raw, err := json.Marshal(map[string]any{"status": status, "source": source, "read": read})
	if err != nil {
		t.Fatal(err)
	}
	var result sourcect.Response
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	p.ingress.taskCurrentSource = fixtureTaskSource{&result}
	return &wire.TaskCurrentSourceFacts{Snapshot: "{}", NowMillis: "0"}
}

func (p *taskPublicationFixture) publish(t *testing.T, m *wire.TaskCodexSource) *wire.ComputerAuthorityPublication {
	t.Helper()
	p.sequence++
	d, err := p.ingress.Deactivate(context.Background(), fmt.Sprintf("withdraw-%d", p.sequence))
	if err != nil {
		t.Fatal(err)
	}
	r, err := p.ingress.Publish(context.Background(), fmt.Sprintf("publish-%d", p.sequence), wire.ComputerAuthorityPublishRequest{Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: fmt.Sprint(p.sequence), Approval: p.approval, TaskCurrentSettings: p.sourceFacts(t, m, nil)})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func (p *taskPublicationFixture) read() (codexclient.AuthoritySnapshot, error) {
	return p.ingress.currentCodexAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
}
func TestTaskPublicationRetainsOriginalClientAcrossIdenticalPublicationAndFollowup(t *testing.T) {
	p := newTaskPublicationFixture(t)
	ctx := context.Background()
	p.publish(t, &p.metadata)
	before, err := p.read()
	if err != nil {
		t.Fatal(err)
	}
	h, err := p.selector.BeginPublishedCodex(ctx, p.input)
	if err != nil {
		t.Fatal(err)
	}
	first := p.selector.surface.handles[h.HandleId]
	created, err := first.Create(ctx, "create", TaskIngressCreateRequest{Message: "published current grant"})
	if err != nil || created.Receipt.State != controlct.Known {
		t.Fatal(created, err)
	}
	p.f.task.pipe.complete("turn-1")
	if _, err = first.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	p.publish(t, &p.metadata)
	after, err := p.read()
	if err != nil || after != before {
		t.Fatal("publication counters changed immutable selection", err)
	}
	p.f.chat.finish(t, p.f.parent)
	nextChat := chatComputerInput(true)
	nextChat.PreviousHandle = &p.f.parent.id
	parent := p.f.chat.start(t, "follow-parent", nextChat)
	next, err := p.selector.ContinueCodex(ctx, *h, "create", parent.id)
	if err != nil {
		t.Fatal(err)
	}
	second := p.selector.surface.handles[next.HandleId]
	follow, err := second.Continue(ctx, "follow", TaskIngressContinueRequest{DispatchID: "create", Message: "same original thread"})
	if err != nil || follow.Receipt.Reference.ThreadID != created.Receipt.Reference.ThreadID || follow.Receipt.Reference.TurnID != "turn-2" {
		t.Fatal(follow, err)
	}
	prior, err := second.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create"})
	if err != nil || !prior.Retained || prior.Text != "retained turn-1" {
		t.Fatal(prior, err)
	}
	if p.f.task.pipe.launches.Load() != 1 || p.f.task.pipe.count("thread/start") != 1 || p.f.task.pipe.count("turn/start") != 2 {
		t.Fatal("retained client replaced")
	}
}

type taskPublicationVerifier struct {
	delegate         codexclient.SelectionVerifier
	armed            atomic.Bool
	entered, release chan struct{}
}

func (v *taskPublicationVerifier) Verify(ctx context.Context, s codexclient.Selection) error {
	if v.armed.Swap(false) {
		close(v.entered)
		select {
		case <-v.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return v.delegate.Verify(ctx, s)
}
func TestTaskPublicationWithdrawalBeforeSaveBlocksPausedPhysicalVerification(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	ctx := context.Background()
	v := &taskPublicationVerifier{delegate: p.f.task.pipe, entered: make(chan struct{}), release: make(chan struct{})}
	p.input.Verifier = v
	h, err := p.selector.BeginPublishedCodex(ctx, p.input)
	if err != nil {
		t.Fatal(err)
	}
	v.armed.Store(true)
	done := make(chan error, 1)
	go func() {
		_, err := p.selector.surface.handles[h.HandleId].Create(ctx, "held-create", TaskIngressCreateRequest{Message: "held before effect"})
		done <- err
	}()
	select {
	case <-v.entered:
	case <-time.After(time.Second):
		close(v.release)
		t.Fatal("physical verifier not reached")
	}
	old := p.ingress.publication
	revision := p.store.revision
	if _, err = p.ingress.Deactivate(ctx, "task-only-before-save"); err != nil {
		close(v.release)
		t.Fatal(err)
	}
	if p.ingress.publication != old || p.store.revision != revision {
		t.Fatal("negative withdrawal required disk replacement")
	}
	if _, err = p.read(); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal("old publication remained current", err)
	}
	close(v.release)
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("withdrawn source admitted Create")
		}
	case <-time.After(time.Second):
		t.Fatal("Create did not settle")
	}
	if p.f.task.pipe.count("thread/start") != 0 || p.f.task.pipe.count("turn/start") != 0 {
		t.Fatal("physical Send after negative ACK")
	}
}
func TestTaskPublicationFinalQualificationWithdrawalPreventsSend(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	ctx := context.Background()
	h, err := p.selector.BeginPublishedCodex(ctx, p.input)
	if err != nil {
		t.Fatal(err)
	}
	var catalogues atomic.Int32
	cut := make(chan error, 1)
	p.f.task.pipe.notifications = func(r taskIngressTestRPC) [][]byte {
		if r.Method == "model/list" && catalogues.Add(1) == 2 {
			_, err := p.ingress.Deactivate(ctx, "final-before-send")
			cut <- err
		}
		return nil
	}
	_, err = p.selector.surface.handles[h.HandleId].Create(ctx, "create", TaskIngressCreateRequest{Message: "withdraw while provider qualifies"})
	select {
	case e := <-cut:
		if e != nil {
			t.Fatal(e)
		}
	default:
		t.Fatal("final qualification not reached")
	}
	if err == nil || p.f.task.pipe.count("thread/start") != 0 || p.f.task.pipe.count("turn/start") != 0 {
		t.Fatal("physical effect after withdrawal", err)
	}
}
func TestTaskPublicationIsCurrentBeforeAndAfterActualComputerAdmission(t *testing.T) {
	p := newTaskPublicationFixture(t)
	receipt := p.publish(t, &p.metadata)
	before, err := p.read()
	if err != nil || p.ingress.guard.active {
		t.Fatal(err)
	}
	_, err = p.ingress.Admit(context.Background(), "admit-computer", wire.ChatComputerAdmissionRequest{Publication: *receipt, SessionId: "second-session", TaskId: "second-task", TurnId: "second-turn", WorkspaceIds: []string{p.metadata.WorkspaceId}})
	if err != nil {
		t.Fatal(err)
	}
	after, err := p.read()
	if err != nil || before != after || !p.ingress.guard.active || p.store.revision != 3 {
		t.Fatal("Computer store/admission counters invalidated identical Task grant", p.store.revision, err)
	}
}
func TestTaskPublicationRejectsMissingChangedRestrictedAndUnknownSource(t *testing.T) {
	for _, mode := range []string{"missing", "changed", "unknown", "restricted", "crossed", "same-fence"} {
		t.Run(mode, func(t *testing.T) {
			p := newTaskPublicationFixture(t)
			receipt := p.publish(t, &p.metadata)
			before, err := p.read()
			if err != nil {
				t.Fatal(err)
			}
			a, err := codexclient.NewSelectionAuthority(codexclient.SelectionAuthorityOptions{Selected: before, ReadCurrent: func(context.Context) (codexclient.AuthoritySnapshot, error) { return p.read() }, Verifier: p.f.task.pipe, Now: p.input.Now})
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "missing":
				p.publish(t, nil)
			case "changed":
				m := p.metadata
				m.Model = "changed-model"
				p.publish(t, &m)
			case "unknown":
				p.ingress.poison()
			case "restricted":
				var raw map[string]any
				_ = json.Unmarshal(p.approval, &raw)
				raw["excludedPaths"] = []any{map[string]any{"workspaceId": p.metadata.WorkspaceId, "path": p.metadata.Writer.Path + "/secret"}}
				p.approval, _ = json.Marshal(raw)
				d, e := p.ingress.Deactivate(context.Background(), "restricted-withdraw")
				if e != nil {
					t.Fatal(e)
				}
				_, e = p.ingress.Publish(context.Background(), "restricted-publish", wire.ComputerAuthorityPublishRequest{Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: "2", Approval: p.approval, TaskCurrentSettings: p.sourceFacts(t, &p.metadata, nil)})
				if e == nil || p.store.updates != 1 {
					t.Fatal("unsupported restriction published", e)
				}
			case "crossed":
				p.ingress.guard.mu.Lock()
				p.ingress.guard.revision++
				p.ingress.guard.mu.Unlock()
			case "same-fence":
				_, e := p.ingress.Publish(context.Background(), "second-publish", wire.ComputerAuthorityPublishRequest{Fence: receipt.Fence, ExpectedStoreRevision: receipt.StoreRevision, SettingsRevision: "2", Approval: p.approval, TaskCurrentSettings: p.sourceFacts(t, &p.metadata, nil)})
				if e == nil || p.store.updates != 1 {
					t.Fatal("same fence republished", e)
				}
				return
			}
			if e := a.Recheck(context.Background(), before.Selection.Binding); e == nil {
				t.Fatal("old source revived")
			}
			if p.f.task.pipe.launches.Load() != 0 {
				t.Fatal("validation launched provider")
			}
		})
	}
}
func TestTaskPublicationCopiesCallerMetadataAndPoisonsUnknownCommit(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	before, err := p.read()
	if err != nil {
		t.Fatal(err)
	}
	*p.metadata.Effort = "different"
	p.metadata.Followup.SchemaSha256 = strings.Repeat("f", 64)
	after, err := p.read()
	if err != nil || before != after {
		t.Fatal("caller mutated retained source", err)
	}
	p.store.unknown = true
	d, err := p.ingress.Deactivate(context.Background(), "unknown-withdraw")
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.ingress.Publish(context.Background(), "unknown-publish", wire.ComputerAuthorityPublishRequest{Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: "2", Approval: p.approval, TaskCurrentSettings: p.sourceFacts(t, &p.metadata, nil)})
	if err == nil {
		t.Fatal("controlled lost storage ACK accepted")
	}
	if _, err = p.read(); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("unknown publication restored current authority", err)
	}
}
