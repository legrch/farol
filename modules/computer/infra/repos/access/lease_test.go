package access

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	"golang.org/x/sys/unix"
)

// Real disposable authority store + filesystem. The task-owner projection and
// clock are fixtures; these are not real ChatGPT turns or connector reconnects.
type leaseTasks struct {
	mutex       sync.Mutex
	binding     *port.TaskBinding
	inspections atomic.Int64
}

func (o *leaseTasks) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	o.inspections.Add(1)
	o.mutex.Lock()
	defer o.mutex.Unlock()
	if o.binding == nil {
		return inspect(nil)
	}
	copy := *o.binding
	return inspect(&copy)
}
func (o *leaseTasks) change(f func(*port.TaskBinding)) {
	o.mutex.Lock()
	defer o.mutex.Unlock()
	f(o.binding)
}
func fixtureLeases(t *testing.T) (stateFixture, executionsvc.Ceiling, *leaseTasks) {
	t.Helper()
	f := fixtureState(t)
	f.admission.ExpiresAt = f.clock.Now().Add(time.Second)
	approve(t, f)
	p := admit(t, f)
	return f, executionsvc.Ceiling{Participant: *p, Approval: f.approval}, &leaseTasks{binding: &port.TaskBinding{Identity: f.admission.Identity, ParticipantID: p.ParticipantID, TurnID: "trusted-turn-1"}}
}
func issuerLeases(t *testing.T, s *Store, f stateFixture, ceiling executionsvc.Ceiling, tasks *leaseTasks) *executionsvc.Service {
	t.Helper()
	issuer, err := executionsvc.New(s, tasks, f.clock, ceiling)
	if err != nil {
		t.Fatal(err)
	}
	return issuer
}
func admittedLease(t *testing.T, s *executionsvc.Service, kind authority.Capability) *executionsvc.Lease {
	t.Helper()
	l, err := s.Admit(context.Background(), kind)
	if err != nil || l == nil {
		t.Fatalf("lease: %v", err)
	}
	return l
}
func leaseRequest(f stateFixture, l *executionsvc.Lease) workspacesvc.ReadRequest {
	b := l.Binding()
	return workspacesvc.ReadRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: 99, CallID: "disposable-read", WorkspaceID: "work", RelativePath: "README.md"}
}
func nativeLeaseRead(t *testing.T, f stateFixture, l *executionsvc.Lease) {
	t.Helper()
	s := workspacesvc.New(l, filesystem.New(f.home), f.clock)
	r := leaseRequest(f, l)
	out, err := s.Read(context.Background(), r)
	if err != nil || out == nil || out.Text != "disposable Brain/code read\n" || out.TurnID != r.TurnID || out.CallID != r.CallID {
		t.Fatalf("native renewed read: %v", err)
	}
}
func TestNativeReadAcrossOuterExpiryNewTrustedTurnAndReconnect(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	issuer := issuerLeases(t, f.store, f, ceiling, tasks)
	before, err := os.ReadFile(filepath.Join(f.root, stateName))
	if err != nil {
		t.Fatal(err)
	}
	first := admittedLease(t, issuer, authority.Read)
	// Real IO completes after the old outer grant TTL, within this fixed lease.
	f.clock.ms.Add(2000)
	nativeLeaseRead(t, f, first)
	tasks.change(func(b *port.TaskBinding) { b.TurnID = "trusted-turn-2" })
	nativeLeaseRead(t, f, admittedLease(t, issuer, authority.Read))
	// A new issuer models reconnect without renewing an already admitted lease.
	issuer = issuerLeases(t, f.store, f, ceiling, tasks)
	third := admittedLease(t, issuer, authority.Read)
	nativeLeaseRead(t, f, third)
	listLease := admittedLease(t, issuer, authority.List)
	listing, err := workspacesvc.New(listLease, filesystem.New(f.home), f.clock).List(context.Background(), workspacesvc.ListRequest{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "main", TurnID: listLease.Binding().TurnID, CallID: "list", WorkspaceID: "work", RelativePath: "."})
	if err != nil || listing == nil || len(listing.Entries) != 1 || listing.Entries[0] != "README.md" {
		t.Fatalf("renewed native list: %v", err)
	}
	after, err := os.ReadFile(filepath.Join(f.root, stateName))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("renewal published new authority state")
	}
}
func TestNativeColdRestartNeedsCurrentTaskProofAndDoesNotReviveOldLease(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	first := admittedLease(t, issuerLeases(t, f.store, f, ceiling, tasks), authority.Read)
	s := restored(t, f)
	f.clock.ms.Add(2000)
	failCode(t, first.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { return nil }), "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	issuer := issuerLeases(t, s, f, ceiling, tasks)
	nativeLeaseRead(t, f, admittedLease(t, issuer, authority.Read))
	tasks.binding = nil
	out, err := issuer.Admit(context.Background(), authority.Read)
	if out != nil {
		t.Fatal("restart manufactured admission proof")
	}
	failCode(t, err, "AUTHORITY_TASK_MISMATCH")
}

type leaseNative struct {
	port.Workspace
	hook  func()
	reads int
}

