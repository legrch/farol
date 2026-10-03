package process

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Independent DTO mapping to the actual service with fake owner/preparer ports.
// No native/provider process, persistence or installed route is qualified.
type preparationClock struct{ now time.Time }

func (c preparationClock) Now() time.Time { return c.now }

type preparationLease struct {
	binding  port.TaskBinding
	p        authority.Participant
	a        authority.Approval
	deadline time.Time
}

func (l *preparationLease) Binding() port.TaskBinding { return l.binding }
func (l *preparationLease) Deadline() time.Time       { return l.deadline }
func (l *preparationLease) WithSnapshot(_ context.Context, _ string, f func(port.AccessSnapshot) error) error {
	p, a := l.p.Clone(), l.a.Clone()
	return f(port.AccessSnapshot{Participant: &p, Approval: &a})
}

type preparationReservation struct{ calls int }

func (j *preparationReservation) Reserve(_ context.Context, i processsvc.Intent) (*processsvc.ReservationReceipt, error) {
	j.calls++
	return &processsvc.ReservationReceipt{Status: processsvc.Reserved, Intent: i}, nil
}

type preparationChild struct{}

func (preparationChild) Handle() string { return "child" }
func (preparationChild) Read(_ context.Context, w processsvc.Window) (*processsvc.Observation, error) {
	return &processsvc.Observation{Handle: "child", Root: processsvc.RootRunning, GroupCleanup: processsvc.CleanupPending, DescendantCleanup: processsvc.CleanupPending, StdoutOffset: w.StdoutOffset, StdoutNext: w.StdoutOffset, StderrOffset: w.StderrOffset, StderrNext: w.StderrOffset}, nil
}
func (preparationChild) Cancel(context.Context) (*processsvc.CancelReceipt, error) {
	return &processsvc.CancelReceipt{Handle: "child", Status: processsvc.CancelRequested}, nil
}

type preparationNative struct {
	scope             processsvc.Scope
	captured          processsvc.Invocation
	prepared, spawned int
	err               error
}

func (n *preparationNative) Scope() processsvc.Scope { return n.scope }
func (n *preparationNative) Prepare(_ context.Context, v processsvc.Invocation) (processsvc.Selected, error) {
	n.prepared++
	n.captured = v.Clone()
	if n.err != nil {
		return nil, n.err
	}
	return n, nil
}
func (n *preparationNative) Invocation() processsvc.Invocation { return n.captured.Clone() }
func (n *preparationNative) Seal() processsvc.Seal {
	return processsvc.Seal{Digest: strings.Repeat("a", 64), WorkspaceID: n.scope.WorkspaceID, Root: n.scope.Root, Cwd: n.scope.Cwd, RootIdentity: n.scope.RootIdentity, Write: n.scope.Write}
}
func (n *preparationNative) Spawn(ctx context.Context, r processsvc.SpawnRequest) (processsvc.Child, error) {
	n.spawned++
	if err := r.Check(ctx); err != nil {
		return nil, err
	}
	return preparationChild{}, nil
}
func newPreparationContract(t *testing.T) (*Contract, *preparationNative, *preparationReservation, PrepareRequest) {
	t.Helper()
	now := time.UnixMilli(1900000000000)
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"}
	lease := &preparationLease{binding: binding, deadline: now.Add(15 * time.Second), p: authority.Participant{ParticipantID: "participant", Grant: authority.Grant{Identity: binding.Identity, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 1, Policy: authority.Policy{ExpiresAt: now.Add(time.Hour), Workspaces: []authority.Scope{{WorkspaceID: "code", Root: "/code", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands}}}, a: authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 1, ExpiresAt: now.Add(time.Hour), Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "code", Root: "/code", Access: authority.ReadAccess, ShellVerified: true, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}}}
	native := &preparationNative{scope: processsvc.Scope{RuntimeID: "cli", WorkspaceID: "code", Root: "/code", Cwd: "/code", RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}
	journal := &preparationReservation{}
	service, err := processsvc.NewForInvocation("op", lease, native, journal, &sync.Mutex{}, preparationClock{now})
	if err != nil {
		t.Fatal(err)
	}
	contract, err := New(service)
	if err != nil {
		t.Fatal(err)
	}
	return contract, native, journal, PrepareRequest{OperationID: "op", Invocation: Invocation{RuntimeID: "cli", SessionID: "exact-session", ModelID: "selected-model", AdmissionID: "authority", Arguments: []string{"--session-id", "exact-session"}, Input: []byte("synthetic input")}}
}
func TestPrepareContractMapsIndependentInputsToActualService(t *testing.T) {
	c, n, j, r := newPreparationContract(t)
	out, err := c.Prepare(context.Background(), r)
	if err != nil || out.OperationID != "op" || out.SessionID != "exact-session" || out.ModelID != "selected-model" || out.AdmissionID != "authority" || n.captured.Arguments[1] != "exact-session" || string(n.captured.Input) != "synthetic input" || n.prepared != 1 || n.spawned != 0 || j.calls != 0 {
		t.Fatalf("%#v %v", out, err)
	}
	out.SessionID = "changed"
	r.Invocation.Input[0] = 'X'
	r.Invocation.Arguments[1] = "changed"
	_, err = c.Prepare(context.Background(), r)
	var f *Failure
	if !errors.As(err, &f) || f.Code != "PROCESS_INVOCATION_CONFLICT" || f.Retry != "never" || n.prepared != 1 {
		t.Fatal("input rebound", err)
	}
	started, err := c.Start(context.Background(), StartRequest{OperationID: "op"})
	if err != nil || started.Handle != "child" || n.spawned != 1 || j.calls != 1 {
		t.Fatalf("%#v %v", started, err)
	}
}
func TestPrepareContractHasNoHostAuthoritySelectorOrTranscriptReceipt(t *testing.T) {
	for _, shape := range []reflect.Type{reflect.TypeOf(Invocation{}), reflect.TypeOf(PrepareRequest{})} {
		for i := 0; i < shape.NumField(); i++ {
			switch shape.Field(i).Name {
			case "Executable", "ExecutableSHA256", "Root", "Cwd", "WorkspaceID", "Environment", "OwnerID", "TaskID", "ParticipantID", "Generation", "Lease", "Deadline":
				t.Fatal("untrusted host/authority selector", shape.Field(i).Name)
			}
		}
	}
	shape := reflect.TypeOf(PrepareResponse{})
	for i := 0; i < shape.NumField(); i++ {
		switch shape.Field(i).Name {
		case "Input", "Arguments", "Environment":
			t.Fatal("private command in receipt")
		}
	}
	var nilContract *Contract
	if out, err := nilContract.Prepare(context.Background(), PrepareRequest{}); out != nil || err == nil {
		t.Fatal("nil contract prepared")
	}
}
func TestPrepareContractUnknownStaysDistinctAndDoesNotRetry(t *testing.T) {
	c, n, j, r := newPreparationContract(t)
	n.err = &processsvc.NativeFailure{Unknown: true}
	for i := 0; i < 2; i++ {
		_, err := c.Prepare(context.Background(), r)
		var f *Failure
		if !errors.As(err, &f) || f.Outcome != "outcome_unknown" || f.Retry != "never" {
			t.Fatal(err)
		}
	}
	if n.prepared != 1 || n.spawned != 0 || j.calls != 0 {
		t.Fatal("unknown replayed")
	}
}
