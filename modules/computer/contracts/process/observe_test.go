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

// Pure contract/app fixtures. No native IO, providers or packaged route proof.
type observationClock struct{ now time.Time }

func (c *observationClock) Now() time.Time { return c.now }

type observationWorkspace struct{}

func (observationWorkspace) ObserveWorkspace(context.Context) (*processsvc.ObservedWorkspace, error) {
	return &processsvc.ObservedWorkspace{WorkspaceID: "code", Root: "/code", RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}, nil
}

type observationLease struct {
	*preparationLease
	withdrawn bool
}

func (l *observationLease) WithSnapshot(ctx context.Context, id string, f func(port.AccessSnapshot) error) error {
	if l.withdrawn {
		return f(port.AccessSnapshot{})
	}
	return l.preparationLease.WithSnapshot(ctx, id, f)
}

type observationPrepared struct {
	seal   processsvc.Seal
	child  *observationChild
	spawns int
}

func (p *observationPrepared) Seal() processsvc.Seal { return p.seal }
func (p *observationPrepared) Spawn(ctx context.Context, r processsvc.SpawnRequest) (processsvc.Child, error) {
	p.spawns++
	if err := r.Check(ctx); err != nil {
		return nil, err
	}
	return p.child, nil
}

type observationChild struct {
	reads, cancels int
	afterRead      func()
	err            error
}

func (p *observationChild) Handle() string { return "child" }
func (p *observationChild) Read(_ context.Context, w processsvc.Window) (*processsvc.Observation, error) {
	p.reads++
	if p.afterRead != nil {
		p.afterRead()
	}
	if p.err != nil {
		return nil, p.err
	}
	return &processsvc.Observation{Handle: "child", Root: processsvc.RootRunning, GroupCleanup: processsvc.CleanupPending, DescendantCleanup: processsvc.CleanupPending,
		Stdout: []byte("out"), Stderr: []byte("err"), StdoutOffset: w.StdoutOffset, StdoutNext: w.StdoutOffset + 3, StdoutBytes: 10,
		StderrOffset: w.StderrOffset, StderrNext: w.StderrOffset + 3, StderrBytes: 10}, nil
}
func (p *observationChild) Cancel(context.Context) (*processsvc.CancelReceipt, error) {
	p.cancels++
	return &processsvc.CancelReceipt{Handle: "child", Status: processsvc.CancelRequested}, nil
}

func retainedContract(t *testing.T) (*Contract, *observationClock, *observationLease, *observationPrepared, *preparationReservation) {
	t.Helper()
	j := &preparationReservation{}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1}, ParticipantID: "participant", TurnID: "turn"}
	c := &observationClock{now: time.UnixMilli(1900000000000)}
	policy := authority.Policy{ExpiresAt: c.now.Add(time.Hour), Workspaces: []authority.Scope{{WorkspaceID: "code", Root: "/code", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands}
	l := &preparationLease{binding: binding, deadline: c.now.Add(15 * time.Second), p: authority.Participant{ParticipantID: "participant", Grant: authority.Grant{Identity: binding.Identity, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 1, Policy: policy}},
		a: authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 1, ExpiresAt: c.now.Add(time.Hour), Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "code", Root: "/code", Access: authority.ReadAccess, ShellVerified: true, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}}}
	p := &observationPrepared{seal: processsvc.Seal{Digest: strings.Repeat("a", 64), WorkspaceID: "code", Root: "/code", Cwd: "/code", RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}, child: &observationChild{}}
	service, err := processsvc.New("op", l, p, j, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	contract, err := New(service)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := contract.Start(context.Background(), StartRequest{"op"}); err != nil || out.Handle != "child" {
		t.Fatal(out, err)
	}
	c.now = l.deadline.Add(time.Millisecond)
	pRead, aRead := l.p.Clone(), l.a.Clone()
	pRead.Grant.Capabilities = []authority.Capability{authority.Read}
	pRead.Grant.Commands = authority.NoCommands
	pRead.Grant.ExpiresAt = c.now.Add(15 * time.Second)
	aRead.Capabilities = []authority.Capability{authority.Read}
	aRead.Commands = authority.NoCommands
	aRead.Workspaces[0].ShellVerified = false
	read := &observationLease{preparationLease: &preparationLease{binding: binding, deadline: pRead.Grant.ExpiresAt, p: pRead, a: aRead}}
	return contract, c, read, p, j
}