func (n *leaseNative) Read(ctx context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.reads++
	out, err := n.Workspace.Read(ctx, r)
	if n.hook != nil {
		n.hook()
	}
	return out, err
}
func TestNativeLeaseCurrentChangesDefeatDisclosureAndSurviveRestart(t *testing.T) {
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
		{"owner expiry", "AUTHORITY_EXPIRED", func(t *testing.T, f stateFixture, _ *leaseTasks) {
			a := f.approval.Clone()
			a.ExpiresAt = f.clock.Now().Add(time.Millisecond)
			if err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, a); err != nil {
				t.Fatal(err)
			}
			f.clock.ms.Add(2)
		}},
		{"lease deadline", "AUTHORITY_EXPIRED", func(t *testing.T, f stateFixture, _ *leaseTasks) { f.clock.ms.Add(15000) }},
		{"trusted turn", "AUTHORITY_TASK_MISMATCH", func(t *testing.T, f stateFixture, o *leaseTasks) {
			o.change(func(b *port.TaskBinding) { b.TurnID = "different" })
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, ceiling, tasks := fixtureLeases(t)
			issuer := issuerLeases(t, f.store, f, ceiling, tasks)
			l := admittedLease(t, issuer, authority.Read)
			n := &leaseNative{Workspace: filesystem.New(f.home), hook: func() { test.change(t, f, tasks) }}
			out, err := workspacesvc.New(l, n, f.clock).Read(context.Background(), leaseRequest(f, l))
			if out != nil || n.reads != 1 {
				t.Fatal("disclosed/replayed")
			}
			failCode(t, err, test.code)
			s := restored(t, f)
			again := issuerLeases(t, s, f, ceiling, tasks)
			fresh, err := again.Admit(context.Background(), authority.Read)
			if test.name == "lease deadline" || test.name == "trusted turn" {
				if err != nil || fresh == nil {
					t.Fatal(err)
				}
				nativeLeaseRead(t, f, fresh)
			} else {
				if fresh != nil {
					t.Fatal("revoked/expired authority restored")
				}
				failCode(t, err, test.code)
			}
		})
	}
}
func TestNativeGenerationAndLineageTombstonesCannotBeRenewed(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	child, err := f.store.Delegate(context.Background(), status(t, f.store).Revision, "main", authority.Delegation{ParticipantAdmission: authority.ParticipantAdmission{ParticipantID: "child", Role: authority.Agent, MutationOwnership: authority.NoOwnership}})
	if err != nil {
		t.Fatal(err)
	}
	ceiling.Participant = *child
	tasks.binding.ParticipantID = "child"
	issuer := issuerLeases(t, f.store, f, ceiling, tasks)
	l := admittedLease(t, issuer, authority.Read)
	if err = f.store.RevokeParticipant(context.Background(), status(t, f.store).Revision, "main"); err != nil {
		t.Fatal(err)
	}
	failCode(t, l.WithSnapshot(context.Background(), "child", func(port.AccessSnapshot) error { return nil }), "COMPUTER_PARTICIPANT_NOT_FOUND")
	s := restored(t, f)
	out, err := issuerLeases(t, s, f, ceiling, tasks).Admit(context.Background(), authority.Read)
	if out != nil {
		t.Fatal("lineage tombstone renewed")
	}
	failCode(t, err, "COMPUTER_PARTICIPANT_NOT_FOUND")
	if err = s.RevokeApproval(context.Background(), status(t, s).Revision); err != nil {
		t.Fatal(err)
	}
	failCode(t, s.UpdateApproval(context.Background(), status(t, s).Revision, f.approval), "AUTHORITY_COMPUTER_MISMATCH")
}
func TestUnknownAuthorityPublicationIsRetainedAcrossRenewalObservation(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	issuer := issuerLeases(t, f.store, f, ceiling, tasks)
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	a := f.approval.Clone()
	a.ExpiresAt = a.ExpiresAt.Add(time.Hour)
	err := f.store.UpdateApproval(context.Background(), status(t, f.store).Revision, a)
	if !OutcomeUnknown(err) {
		t.Fatalf("missing original unknown: %v", err)
	}
	original := err
	out, err := issuer.Admit(context.Background(), authority.Read)
	if out != nil {
		t.Fatal("poisoned owner issued lease")
	}
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	s := restored(t, f)
	issuer = issuerLeases(t, s, f, ceiling, tasks)
	nativeLeaseRead(t, f, admittedLease(t, issuer, authority.Read))
	if !OutcomeUnknown(original) {
		t.Fatal("renewal erased original unknown")
	}
	// The one authority publication is observed, never retried by reissue.
	if status(t, s).Revision != 3 {
		t.Fatal("renewal republished authority state")
	}
}

func TestNativeQualificationRefusesBeforeTrustedTaskInspection(t *testing.T) {
	f, ceiling, tasks := fixtureLeases(t)
	issuer := issuerLeases(t, f.store, f, ceiling, tasks)
	if err := os.Chmod(filepath.Join(f.root, stateName), 0644); err != nil {
		t.Fatal(err)
	}
	out, err := issuer.Admit(context.Background(), authority.Read)
	if out != nil {
		t.Fatal("unsafe file produced authority")
	}
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
	if tasks.inspections.Load() != 0 {
		t.Fatal("native file qualification ran after entering task gate")
	}
}
