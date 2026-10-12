package execution_test

import (
	"context"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// These tests exercise admission and observation with existing in-memory owners
// and a fake clock. They do not dispatch or qualify native processes.
func processBudgetFixture(t *testing.T, policy authority.FilePolicy) fixture {
	t.Helper()
	f := newFixture(t)
	a, p := f.ceiling.Approval.Clone(), f.ceiling.Participant.Clone()
	a.FilePolicy, p.Grant.FilePolicy = policy, policy
	f.access.PutApproval(a)
	f.access.PutParticipant(p)
	f.ceiling = executionsvc.Ceiling{Participant: p, Approval: a}
	var err error
	f.service, err = executionsvc.New(f.access, f.tasks, f.clock, f.ceiling)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestProcessBudgetOnlyRootScopedShellGetsTenMinutes(t *testing.T) {
	if authority.ProcessExecutionLifetime != 10*time.Minute {
		t.Fatalf("process budget = %s, want 10m", authority.ProcessExecutionLifetime)
	}
	for _, policy := range []struct {
		name string
		mode authority.FilePolicy
	}{
		{"legacy", authority.LegacyProtectedFiles},
		{"root scoped", authority.RootScopedFiles},
	} {
		t.Run(policy.name, func(t *testing.T) {
			f := processBudgetFixture(t, policy.mode)
			for _, kind := range []authority.Capability{authority.Shell, authority.Verify, authority.Read, authority.List, authority.Search, authority.Write} {
				t.Run(string(kind), func(t *testing.T) {
					want := 15 * time.Second
					if kind == authority.Verify {
						want = 120 * time.Second
					} else if kind == authority.Shell && policy.mode == authority.RootScopedFiles {
						want = 10 * time.Minute
					}
					l := lease(t, f, kind)
					if got := l.Deadline().Sub(f.clock.Now()); got != want {
						t.Fatalf("%s budget = %s, want %s", kind, got, want)
					}
					if !authority.SameParticipantCeiling(l.Participant(), f.ceiling.Participant) {
						t.Fatal("operation budget changed the participant ceiling")
					}
				})
			}
			catalogue, err := f.service.AdmitCatalogue(context.Background())
			if err != nil || catalogue == nil {
				t.Fatalf("catalogue admission: %v", err)
			}
			if got := catalogue.Deadline().Sub(f.clock.Now()); got != 15*time.Second {
				t.Fatalf("catalogue budget = %s, want 15s", got)
			}
		})
	}
}

func TestProcessBudgetOwnerExpiryCapsRootScopedShell(t *testing.T) {
	for _, remaining := range []time.Duration{3 * time.Minute, 10 * time.Minute, 20 * time.Minute} {
		t.Run(remaining.String(), func(t *testing.T) {
			f := processBudgetFixture(t, authority.RootScopedFiles)
			a := f.ceiling.Approval.Clone()
			a.ExpiresAt = f.clock.Now().Add(remaining)
			f.access.PutApproval(a)
			l := lease(t, f, authority.Shell)
			want := min(remaining, 10*time.Minute)
			if got := l.Deadline().Sub(f.clock.Now()); got != want {
				t.Fatalf("owner remaining %s: budget = %s, want %s", remaining, got, want)
			}
			f.clock.advance(want - time.Millisecond)
			if err := observe(l); err != nil {
				t.Fatalf("refused before capped deadline: %v", err)
			}
			f.clock.advance(time.Millisecond)
			refused(t, observe(l), "AUTHORITY_EXPIRED")
		})
	}
}

func TestProcessBudgetObservationsAndNewLeasesNeverRenewOriginal(t *testing.T) {
	f := processBudgetFixture(t, authority.RootScopedFiles)
	storedExpiry := f.ceiling.Participant.Grant.ExpiresAt
	original := lease(t, f, authority.Shell)
	deadline := original.Deadline()
	if !deadline.Equal(f.clock.Now().Add(10 * time.Minute)) {
		t.Fatal("original Shell did not receive its process budget")
	}
	f.clock.advance(2 * time.Minute) // Beyond the ordinary, verification and outer fixture TTLs.
	if err := observe(original); err != nil {
		t.Fatalf("Shell refused while its original budget remains: %v", err)
	}
	read := lease(t, f, authority.Read)
	newShell := lease(t, f, authority.Shell)
	if !read.Deadline().Equal(f.clock.Now().Add(15*time.Second)) || !newShell.Deadline().Equal(f.clock.Now().Add(10*time.Minute)) {
		t.Fatal("new operations did not receive independent budgets")
	}
	for _, elapsed := range []time.Duration{time.Second, 14 * time.Second, 15 * time.Second} {
		f.clock.advance(elapsed)
		if err := original.WithSnapshot(context.Background(), "main", func(v port.AccessSnapshot) error {
			if !v.Participant.Grant.ExpiresAt.Equal(deadline) {
				t.Fatal("observation renewed the original participant snapshot")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if !original.Deadline().Equal(deadline) {
			t.Fatal("observation or new operation renewed the original deadline")
		}
	}
	refused(t, observe(read), "AUTHORITY_EXPIRED")
	f.clock.advance(deadline.Sub(f.clock.Now()) - time.Millisecond)
	if err := observe(original); err != nil {
		t.Fatalf("refused immediately before original deadline: %v", err)
	}
	f.clock.advance(time.Millisecond)
	called := false
	err := original.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { called = true; return nil })
	refused(t, err, "AUTHORITY_EXPIRED")
	if called || !original.Deadline().Equal(deadline) {
		t.Fatal("expired original lease disclosed or changed its deadline")
	}
	if err := observe(newShell); err != nil {
		t.Fatalf("new Shell lost its independent budget: %v", err)
	}
	if err := f.access.WithSnapshot(context.Background(), "main", func(v port.AccessSnapshot) error {
		if !v.Participant.Grant.ExpiresAt.Equal(storedExpiry) {
			t.Fatal("admission or observation changed the durable participant expiry")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProcessBudgetOwnerRenewalNeverExtendsCappedShell(t *testing.T) {
	f := processBudgetFixture(t, authority.RootScopedFiles)
	a := f.ceiling.Approval.Clone()
	a.ExpiresAt = f.clock.Now().Add(3 * time.Minute)
	f.access.PutApproval(a)
	original := lease(t, f, authority.Shell)
	deadline := original.Deadline()
	f.clock.advance(time.Minute)
	f.access.PutApproval(f.ceiling.Approval)
	newShell := lease(t, f, authority.Shell)
	if !newShell.Deadline().Equal(f.clock.Now().Add(10 * time.Minute)) {
		t.Fatal("renewed owner approval did not bound the new Shell independently")
	}
	if err := observe(original); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(deadline.Sub(f.clock.Now()))
	refused(t, observe(original), "AUTHORITY_EXPIRED")
	if !original.Deadline().Equal(deadline) {
		t.Fatal("owner renewal extended the original capped Shell")
	}
	if err := observe(newShell); err != nil {
		t.Fatal(err)
	}
}

func TestProcessBudgetCurrentRevocationAndGenerationRefuseShell(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(fixture)
	}{
		{"participant revoked", "COMPUTER_PARTICIPANT_NOT_FOUND", func(f fixture) { f.access.RevokeParticipant("main") }},
		{"approval revoked", "COMPUTER_APPROVAL_NOT_FOUND", func(f fixture) { f.access.RevokeApproval("computer") }},
		{"generation changed", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.Generation++
			f.access.PutApproval(a)
		}},
		{"task revoked", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.binding = nil }},
		{"owner expiry shortened", "AUTHORITY_EXPIRED", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.ExpiresAt = f.clock.Now().Add(-time.Millisecond)
			f.access.PutApproval(a)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := processBudgetFixture(t, authority.RootScopedFiles)
			l := lease(t, f, authority.Shell)
			deadline := l.Deadline()
			f.clock.advance(2 * time.Minute)
			if err := observe(l); err != nil {
				t.Fatal(err)
			}
			test.change(f)
			called := false
			err := l.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { called = true; return nil })
			refused(t, err, test.code)
			if called || !l.Deadline().Equal(deadline) {
				t.Fatal("current-owner refusal disclosed or changed the fixed Shell deadline")
			}
			out, err := f.service.Admit(context.Background(), authority.Shell)
			if out != nil {
				t.Fatal("current-owner refusal issued a new Shell lease")
			}
			refused(t, err, test.code)
		})
	}
}