func TestObserverContractReadsExpiredProcessAndMapsWindowWithoutEffects(t *testing.T) {
	c, _, current, p, j := retainedContract(t)
	r := ReadRequest{Handle: "child", StdoutOffset: 2, StderrOffset: 4}
	if out, err := c.Read(context.Background(), r); err == nil || out != nil || p.child.reads != 0 {
		t.Fatal("legacy lease renewed", out, err)
	}
	o, err := c.Observer(current, observationWorkspace{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := o.Read(context.Background(), r)
	if err != nil || out.Handle != "child" || out.State != Running || out.RootState != RootRunning || out.StdoutBase64 != "b3V0" || out.StderrBase64 != "ZXJy" ||
		out.StdoutOffset != 2 || out.StdoutNext != 5 || out.StderrOffset != 4 || out.StderrNext != 7 || out.StdoutBytes != 10 || out.StderrBytes != 10 ||
		p.spawns != 1 || j.calls != 1 || p.child.cancels != 0 || p.child.reads != 1 {
		t.Fatal(out, err)
	}
	shape := reflect.TypeOf(o)
	if shape.NumMethod() != 1 || shape.Method(0).Name != "Read" {
		t.Fatal("public observer exposes effects")
	}
}

func TestObserverContractWithdrawalAndUnknownNeverRetry(t *testing.T) {
	c, _, current, p, j := retainedContract(t)
	o, err := c.Observer(current, observationWorkspace{})
	if err != nil {
		t.Fatal(err)
	}
	p.child.afterRead = func() { current.withdrawn = true }
	out, err := o.Read(context.Background(), ReadRequest{Handle: "child"})
	var f *Failure
	if out != nil || !errors.As(err, &f) || f.Outcome != "refused" || f.Retry != "never" {
		t.Fatal("disclosed after withdrawal", out, err)
	}
	// Fixture recovery only, to test result uncertainty independently.
	current.withdrawn = false
	p.child.afterRead = nil
	p.child.err = &processsvc.NativeFailure{Unknown: true}
	out, err = o.Read(context.Background(), ReadRequest{Handle: "child"})
	if out != nil || !errors.As(err, &f) || f.Outcome != "outcome_unknown" || f.Retry != "never" {
		t.Fatal(out, err)
	}
	p.child.err = nil
	out, err = o.Read(context.Background(), ReadRequest{Handle: "child"})
	if err != nil || out.State != Unknown || p.spawns != 1 || j.calls != 1 || p.child.cancels != 0 {
		t.Fatal("unknown upgraded or replayed", out, err)
	}
}

func TestObserverContractRejectsCrossedOwnerAndMissingSelection(t *testing.T) {
	c, _, current, p, _ := retainedContract(t)
	current.binding.OwnerID = "foreign"
	out, err := c.Observer(current, observationWorkspace{})
	var f *Failure
	if out != nil || !errors.As(err, &f) || f.Code != "AUTHORITY_OWNER_MISMATCH" || f.Retry != "never" || p.child.reads != 0 {
		t.Fatal(out, err)
	}
	var nilContract *Contract
	if out, err := nilContract.Observer(current, observationWorkspace{}); out != nil || err == nil {
		t.Fatal("nil contract selected observer")
	}
	var nilObserver *Observer
	if out, err := nilObserver.Read(context.Background(), ReadRequest{}); out != nil || err == nil {
		t.Fatal("nil observer read")
	}
}
