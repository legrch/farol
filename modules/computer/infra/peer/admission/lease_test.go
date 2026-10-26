package admission

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// All owners, qualification stages and native responses in this file are
// in-memory injected doubles. Actual Computer app/contracts/lease code runs,
// but no native filesystem, process, provider, durable owner or boot route does.
type controlledClock struct{ now time.Time }

func (c *controlledClock) Now() time.Time { return c.now }

type snapshotFixture struct {
	gate        sync.Mutex
	participant authority.Participant
	approval    authority.Approval
	qualified   bool
}

func (f *snapshotFixture) WithSnapshot(_ context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	// Simulated qualification precedes Computer gate entry. This is not IO.
	f.qualified = true
	defer func() { f.qualified = false }()
	f.gate.Lock()
	defer f.gate.Unlock()
	if id != f.participant.ParticipantID {
		return unavailable()
	}
	p, a := f.participant.Clone(), f.approval.Clone()
	return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
}

type workspaceFixture struct {
	t          *testing.T
	access     *snapshotFixture
	owner      control
	calls      int
	afterFirst func()
}

func (f *workspaceFixture) observe() {
	f.t.Helper()
	if !f.access.gate.TryLock() {
		f.t.Fatal("workspace IO entered Computer gate")
	}
	f.access.gate.Unlock()
	if !f.owner.mutex().TryLock() {
		f.t.Fatal("workspace IO entered task-owner gate")
	}
	f.owner.mutex().Unlock()
	f.calls++
	if f.calls == 1 && f.afterFirst != nil {
		f.afterFirst()
	}
}
func (f *workspaceFixture) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	f.observe()
	if r.Workspace.Root != "/work" {
		f.t.Fatal("foreign descriptor")
	}
	return &port.ReadResponse{Text: "fixture rules", Bytes: 13, SHA256: strings.Repeat("a", 64)}, nil
}
func (f *workspaceFixture) List(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
	f.observe()
	return &port.ListResponse{Binding: &port.DirectoryBinding{
		RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}}, nil
}

// Preserve the same injected authority-change hook for discovery inspection.
func (w *workspaceFixture) Inspect(ctx context.Context, r port.ListRequest) (*port.DirectoryBinding, error) {
	out, err := w.List(ctx, r)
	if err != nil {
		return nil, err
	}
	return out.Binding, nil
}

type readFixture struct {
	peer      peerFixture
	access    *snapshotFixture
	clock     *controlledClock
	execution *executionsvc.Service
	lease     *executionsvc.Lease
	native    *workspaceFixture
	contract  *workspacect.Contract
}

func readonly(t *testing.T, kind, operation string) readFixture {
	t.Helper()
	f := peer(t, kind)
	clock := &controlledClock{now: time.UnixMilli(1700000000000)}
	b := selected()
	approval := authority.Approval{OwnerID: b.OwnerID, ComputerID: "computer", Generation: 3,
		Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work",
			Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}},
		Capabilities: []authority.Capability{authority.Read, authority.List},
		Network:      authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock.Now().Add(time.Hour)}
	grant, err := authority.Derive(approval, authority.Admission{Identity: b.Identity,
		AuthorityID: "authority", ComputerID: approval.ComputerID, ComputerGeneration: approval.Generation,
		Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/work",
			Mode: authority.Subtree, Access: authority.ReadAccess}},
			Capabilities: []authority.Capability{authority.Read, authority.List},
			Network:      authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock.Now().Add(time.Second)}}, clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	participant, err := authority.Create(*grant, authority.ParticipantAdmission{
		ParticipantID: b.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	access := &snapshotFixture{participant: *participant, approval: approval}
	f.owner.onEntry(func() {
		if !access.qualified {
			t.Fatal("owner entered before simulated qualification")
		}
		if access.gate.TryLock() {
			access.gate.Unlock()
			t.Fatal("owner entered before Computer snapshot gate")
		}
	})
	execution, err := executionsvc.New(access, f.peer, clock, executionsvc.Ceiling{
		Participant: *participant, Approval: approval})
	if err != nil {
		t.Fatal(err)
	}
	// Startup outer TTL has expired; independently current injected owners
	// permit time-only reissue. No real task admission is inferred from this.
	clock.now = clock.now.Add(2 * time.Second)
	capability := authority.List
	if operation == "read" {
		capability = authority.Read
	}
	lease, err := execution.Admit(context.Background(), capability)
	if err != nil {
		t.Fatal(err)
	}
	if lease.Binding() != b || !lease.Deadline().Equal(clock.Now().Add(15*time.Second)) {
		t.Fatal("lease lost fixed budget or selected binding")
	}
	native := &workspaceFixture{t: t, access: access, owner: f.owner}
	service, err := workspacesvc.NewForExecution(lease, native, clock)
	if err != nil {
		t.Fatal(err)
	}
	return readFixture{f, access, clock, execution, lease, native, workspacect.New(service)}
}
func invoke(t *testing.T, f readFixture, operation string, foreignTask bool) (bool, error) {
	t.Helper()
	b := selected()
	if foreignTask {
		b.TaskID = "request-selected-other-task"
	}
	switch operation {
	case "read":
		out, err := f.contract.Read(context.Background(), workspacect.ReadRequest{
			OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch,
			ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 17, CallID: "read-call",
			WorkspaceID: "work", RelativePath: "README.md"})
		if err == nil && (out == nil || out.Text != "fixture rules" || out.CallID != "read-call") {
			t.Fatal("wrong read fixture result")
		}
		return out != nil, err
	case "catalogue":
		out, err := f.contract.Catalogue(context.Background(), workspacect.CatalogueRequest{
			OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch,
			ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 17, CallID: "catalogue-call"})
		if err == nil && (out == nil || len(out.Workspaces) != 1 ||
			out.Workspaces[0].WorkspaceID != "work" || out.CallID != "catalogue-call") {
			t.Fatal("wrong catalogue fixture result")
		}
		return out != nil, err
	case "bootstrap":
		out, err := f.contract.Bootstrap(context.Background(), workspacect.BootstrapRequest{
			OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch,
			ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 17, CallID: "bootstrap-call",
			WorkspaceID: "work", RelativeDirectory: "."})
		if err == nil {
			if out == nil || !out.Complete || len(out.Instructions) != 1 ||
				out.CallID != "bootstrap-call" {
				t.Fatal("wrong bootstrap fixture result")
			}
			rules, ok := out.Instructions[0].(workspacect.ReadInstruction)
			if !ok || rules.Text != "fixture rules" || rules.RelativePath != "AGENTS.md" {
				t.Fatal("wrong bootstrap instruction mapping")
			}
		}
		return out != nil, err
	default:
		t.Fatal("unknown operation fixture")
		return false, nil
	}
}
func requireContractFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *workspacect.Failure
	if !errors.As(err, &failure) || failure.Code != code || failure.Retry != "never" {
		t.Fatalf("want published %s/never, got %v", code, err)
	}
}

