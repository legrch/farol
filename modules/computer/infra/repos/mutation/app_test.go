package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// Actual Computer app + repository, with labelled injected clock/lease/storage
// and native receipt. This proves no native filesystem or current-owner admission.
type cpuClock struct{ now time.Time }

func (c cpuClock) Now() time.Time { return c.now }

type cpuLease struct {
	binding     port.TaskBinding
	deadline    time.Time
	participant authority.Participant
	approval    authority.Approval
	inside      bool
}

func (l *cpuLease) Binding() port.TaskBinding { return l.binding }
func (l *cpuLease) Deadline() time.Time       { return l.deadline }
func (l *cpuLease) WithSnapshot(_ context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	if id != l.binding.ParticipantID {
		return errors.New("crossed CPU fixture")
	}
	p, a := l.participant.Clone(), l.approval.Clone()
	l.inside = true
	defer func() { l.inside = false }()
	return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
}

type cpuNative struct {
	lease *cpuLease
	calls int
}

func (n *cpuNative) Mutate(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
	if n.lease.inside {
		panic("native receipt fixture inside owner callback")
	}
	n.calls++
	if err := r.BeforePublish(ctx); err != nil {
		return nil, err
	}
	return &port.MutationReceipt{Operation: "write", RelativePath: r.Operation.Path(), Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
}
func appFixture(t *testing.T) (*mutationsvc.Service, *Repository, *memory, *cpuNative, *cpuLease, cpuClock, mutationsvc.ExecuteRequest) {
	t.Helper()
	r, m, s := fixture()
	id := s.Binding().Identity
	now := time.Unix(1700000000, 0)
	clock := cpuClock{now: now}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: id.OwnerID, SessionID: id.SessionID, TaskID: id.TaskID, TaskEpoch: id.TaskEpoch}, ParticipantID: id.ParticipantID, TurnID: "turn"}
	policy := authority.Policy{ExpiresAt: now.Add(15 * time.Second), Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: []authority.Capability{authority.Write}, Network: authority.NoNetwork, Commands: authority.NoCommands}
	lease := &cpuLease{binding: binding, deadline: policy.ExpiresAt, participant: authority.Participant{ParticipantID: id.ParticipantID, Role: authority.Main, MutationOwnership: authority.TaskOwnership, Grant: authority.Grant{Identity: binding.Identity, AuthorityID: "grant", ComputerID: "computer", ComputerGeneration: 7, Policy: policy}}, approval: authority.Approval{OwnerID: id.OwnerID, ComputerID: "computer", Generation: 7, ExpiresAt: now.Add(time.Hour), Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.WriteAccess, RootIdentity: authority.RootIdentity{Device: "7", Inode: "2"}}}, Capabilities: []authority.Capability{authority.Write}}}
	native := &cpuNative{lease: lease}
	service, err := mutationsvc.NewForExecution(id.OperationID, lease, r, native, filesystem.Digester{}, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	request := mutationsvc.ExecuteRequest{OperationID: id.OperationID, OwnerID: id.OwnerID, SessionID: id.SessionID, TaskID: id.TaskID, TaskEpoch: id.TaskEpoch, ParticipantID: id.ParticipantID, TurnID: "turn", Generation: 90, CallID: "call", WorkspaceID: "work", Operation: mutationsvc.Write{RelativePath: "note.md", Content: "new"}}
	return service, r, m, native, lease, clock, request
}
func TestAppRetainsKnownCompletionAfterLostSaveAck(t *testing.T) {
	for _, visible := range []bool{false, true} {
		service, r, m, native, lease, clock, request := appFixture(t)
		m.replaceErr = errors.New("lost save ack")
		m.visibleBeforeError = visible
		result, err := service.Execute(context.Background(), request)
		if err != nil || result.Phase != "completed" || result.Publication != "memory_only" || native.calls != 1 || m.creates != 1 || m.replaces != 1 {
			t.Fatalf("known fact lost: %#v %v", result, err)
		}
		result, err = service.Read(context.Background(), request)
		if err != nil || result.Phase != "completed" || result.Publication != "memory_only" || native.calls != 1 || m.replaces != 1 {
			t.Fatal("memory result replayed native/save", err)
		}
		observer, err := mutationsvc.NewForExecution(request.OperationID, lease, r, native, filesystem.Digester{}, &sync.Mutex{}, clock)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = observer.Execute(context.Background(), request); err == nil || native.calls != 1 || m.creates != 1 || m.replaces != 1 {
			t.Fatal("fenced writer granted new execution")
		}
	}
}
func TestAppLostAdmissionAckNeverDispatchesOrReadmits(t *testing.T) {
	service, _, m, native, _, _, request := appFixture(t)
	m.createErr = errors.New("lost admit ack")
	m.visibleBeforeError = true
	for range 2 {
		result, err := service.Execute(context.Background(), request)
		if err == nil || result != nil || native.calls != 0 || m.creates != 1 {
			t.Fatal("uncertain admission dispatched/replayed")
		}
	}
}
func TestAppKnownDurableResultSurvivesInjectedSuccessorWithoutEffects(t *testing.T) {
	service, r, m, native, lease, clock, request := appFixture(t)
	result, err := service.Execute(context.Background(), request)
	if err != nil || result.Phase != "completed" || result.Publication != "durable" {
		t.Fatal(err)
	}
	observer, err := mutationsvc.NewForExecution(request.OperationID, lease, r, native, filesystem.Digester{}, &sync.Mutex{}, clock)
	if err != nil {
		t.Fatal(err)
	}
	result, err = observer.Execute(context.Background(), request)
	if err != nil || result.Phase != "completed" || native.calls != 1 || m.creates != 1 || m.replaces != 1 {
		t.Fatal("existing terminal redispatched", err)
	}
}
