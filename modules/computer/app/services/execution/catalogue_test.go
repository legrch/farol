package execution_test

import (
	"context"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func emptyFixture(t *testing.T) fixture {
	t.Helper()
	f := newFixture(t)
	a, p := f.ceiling.Approval.Clone(), f.ceiling.Participant.Clone()
	a.Workspaces, a.Capabilities, a.ExcludedPaths = nil, nil, nil
	a.Commands, a.Network = authority.NoCommands, authority.NoNetwork
	p.Grant.Workspaces, p.Grant.Capabilities, p.Grant.ExcludedPaths = nil, nil, nil
	p.Grant.Commands, p.Grant.Network = authority.NoCommands, authority.NoNetwork
	p.MutationOwnership = authority.NoOwnership
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

func TestEmptyCatalogueLeaseKeepsFixedBudgetAndNoCapabilities(t *testing.T) {
	f := emptyFixture(t)
	f.clock.advance(2 * time.Second) // Original outer TTL elapsed; current consent remains.
	lease, err := f.service.AdmitCatalogue(context.Background())
	if err != nil || lease == nil {
		t.Fatal(err)
	}
	if !lease.Participant().Grant.Policy.NoAccess() || lease.Participant().MutationOwnership != authority.NoOwnership || !lease.Deadline().Equal(f.clock.Now().Add(authority.OrdinaryExecutionLifetime)) {
		t.Fatal("catalogue changed permission or operation budget")
	}
	if err := observe(lease); err != nil {
		t.Fatal(err)
	}
	f.clock.advance(authority.OrdinaryExecutionLifetime)
	refused(t, observe(lease), "AUTHORITY_EXPIRED")
	for _, kind := range []authority.Capability{authority.List, authority.Read, authority.Search, authority.Verify, authority.Write, authority.Shell, authority.NetworkUse} {
		value, err := f.service.Admit(context.Background(), kind)
		if value != nil {
			t.Fatalf("granted %s", kind)
		}
		refused(t, err, "AUTHORITY_CAPABILITY_DENIED")
	}
}

func TestEmptyCatalogueCurrentOwnerChangesWinAfterAdmission(t *testing.T) {
	for _, test := range []struct {
		name, code string
		change     func(fixture)
	}{
		{"participant", "COMPUTER_PARTICIPANT_NOT_FOUND", func(f fixture) { f.access.RevokeParticipant("main") }},
		{"approval", "COMPUTER_APPROVAL_NOT_FOUND", func(f fixture) { f.access.RevokeApproval("computer") }},
		{"turn", "AUTHORITY_TASK_MISMATCH", func(f fixture) { f.tasks.update(func(b *port.TaskBinding) { b.TurnID = "other" }) }},
		{"generation", "AUTHORITY_COMPUTER_MISMATCH", func(f fixture) { a := f.ceiling.Approval.Clone(); a.Generation++; f.access.PutApproval(a) }},
		{"expiry", "AUTHORITY_EXPIRED", func(f fixture) {
			a := f.ceiling.Approval.Clone()
			a.ExpiresAt = f.clock.Now().Add(-time.Millisecond)
			f.access.PutApproval(a)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := emptyFixture(t)
			lease, err := f.service.AdmitCatalogue(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			test.change(f)
			refused(t, observe(lease), test.code)
		})
	}
	f := emptyFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	value, err := f.service.AdmitCatalogue(ctx)
	if value != nil {
		t.Fatal("cancelled observation admitted")
	}
	refused(t, err, "WORKSPACE_REQUEST_CANCELLED")
}
