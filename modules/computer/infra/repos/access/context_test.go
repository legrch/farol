package access

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// Disposable native state + filesystem + published in-process contract. The
// trusted Task projection and clock are symbolic; no live route is exercised.
type contextNative struct {
	port.Workspace
	hook    func()
	lists   int
	request port.ListRequest
}

func (n *contextNative) List(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
	n.lists++
	n.request = r
	out, err := n.Workspace.List(ctx, r)
	if n.hook != nil {
		n.hook()
	}
	return out, err
}
func contextRequest(f stateFixture, l *executionsvc.Lease) workspacect.ContextRequest {
	b := l.Binding()
	return workspacect.ContextRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 99, CallID: "disposable-context", WorkspaceID: "work", RelativePath: "."}
}
func expectContextFailure(t *testing.T, err error, code string) {
	t.Helper()
	var f *workspacect.Failure
	if !errors.As(err, &f) || f.Code != code || f.Retry != "never" {
		t.Fatalf("want %s/never, got %v", code, err)
	}
}
func nativeContext(t *testing.T, f stateFixture, l *executionsvc.Lease) *workspacect.ContextResponse {
	t.Helper()
	out, err := workspacect.New(workspacesvc.New(l, filesystem.New(f.home), f.clock)).Context(context.Background(), contextRequest(f, l))
	if err != nil || out == nil || out.Root != f.workspace || out.ApprovedRoot.Path != f.workspace || out.ApprovedRoot.Device != f.approval.Workspaces[0].RootIdentity.Device || out.ApprovedRoot.Inode != f.approval.Workspaces[0].RootIdentity.Inode || out.Scope != "subtree" || out.TurnID != l.Binding().TurnID {
		t.Fatalf("renewed native context: %v", err)
	}
	return out
}

func TestNativeContextAcrossOuterExpiryNewTurnReconnectAndColdRestart(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	issuer := issuerLeases(t, f.store, f, ceiling, tasks)
	first := admittedLease(t, issuer, authority.List)
	f.clock.ms.Add(2000)
	nativeContext(t, f, first)
	tasks.change(func(b *port.TaskBinding) { b.TurnID = "trusted-turn-2" })
	n := &contextNative{Workspace: filesystem.New(f.home)}
	out, err := workspacect.New(workspacesvc.New(first, n, f.clock)).Context(context.Background(), contextRequest(f, first))
	if out != nil || n.lists != 0 {
		t.Fatal("old turn context reached native IO")
	}
	expectContextFailure(t, err, "AUTHORITY_TASK_MISMATCH")
	issuer = issuerLeases(t, f.store, f, ceiling, tasks)
	second := admittedLease(t, issuer, authority.List)
	nativeContext(t, f, second)
	store := restored(t, f)
	out, err = workspacect.New(workspacesvc.New(second, n, f.clock)).Context(context.Background(), contextRequest(f, second))
	if out != nil || n.lists != 0 {
		t.Fatal("closed owner served cached context")
	}
	expectContextFailure(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	issuer = issuerLeases(t, store, f, ceiling, tasks)
	nativeContext(t, f, admittedLease(t, issuer, authority.List))
}

func TestNativeContextDiscardsRootAfterCurrentOwnerOrLeaseChanges(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(*testing.T, stateFixture, *leaseTasks)
	}{
		{"participant revoke", "COMPUTER_PARTICIPANT_NOT_FOUND", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			if err := f.store.RevokeParticipant(context.Background(), status(t, f.store).Revision, "main"); err != nil {
				t.Fatal(err)
			}
		}},
		{"approval revoke", "COMPUTER_APPROVAL_NOT_FOUND", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			if err := f.store.RevokeApproval(context.Background(), status(t, f.store).Revision); err != nil {
				t.Fatal(err)
			}
		}},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			a := f.approval.Clone()
			a.Generation++
			if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, a); err != nil {
				t.Fatal(err)
			}
		}},
		{"approval expiry", "AUTHORITY_EXPIRED", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			a := f.approval.Clone()
			a.ExpiresAt = f.clock.Now().Add(time.Millisecond)
			if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, a); err != nil {
				t.Fatal(err)
			}
			f.clock.ms.Add(2)
		}},
		{"fixed deadline", "AUTHORITY_EXPIRED", func(_ *testing.T, f stateFixture, _ *leaseTasks) { f.clock.ms.Add(15000) }},
		{"trusted task revoked", "AUTHORITY_TASK_MISMATCH", func(_ *testing.T, _ stateFixture, o *leaseTasks) { o.mutex.Lock(); o.binding = nil; o.mutex.Unlock() }},
		{"trusted turn rebound", "AUTHORITY_TASK_MISMATCH", func(_ *testing.T, _ stateFixture, o *leaseTasks) {
			o.change(func(b *port.TaskBinding) { b.TurnID = "other-turn" })
		}},
		{"owner unavailable", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, ceiling, tasks := fixtureLeases(t)
			l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
			n := &contextNative{Workspace: filesystem.New(f.home), hook: func() { test.change(t, f, tasks) }}
			out, err := workspacect.New(workspacesvc.New(l, n, f.clock)).Context(context.Background(), contextRequest(f, l))
			if out != nil || n.lists != 1 {
				t.Fatal("stale context disclosed")
			}
			expectContextFailure(t, err, test.code)
		})
	}
}