func TestSelectedPeersComposeWithOneReadonlyLeaseOutsideOwnerGates(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		for _, operation := range []string{"read", "catalogue", "bootstrap"} {
			t.Run(kind+"/"+operation, func(t *testing.T) {
				f := readonly(t, kind, operation)
				deadline := f.lease.Deadline()
				if present, err := invoke(t, f, operation, false); err != nil || !present {
					t.Fatal(err)
				}
				if f.native.calls == 0 || !f.lease.Deadline().Equal(deadline) {
					t.Fatal("missing workspace calls or reminted deadline")
				}
			})
		}
	}
}
func TestOwnerAndFixedDeadlineChangesAfterIODiscardAllCollectedOutput(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		for _, operation := range []string{"read", "catalogue", "bootstrap"} {
			for _, change := range []string{"revoke", "mismatch", "unsettled", "generation", "deadline"} {
				t.Run(kind+"/"+operation+"/"+change, func(t *testing.T) {
					f := readonly(t, kind, operation)
					code := "AUTHORITY_TASK_MISMATCH"
					switch change {
					case "revoke":
						f.native.afterFirst = f.peer.owner.absent
					case "mismatch":
						f.native.afterFirst = func() { f.peer.owner.fail(f.peer.mismatch) }
					case "unsettled":
						code = "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
						f.native.afterFirst = func() { f.peer.owner.fail(f.peer.unsettled) }
					case "generation":
						code = "AUTHORITY_COMPUTER_MISMATCH"
						f.native.afterFirst = func() {
							f.access.gate.Lock()
							f.access.approval.Generation++
							f.access.gate.Unlock()
						}
					case "deadline":
						code = "AUTHORITY_EXPIRED"
						f.native.afterFirst = func() { f.clock.now = f.lease.Deadline() }
					}
					present, err := invoke(t, f, operation, false)
					if present || f.native.calls != 1 {
						t.Fatal("stale output escaped or native call retried")
					}
					requireContractFailure(t, err, code)
				})
			}
		}
	}
}
func TestRequestTaskIDsCannotSelectAdmissionOrReachWorkspace(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		t.Run(kind, func(t *testing.T) {
			f := readonly(t, kind, "read")
			present, err := invoke(t, f, "read", true)
			if present || f.native.calls != 0 {
				t.Fatal("body selected native admission")
			}
			requireContractFailure(t, err, "AUTHORITY_TASK_MISMATCH")
		})
	}
}
func TestAnotherReissueCannotExtendFirstPeerBoundLease(t *testing.T) {
	for _, kind := range []string{"chat", "task"} {
		t.Run(kind, func(t *testing.T) {
			f := readonly(t, kind, "read")
			deadline := f.lease.Deadline()
			f.clock.now = f.clock.now.Add(10 * time.Second)
			second, err := f.execution.Admit(context.Background(), authority.Read)
			if err != nil || !second.Deadline().Equal(f.clock.Now().Add(15*time.Second)) {
				t.Fatal(err)
			}
			f.clock.now = deadline
			present, err := invoke(t, f, "read", false)
			if present || f.native.calls != 0 || !f.lease.Deadline().Equal(deadline) {
				t.Fatal("expired first operation was renewed")
			}
			requireContractFailure(t, err, "AUTHORITY_EXPIRED")
			if err := second.WithSnapshot(context.Background(), selected().ParticipantID,
				func(port.AccessSnapshot) error { return nil }); err != nil {
				t.Fatal(err)
			}
		})
	}
}