func TestNativeContextMissingTaskProofCannotAdmitAnOperation(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	issuer, err := executionsvc.New(f.store, nil, f.clock, ceiling)
	if issuer != nil {
		t.Fatal("missing projection received issuer")
	}
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	tasks.binding = nil
	issuer = issuerLeases(t, f.store, f, ceiling, tasks)
	l, err := issuer.Admit(context.Background(), authority.List)
	if l != nil {
		t.Fatal("missing trusted task received context lease")
	}
	failCode(t, err, "AUTHORITY_TASK_MISMATCH")
}

func TestNativeContextUsesNarrowedScopeRootAndDoesNotInspectAncestors(t *testing.T) {
	f := fixtureState(t)
	if err := os.MkdirAll(filepath.Join(f.workspace, "src", "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.workspace, "AGENTS.md"), []byte("private ancestor rules"), 0600); err != nil {
		t.Fatal(err)
	}
	f.admission.Workspaces[0].Root = filepath.Join(f.workspace, "src")
	approve(t, f)
	p := admit(t, f)
	tasks := &leaseTasks{binding: &port.TaskBinding{Identity: f.admission.Identity, ParticipantID: p.ParticipantID, TurnID: "trusted-turn"}}
	ceiling := executionsvc.Ceiling{Participant: *p, Approval: f.approval}
	l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
	r := contextRequest(f, l)
	r.RelativePath = "nested"
	n := &contextNative{Workspace: filesystem.New(f.home)}
	out, err := workspacect.New(workspacesvc.New(l, n, f.clock)).Context(context.Background(), r)
	if err != nil || out == nil || out.Root != filepath.Join(f.workspace, "src") || out.ApprovedRoot.Path != f.workspace || n.request.Workspace.Root != out.Root || n.request.RelativePath != "nested" {
		t.Fatalf("narrowed context: %v", err)
	}
}

func TestNativeContextKeepsObservedBindingOutOfPublishedList(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	l := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.List)
	b := l.Binding()
	out, err := workspacect.New(workspacesvc.New(l, filesystem.New(f.home), f.clock)).List(context.Background(), workspacect.ListRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 99, CallID: "disposable-list", WorkspaceID: "work", RelativePath: "."})
	if err != nil || out == nil {
		t.Fatalf("published list: %v", err)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{f.workspace, "Binding", "ApprovedRoot", "Device", "Inode"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatal("internal native binding escaped through published List DTO")
		}
	}
}
